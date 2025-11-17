let nextButtonSelector = '';
let isScrapingActive = false;
let currentPage = 1;
let maxPages = 1;
let lastHoveredElement = null;
let scrapedDataCache = new Map();
let scrapeIteration = 1;
const REALTIME_SERVER_ROOT = 'http://127.0.0.1:5055';
let scrapeMode = 'realtime';
let currentCid = '';
let realtimeErrorNotified = false;
const MAX_ITERATIONS = Infinity; // Allow infinite iterations until stopped
// const MAX_ROWS_LIMIT = 2000; // Maximum number of rows to scrape before stopping - REMOVED
let totalRowsScraped = 0; // Track total rows scraped across all iterations
const REALTIME_REQUEST_TIMEOUT_MS = 6000;
const REALTIME_RETRY_DELAY_MS = 4000;
const REALTIME_MAX_BATCH_SIZE = 250;
const realtimeQueue = [];
let realtimeFlushInFlight = false;
let realtimeRetryHandle = null;
let columnNameOverrides = {};
let securityChallengeObserver = null;
let securityChallengeNotified = false;

// Persist user column overrides so realtime payload matches popup display
chrome.storage?.local?.get(['columnNames'], result => {
  if (result && result.columnNames && typeof result.columnNames === 'object') {
    columnNameOverrides = result.columnNames;
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes?.columnNames) {
    return;
  }
  const overrides = changes.columnNames.newValue;
  if (overrides && typeof overrides === 'object') {
    columnNameOverrides = overrides;
  } else {
    columnNameOverrides = {};
  }
});

const SOCIAL_DOMAINS = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'tiktok.com'];
const APOLLO_PERSON_REGEX = /^https:\/\/app\.apollo\.io\/#\/people\//i;
const APOLLO_COMPANY_REGEX = /^https:\/\/app\.apollo\.io\/#\/organizations\//i;
const LINKEDIN_PROFILE_REGEX = /^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\//i;
const LINKEDIN_COMPANY_REGEX = /^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:company|school|showcase)\//i;

function normalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    let normalized = parsed.href;
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (error) {
    return trimmed;
  }
}

function getHostFromUrl(urlString) {
  try {
    const hostname = new URL(urlString).hostname.toLowerCase();
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  } catch (error) {
    return '';
  }
}

function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isSocialHost(host) {
  if (!host) return false;
  return SOCIAL_DOMAINS.some(domain => hostMatchesDomain(host, domain));
}

function collectUrlsFromElement(element) {
  const urls = [];
  const anchorTags = element.getElementsByTagName('a');
  Array.from(anchorTags).forEach(anchor => {
    if (anchor.href) {
      urls.push(anchor.href.trim());
    }
  });

  const textContent = element.textContent || '';
  const urlRegex = /(https?:\/\/[^\s,]+)/gi;
  let match;
  while ((match = urlRegex.exec(textContent)) !== null) {
    urls.push(match[0].trim());
  }

  return urls;
}

function classifyUrls(urlCandidates) {
    const classification = {
        apolloPeople: [],
        apolloCompany: [],
        linkedinPeople: [],
    linkedinCompany: [],
    social: [],
    websites: [],
    uncategorized: []
  };

  const seen = new Set();

  urlCandidates.forEach(candidate => {
    const trimmed = candidate ? candidate.trim() : '';
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
      return;
    }

    const normalized = normalizeUrl(trimmed);
    if (!normalized) {
      return;
    }

    const normalizedLower = normalized.toLowerCase();
    if (seen.has(normalizedLower)) {
      return;
    }
    seen.add(normalizedLower);

    const rawLower = trimmed.toLowerCase();

    if (APOLLO_PERSON_REGEX.test(rawLower) || APOLLO_PERSON_REGEX.test(normalizedLower)) {
      classification.apolloPeople.push(trimmed);
      return;
    }

    if (APOLLO_COMPANY_REGEX.test(rawLower) || APOLLO_COMPANY_REGEX.test(normalizedLower)) {
      classification.apolloCompany.push(trimmed);
      return;
    }

    if (LINKEDIN_PROFILE_REGEX.test(rawLower)) {
      classification.linkedinPeople.push(trimmed);
      return;
    }

    if (LINKEDIN_COMPANY_REGEX.test(rawLower)) {
      classification.linkedinCompany.push(trimmed);
      return;
    }

    const host = getHostFromUrl(normalized);
    if (isSocialHost(host)) {
      classification.social.push(trimmed);
      return;
    }

    if (host) {
      classification.websites.push(trimmed);
    } else {
      classification.uncategorized.push(trimmed);
    }
  });

    return classification;
}

function getRealtimeColumnName(sourceKey) {
  if (!sourceKey) {
    return sourceKey;
  }
  const override = columnNameOverrides?.[sourceKey];
  if (typeof override === 'string') {
    const trimmed = override.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return sourceKey;
}

function mapRowKeysForRealtime(row) {
  const mapped = {};
  const usedKeys = new Set();
  if (!row || typeof row !== 'object') {
    return mapped;
  }

  Object.entries(row).forEach(([key, value]) => {
    let targetKey = getRealtimeColumnName(key);
    if (usedKeys.has(targetKey)) {
      let suffix = 2;
      let candidate = `${targetKey} (${suffix})`;
      while (usedKeys.has(candidate)) {
        suffix += 1;
        candidate = `${targetKey} (${suffix})`;
      }
      console.warn(`Duplicate realtime column name detected for '${targetKey}'. Renaming to '${candidate}'.`);
      targetKey = candidate;
    }
    usedKeys.add(targetKey);
    mapped[targetKey] = value;
  });

  return mapped;
}

function dispatchRealtimeBatch(cid, rows) {
    if (!cid || !rows || !rows.length) {
        return;
    }
    realtimeQueue.push({ cid, rows });
    if (!realtimeFlushInFlight) {
        queueMicrotask(flushRealtimeQueue);
    }
}

async function flushRealtimeQueue() {
    if (realtimeFlushInFlight || realtimeQueue.length === 0) {
        return;
    }

    const { cid } = realtimeQueue[0];
    const batch = [];
    while (realtimeQueue.length && realtimeQueue[0].cid === cid && batch.length < REALTIME_MAX_BATCH_SIZE) {
        const entry = realtimeQueue.shift();
        batch.push(...entry.rows);
    }

    realtimeFlushInFlight = true;
    try {
        await sendRealtimePayload(cid, batch);
        realtimeErrorNotified = false;
        if (realtimeRetryHandle) {
            clearTimeout(realtimeRetryHandle);
            realtimeRetryHandle = null;
        }
        realtimeFlushInFlight = false;
        if (realtimeQueue.length) {
            queueMicrotask(flushRealtimeQueue);
        }
    } catch (error) {
        realtimeQueue.unshift({ cid, rows: batch });
        realtimeFlushInFlight = false;
        reportRealtimeError(error);
        if (!realtimeRetryHandle) {
            realtimeRetryHandle = setTimeout(() => {
                realtimeRetryHandle = null;
                flushRealtimeQueue();
            }, REALTIME_RETRY_DELAY_MS);
        }
    }
}

async function sendRealtimePayload(cid, rows) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REALTIME_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${REALTIME_SERVER_ROOT}/rows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cid, rows }),
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

function reportRealtimeError(error) {
    console.error('Failed to stream realtime rows:', error);
    if (realtimeErrorNotified) {
        return;
    }
    try {
        chrome.runtime.sendMessage({
            type: 'error',
            message: `Realtime server error: ${error?.message || error}`,
        });
    } catch (messagingError) {
        console.warn('Unable to notify popup about realtime error:', messagingError);
    }
    realtimeErrorNotified = true;
}

// Detect Apollo "Access Denied" block and show warning
function getNodeByXPath(xpath) {
  try {
    return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (e) {
    console.log('XPath evaluation failed:', e);
    return null;
  }
}

function isAccessDeniedPresent() {
  // Per request, check this exact XPath
  const blockXpath = '/html/body/div[18]/div[2]/div/div';
  const node = getNodeByXPath(blockXpath);
  if (!node) return false;
  const text = (node.textContent || '').toLowerCase();
  return text.includes('access denied');
}

function isElementVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (!style) {
    return false;
  }
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }
  const opacity = parseFloat(style.opacity || '1');
  if (!Number.isNaN(opacity) && opacity <= 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isSecurityChallengeActive() {
  // Cloudflare security challenges render elements whose ids begin with "securityChallenge".
  const candidates = Array.from(document.querySelectorAll('[id]')).filter(el => {
    const id = typeof el.id === 'string' ? el.id.trim() : '';
    if (!id) {
      return false;
    }
    return /^securitychallenge(?:[_-]|$)/i.test(id);
  });
  if (!candidates.length) {
    return false;
  }
  return candidates.some(isElementVisible);
}

function stopSecurityChallengeObserver() {
  if (securityChallengeObserver) {
    securityChallengeObserver.disconnect();
    securityChallengeObserver = null;
  }
}

function startSecurityChallengeObserver() {
  // Monitor DOM mutations so we can stop scraping as soon as a challenge appears mid-run.
  if (securityChallengeObserver) {
    if (isSecurityChallengeActive()) {
      handleSecurityChallengeDetected();
    }
    return;
  }

  if (typeof MutationObserver !== 'function') {
    if (isSecurityChallengeActive()) {
      handleSecurityChallengeDetected();
    }
    return;
  }

  const target = document.body || document.documentElement;
  if (!target) {
    return;
  }

  securityChallengeObserver = new MutationObserver(() => {
    if (!isScrapingActive) {
      return;
    }
    if (isSecurityChallengeActive()) {
      handleSecurityChallengeDetected();
    }
  });

  securityChallengeObserver.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['id', 'class', 'style', 'hidden']
  });

  if (isSecurityChallengeActive()) {
    handleSecurityChallengeDetected();
  }
}

function handleSecurityChallengeDetected() {
  // Centralized exit path when Apollo shows a security challenge.
  if (securityChallengeNotified) {
    if (isScrapingActive) {
      isScrapingActive = false;
      cleanupMemory({ resetSecurityChallengeState: false });
    }
    return;
  }

  const msg = 'Security challenge detected on page. Scraping has been stopped until you resolve it manually.';
  console.warn(msg);

  securityChallengeNotified = true;
  showScrapingStoppedWarning(msg);
  try {
    const result = chrome.runtime.sendMessage({ type: 'error', message: msg });
    if (result && typeof result.catch === 'function') {
      result.catch(error => {
        console.warn('Unable to notify popup about security challenge:', error);
      });
    }
  } catch (error) {
    console.warn('Unable to notify popup about security challenge:', error);
  }

  if (isScrapingActive) {
    isScrapingActive = false;
  }

  cleanupMemory({ resetSecurityChallengeState: false });
}

function showScrapingStoppedWarning(message) {
  const existing = document.getElementById('ids-scrape-warning');
  if (existing) return; // do not duplicate
  
  const overlay = document.createElement('div');
  overlay.id = 'ids-scrape-warning';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.style.zIndex = '2147483647';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  const panel = document.createElement('div');
  panel.style.maxWidth = '680px';
  panel.style.width = '90%';
  panel.style.background = '#fff';
  panel.style.border = '2px solid #f5c2c7';
  panel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
  panel.style.borderRadius = '10px';
  panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
  panel.style.color = '#1f2937';

  panel.innerHTML = `
    <div style="display:flex; gap:16px; padding:18px 20px; align-items:flex-start;">
      <div style="flex:0 0 auto; width:32px; height:32px; border-radius:50%; background:#f8d7da; color:#842029; display:flex; align-items:center; justify-content:center; font-weight:700;">!</div>
      <div style="flex:1 1 auto;">
        <div style="font-size:18px; font-weight:700; margin-bottom:6px; color:#842029;">Scraping Stopped</div>
        <div style="font-size:14px; line-height:1.4; white-space:pre-wrap;">${message}</div>
      </div>
    </div>
    <div style="display:flex; justify-content:flex-end; padding:0 20px 16px 20px; gap:10px;">
      <button id="ids-scrape-warning-close" style="appearance:none; border:1px solid #d1d5db; background:#fff; color:#111827; border-radius:6px; padding:8px 14px; cursor:pointer;">Close</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.documentElement.appendChild(overlay);

  const closeBtn = overlay.querySelector('#ids-scrape-warning-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => overlay.remove());
  }
}

// Initialize selectors from localStorage if available
try {
  const savedNextSelector = localStorage.getItem('nextButtonSelector');
  if (savedNextSelector) {
    nextButtonSelector = savedNextSelector;
  }
} catch (error) {
  console.log('Error restoring selectors:', error);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'selectNextButton':
      enableElementSelection('next');
      break;
    case 'startScraping':
      // Check for exclude text area using class name
      const excludeTextAreas = document.getElementsByClassName('zp-text-area zp_HnzhA zp_MLOFa zp_CALvp');
      const excludeTextArea = excludeTextAreas[1]; // Get the second instance
      
      if (!excludeTextArea) {
        chrome.runtime.sendMessage({
          type: 'error',
          message: 'Please open the exclude text area first before starting the scraper'
        });
        return;
      }

      securityChallengeNotified = false;
      stopSecurityChallengeObserver();

      if (isSecurityChallengeActive()) {
        handleSecurityChallengeDetected();
        return;
      }

      // Stop immediately if Apollo Access Denied block is present
      if (isAccessDeniedPresent()) {
        const msg = 'Access Denied detected on page. Scraping has been stopped to prevent further actions. Please resolve the block before retrying.';
        isScrapingActive = false;
        showScrapingStoppedWarning(msg);
        try { chrome.runtime.sendMessage({ type: 'error', message: msg }); } catch (e) {}
        cleanupMemory();
        return;
      }
      
      // Reset variables for new scraping session
      currentPage = 1;
      scrapeIteration = 1;
      isScrapingActive = true;
      maxPages = parseInt(message.maxPages);
      scrapeMode = message.mode === 'realtime' ? 'realtime' : 'save';
      currentCid = typeof message.cid === 'string' ? message.cid.trim() : '';
      scrapedDataCache.clear();
      realtimeErrorNotified = false;
      totalRowsScraped = 0; // Reset total row count for new session

      if (scrapeMode === 'realtime' && !currentCid) {
        const warning = 'Realtime mode requires a CID before scraping can begin.';
        console.warn(warning);
        chrome.runtime.sendMessage({ type: 'error', message: warning }).catch(() => {});
        isScrapingActive = false;
        cleanupMemory();
        return true;
      }

      console.log(`Starting new scraping session (mode=${scrapeMode}, cid=${currentCid || 'n/a'})...`);
      startScraping();
      break;
    case 'stopScraping':
      console.log('Stop command received');
      isScrapingActive = false;
      cleanupMemory();
      break;
  }
  return true;
});

function enableElementSelection(mode) {
  console.log('Enabling element selection for mode:', mode);
  
  const existingStyle = document.getElementById('highlight-style');
  if (existingStyle) {
    existingStyle.remove();
  }
  
  const style = document.createElement('style');
  style.id = 'highlight-style';
  style.textContent = `
    .ids-hover-highlight {
      outline: 2px solid #ff0000 !important;
      outline-offset: -2px !important;
      background-color: rgba(255, 0, 0, 0.1) !important;
      cursor: pointer !important;
    }
  `;
  document.head.appendChild(style);
  
  document.removeEventListener('mouseover', mouseOverHandler);
  document.removeEventListener('mouseout', mouseOutHandler);
  document.removeEventListener('click', clickHandler, true);
  
  document.addEventListener('mouseover', mouseOverHandler);
  document.addEventListener('mouseout', mouseOutHandler);
  document.addEventListener('click', (e) => clickHandler(e, mode), true);
  
  console.log('Element selection enabled with mode:', mode);
}

function mouseOverHandler(e) {
  e.stopPropagation();
  if (lastHoveredElement) {
    lastHoveredElement.classList.remove('ids-hover-highlight');
  }
  lastHoveredElement = e.target;
  e.target.classList.add('ids-hover-highlight');
}

function mouseOutHandler(e) {
  e.stopPropagation();
  e.target.classList.remove('ids-hover-highlight');
}

function clickHandler(e, mode) {
  e.preventDefault();
  e.stopPropagation();
  
  console.log('Click handler called with mode:', mode);
  
  if (mode === 'next') {
    // Store the button selector with aria-label="Next"
    nextButtonSelector = 'button[aria-label="Next"]';
    console.log('Stored next button selector:', nextButtonSelector);
  }
  
  const style = document.getElementById('highlight-style');
  if (style) {
    style.remove();
  }
  
  document.removeEventListener('mouseover', mouseOverHandler);
  document.removeEventListener('mouseout', mouseOutHandler);
  document.removeEventListener('click', clickHandler, true);
  
  if (lastHoveredElement) {
    lastHoveredElement.classList.remove('ids-hover-highlight');
  }
  
  localStorage.setItem('nextButtonSelector', nextButtonSelector);
  
  alert('Next button has been set!');
  chrome.runtime.sendMessage({
    type: 'nextButtonSelected',
    selector: nextButtonSelector
  });
}

function getRowBasicData(row) {
  const basicData = {};
  const ktrQpElements = row.getElementsByClassName('zp_egyXf');
  
  Array.from(ktrQpElements).forEach((element, index) => {
    const cleanText = element.textContent
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[\n\r\t]/g, '');
    
    const urlCandidates = collectUrlsFromElement(element);

    if (urlCandidates.length) {
      console.log(`[DEBUG] Found ${urlCandidates.length} URL candidates in column ${index + 1}`);
      const columnClassification = classifyUrls(urlCandidates);
      console.log('[DEBUG] Column classification:', columnClassification);

      if (!basicData['Apollo Link'] && columnClassification.apolloPeople.length) {
        basicData['Apollo Link'] = columnClassification.apolloPeople[0];
      }

      if (!basicData['LinkedIn URL'] && columnClassification.linkedinPeople.length) {
        basicData['LinkedIn URL'] = columnClassification.linkedinPeople[0];
      }

      if (!basicData['LinkedIn Company'] && columnClassification.linkedinCompany.length) {
        basicData['LinkedIn Company'] = columnClassification.linkedinCompany[0];
      }

      if (!basicData['Apollo_Company_URL'] && columnClassification.apolloCompany.length) {
        basicData['Apollo_Company_URL'] = columnClassification.apolloCompany[0];
      }

      if (columnClassification.social.length) {
        basicData['Social_URLs'] = columnClassification.social.join(', ');
      } else if (!Object.prototype.hasOwnProperty.call(basicData, 'Social_URLs')) {
        basicData['Social_URLs'] = '';
      }

      if (columnClassification.websites.length) {
        basicData['Website'] = columnClassification.websites.join(', ');
      } else if (!Object.prototype.hasOwnProperty.call(basicData, 'Website')) {
        basicData['Website'] = '';
      }

      const fallbackCandidates = [
        columnClassification.apolloPeople[0],
        columnClassification.linkedinPeople[0],
        columnClassification.linkedinCompany[0],
        columnClassification.apolloCompany[0],
        columnClassification.websites[0],
        columnClassification.social[0],
        columnClassification.uncategorized[0]
      ];
      const fallbackUrl = fallbackCandidates.find(Boolean);

      if (fallbackUrl && !basicData[`Column_${index + 1}_URL`]) {
        basicData[`Column_${index + 1}_URL`] = fallbackUrl;
      } else if (!basicData[`Column_${index + 1}_URL`]) {
        basicData[`Column_${index + 1}_URL`] = '';
      }
    } else {
      console.log(`[DEBUG] No links found in column ${index + 1}`);
      if (!basicData[`Column_${index + 1}_URL`]) {
        basicData[`Column_${index + 1}_URL`] = '';
      }
    }
    
    basicData[`Column_${index + 1}_Text`] = cleanText;
  });
  
  return basicData;
}

function generateRowId(row) {
  try {
    const texts = Array.from(row.getElementsByClassName('zp_egyXf'))
      .map(el => el.textContent.trim())
      .join('|');
    
    return btoa(encodeURIComponent(texts));
  } catch (error) {
    console.error('Error generating row ID:', error);
    return `row_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Utility wait
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wait for the whole table to stabilize (texts stop changing)
async function waitForRowsToStabilize(maxWaitMs = 6000, samples = 2, intervalMs = 150) {
  const start = Date.now();
  let lastSignature = '';
  let stableSamples = 0;
  while (Date.now() - start < maxWaitMs) {
    const rows = Array.from(document.getElementsByClassName('zp_Uiy0R'));
    const signature = rows
      .map(r => Array.from(r.getElementsByClassName('zp_egyXf'))
        .map(c => c.textContent.trim())
        .join('|'))
      .join('||');
    if (signature && signature === lastSignature) {
      stableSamples += 1;
      if (stableSamples >= samples) {
        // console.log('[WAIT] Rows stabilized');
        return true;
      }
    } else {
      stableSamples = 0;
      lastSignature = signature;
    }
    await delay(intervalMs);
  }
  // console.log('[WAIT] Rows stabilization timed out');
  return false;
}

// Wait for a specific row to finish rendering its content/links
async function waitForRowReady(row, maxWaitMs = 5000) {
  const start = Date.now();
  let last = '';
  let stable = 0;
  while (Date.now() - start < maxWaitMs) {
    const cols = Array.from(row.getElementsByClassName('zp_egyXf'));
    const text = cols.map(el => el.textContent.trim()).join('|');
    const linksPresent = row.querySelectorAll('.zp_egyXf a').length > 0;
    if (text && text === last) {
      stable += 1;
      if (stable >= 2) return true;
    } else {
      stable = 0;
      last = text;
    }
    if (linksPresent && stable >= 1) return true;
    await delay(200);
  }
  return false;
}

async function startScraping() {
  console.log(`Starting scraping iteration ${scrapeIteration}...`);
  startSecurityChallengeObserver();
  
  try {
    while (isScrapingActive && currentPage <= maxPages) {
      // Halt if Apollo presents an Access Denied modal/content
      if (isAccessDeniedPresent()) {
        const msg = 'Access Denied detected on page. Scraping has been stopped to prevent further actions. Please resolve the block before retrying.';
        console.log(msg);
        isScrapingActive = false;
        showScrapingStoppedWarning(msg);
        try { await chrome.runtime.sendMessage({ type: 'error', message: msg }); } catch (e) {}
        return;
      }

      if (isSecurityChallengeActive()) {
        handleSecurityChallengeDetected();
        return;
      }
      // Read current page from DOM using provided XPath and log it
      const xpath = '//*[@id="main-container-column-2"]/div/div/div/div[3]/div[2]/div[2]/div[2]/div/div[2]/div[1]/div[1]/span';
      let domPage = null;
      try {
        const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        const text = node ? node.textContent.trim() : '';
        const parsed = text ? parseInt(text.replace(/[^0-9]/g, ''), 10) : NaN;
        if (!isNaN(parsed)) {
          domPage = parsed;
          currentPage = domPage; // sync with DOM
        }
        console.log(`[PAGE] XPath text='${text}', parsed=${isNaN(parsed) ? 'NaN' : parsed}, currentPage=${currentPage}, maxPages=${maxPages}`);
      } catch (e) {
        console.log('[PAGE] Failed to read current page from XPath:', e);
      }

      const rows = document.getElementsByClassName('zp_Uiy0R');
      console.log(`Processing page ${curjrentPage}, found ${rows.length} rows. Total scraped so far: ${totalRowsScraped}`);
      // Wait for rows to finish rendering to avoid empty columns (lighter, faster)
      const pageStable = await waitForRowsToStabilize(6000, 2, 150);
      
      // Process all rows in current page immediately
      const pageBatch = [];
      const realtimeBatch = [];
      for (const row of rows) {
        if (!isScrapingActive) {
          console.log('Scraping stopped by user');
          return;
        }

        // Row limit check removed - scraping will continue without limit
        /* 
        // Check if we've reached the maximum row limit
        if (totalRowsScraped >= MAX_ROWS_LIMIT) {
          console.log(`Reached maximum row limit of ${MAX_ROWS_LIMIT}. Stopping scraping.`);
          const warningMsg = `Scraping has been stopped after reaching the maximum limit of ${MAX_ROWS_LIMIT} rows. This helps prevent excessive data collection and potential rate limiting.`;
          showScrapingStoppedWarning(warningMsg);
          try {
            chrome.runtime.sendMessage({ type: 'error', message: warningMsg });
          } catch (e) {
            console.log('Failed to notify popup about row limit:', e);
          }
          isScrapingActive = false;
          return;
        }
        */

        // Ensure row content is ready only if page was not fully stable
        if (!pageStable) {
          await waitForRowReady(row, 1200);
        }
        
        const basicData = getRowBasicData(row);
        const rowId = generateRowId(row);
        
        // Check if this row is already in the cache
        if (!scrapedDataCache.has(rowId)) {
          scrapedDataCache.set(rowId, basicData);
          pageBatch.push(basicData);
          totalRowsScraped++; // Increment total row counter
          const realtimeRow = {
            __row_id: rowId,
            __cid: currentCid,
            ...mapRowKeysForRealtime(basicData)
          };
          realtimeBatch.push(realtimeRow);
          console.log(`Total rows scraped: ${totalRowsScraped}`);
        } else {
          console.log('Skipping duplicate row with ID:', rowId);
        }
      }
      // Send in one batch to reduce message overhead
      if (pageBatch.length) {
        try {
          await chrome.runtime.sendMessage({
            type: 'scrapedDataBatch',
            data: pageBatch
          });
          console.log(`Sent batch of ${pageBatch.length} rows`);
        } catch (error) {
          console.log('Error sending batch data:', error);
        }
      }
      
      if (scrapeMode === 'realtime' && realtimeBatch.length) {
        dispatchRealtimeBatch(currentCid, realtimeBatch);
      }
      
      // Check if we've reached the last page (based on DOM page monitoring)
      if (currentPage >= maxPages) {
        console.log('Reached last page, processing excludes...');
        const excludeSuccess = await processExcludes();
        
        if (!excludeSuccess) {
          console.log('Exclude process failed, stopping scraping');
          isScrapingActive = false;
          break;
        }
        
        // Start new iteration only if exclude process was successful
        console.log(`Starting iteration ${scrapeIteration + 1}...`);
        scrapeIteration++;
        currentPage = 1; // reset our counter; DOM will resync on next loop
        
        // Check if scraping was stopped during exclude process
        if (!isScrapingActive) {
          console.log('Scraping stopped by user during exclude process');
          break;
        }
        continue;
      }
      
      // Only move to next page if we're not on the last page and scraping is still active
      if (currentPage < maxPages && isScrapingActive) {
        console.log('Moving to next page...');
        console.log('Current next button selector:', 'button[aria-label="Next"]');
        
        // Wait for next button to appear
        let nextButton = null;
        await new Promise((resolve) => {
          const checkForButton = setInterval(() => {
            nextButton = document.querySelector('button[aria-label="Next"]');
            if (nextButton) {
              clearInterval(checkForButton);
              setTimeout(resolve, 1000); // Wait an extra second after finding button
            }
          }, 200); // Check every 200ms
          
          // Timeout after 10 seconds
          setTimeout(() => {
            clearInterval(checkForButton);
            resolve();
          }, 10000);
        });
        
        if (nextButton) {
          console.log('Found next button, clicking...');
          nextButton.click();
          currentPage++;
          
          // Wait for new page to load by checking for rows with increased timeout
          await new Promise((resolve) => {
            const checkForRows = setInterval(() => {
              const newRows = document.getElementsByClassName('zp_Uiy0R');
              if (newRows.length > 0) {
                clearInterval(checkForRows);
                resolve();
              }
            }, 200); // Check every 200ms
            
            // Increase timeout to 10 seconds
            setTimeout(() => {
              clearInterval(checkForRows);
              resolve();
            }, 10000);
          });
          // After rows are present, brief stabilization wait
          await waitForRowsToStabilize(5000, 2, 150);
        } else {
          console.log('Next button not found after waiting, stopping scraping');
          isScrapingActive = false;
          break;
        }
      }
    }
  } catch (error) {
    console.error('Error during scraping:', error);
    isScrapingActive = false;
  } finally {
    if (!isScrapingActive) {
      cleanupMemory();
      console.log('Scraping stopped, memory cleaned');
    }
  }
}

async function processExcludes() {
  console.log('Processing excludes...');
  
  try {
    // Get all website URLs from scraped data
    const allWebsites = Array.from(scrapedDataCache.values())
      .map(data => data['Website'])
      .filter(Boolean)
      .flatMap(urls => urls.split(', '))
      .filter(url => url.trim() !== '');
    
    // Remove duplicates only
    const uniqueWebsites = [...new Set(allWebsites)];
    
    console.log(`Processing ${uniqueWebsites.length} unique websites for exclusion`);
    
    // Find exclude text area using class name
    const excludeTextAreas = document.getElementsByClassName('zp-text-area zp_HnzhA zp_MLOFa zp_CALvp');
    const excludeTextArea = excludeTextAreas[1]; // Get the second instance
    
    if (excludeTextArea) {
      console.log('Found exclude text area, appending websites...');
      
      // Get existing content
      const existingContent = excludeTextArea.value;
      
      // Prepare new content
      const websitesText = uniqueWebsites.join('\n');
      
      // Combine existing and new content
      const newContent = existingContent 
        ? existingContent.trim() + '\n' + websitesText 
        : websitesText;
      
      // Set the combined content
      excludeTextArea.value = newContent;
      
      // Move cursor to end
      excludeTextArea.selectionStart = excludeTextArea.selectionEnd = excludeTextArea.value.length;
      
      // Trigger input events
      excludeTextArea.dispatchEvent(new Event('input', { bubbles: true }));
      excludeTextArea.dispatchEvent(new Event('change', { bubbles: true }));
      
      // Find and click save button
      const selector = '#main-container-column-2 > div > div > div.zp_ajhD0 > div.zp_p234g.people-finder-shell-container > div.zp_pxYrj > div.zp_FWOdG > div > div > div.zp_pDn5b.zp_T8qTB.zp_w3MDk > div.zp-accordion.zp_YkfVU.zp_UeG9f.zp_p8DhX > div.zp-accordion-body.zp_vJehh.zp_kTkJc > div.zp_S0sSP.zp_tIx8j.zp_th45Y.accordion-child-bleed > div.zp_G6R2_.subaccordion-body > div > div:nth-child(3) > div:nth-child(1) > div:nth-child(2) > button';
      const element = document.querySelector(selector);
      
      if (element) {
        console.log('Found save button, clicking...');
        element.click();
        
        // Increase wait time after save to ensure changes are fully processed
        console.log('Waiting for save to complete...');
        await new Promise(resolve => setTimeout(resolve, 10000)); // Increased from 5000 to 10000
        
        // Clean up memory after save
        cleanupMemory({ preserveSessionState: true });
        
        console.log('Save completed and memory cleaned, proceeding to next iteration');
        return true;
      } else {
        console.error('Save button not found with provided selector');
        return false;
      }
    } else {
      console.error('Exclude text area not found');
      return false;
    }
  } catch (error) {
    console.error('Error during exclude process:', error);
    return false;
  }
}

// Add cleanup function
function cleanupMemory(options = {}) {
  const {
    preserveSessionState = false,
    resetSecurityChallengeState = true
  } = options;
  console.log('Starting memory cleanup...');
  
  // Clear the data cache
  scrapedDataCache.clear();
  realtimeQueue.length = 0;
  realtimeFlushInFlight = false;
  if (realtimeRetryHandle) {
    clearTimeout(realtimeRetryHandle);
    realtimeRetryHandle = null;
  }
  
  // Remove from localStorage
  try {
    localStorage.removeItem('scrapedDataCache');
  } catch (error) {
    console.log('Error clearing localStorage:', error);
  }
  
  // Clear any global references
  lastHoveredElement = null;
  if (!preserveSessionState) {
    scrapeMode = 'realtime';
    currentCid = '';
    totalRowsScraped = 0; // Reset row count when not preserving session state
  }
  realtimeErrorNotified = false;
  stopSecurityChallengeObserver();
  if (resetSecurityChallengeState) {
    securityChallengeNotified = false;
  }
  
  // Force garbage collection if possible
  if (window.gc) {
    window.gc();
  }
  
  // Clear event listeners that might have been left
  document.removeEventListener('mouseover', mouseOverHandler);
  document.removeEventListener('mouseout', mouseOutHandler);
  document.removeEventListener('click', clickHandler, true);
  
  // Remove any leftover styles
  const style = document.getElementById('highlight-style');
  if (style) {
    style.remove();
  }
  
  console.log('Memory cleanup completed');

  if (!isScrapingActive) {
    try {
      chrome.runtime.sendMessage({ type: 'scrapeStopped' });
    } catch (error) {
      console.log('Failed to notify popup about scrape stop:', error);
    }
  }
}

// Add cleanup on extension unload
window.addEventListener('unload', () => {
  cleanupMemory();
});

// Initialize cache from localStorage on script load
try {
  const cachedData = localStorage.getItem('scrapedDataCache');
  if (cachedData) {
    const cacheObject = JSON.parse(cachedData);
    scrapedDataCache = new Map(Object.entries(cacheObject));
  }
} catch (error) {
  console.log('Error initializing cache:', error);
}
