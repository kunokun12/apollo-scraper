let nextButtonSelector = '';
let isScrapingActive = false;
let currentPage = 1;
let maxPages = 1;
let lastHoveredElement = null;
let scrapedDataCache = new Map();
let scrapeIteration = 1;
const MAX_ITERATIONS = Infinity; // Allow infinite iterations until stopped

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
      scrapedDataCache.clear();
      
      console.log('Starting new scraping session...');
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
    
    const links = Array.from(element.getElementsByTagName('a'));
    
    if (links.length > 0) {
      console.log(`[DEBUG] Found ${links.length} links in column ${index + 1}`);
      
      // Apollo Link detection works even if column has only one link
      let apolloLink = basicData['Apollo Link'] || '';
      let foundApolloLink = false;
      let linkedInProfileUrl = basicData['LinkedIn URL'] || '';
      links.forEach(link => {
        const url = link.href.trim();
        // Apollo Link
        if (/^https:\/\/app\.apollo\.io\/#\/people\//.test(url)) {
          console.log(`[DEBUG] Identified as Apollo Link (single or multi): ${url}`);
          if (!apolloLink) {
            basicData['Apollo Link'] = url;
            foundApolloLink = true;
          }
        }
        // LinkedIn Profile URL
        if (/^https?:\/\/www\.linkedin\.com\/in\//.test(url)) {
          console.log(`[DEBUG] Identified as LinkedIn Profile URL (single or multi): ${url}`);
          if (!linkedInProfileUrl) {
            basicData['LinkedIn URL'] = url;
            linkedInProfileUrl = url;
          }
        }
      });
      if ((foundApolloLink || linkedInProfileUrl) && links.length === 1) {
        // If we found Apollo Link or LinkedIn Profile URL and there's only one link, skip further processing for this column
        basicData[`Column_${index + 1}_Text`] = cleanText;
        return;
      }
      
      // Process URLs if we find multiple links in a column
      if (links.length >= 2) {
        console.log(`[DEBUG] Processing ${links.length} URLs in column ${index + 1}`);
        // Initialize with existing values or empty arrays/strings
        const socialUrls = basicData['Social_URLs'] ? basicData['Social_URLs'].split(', ').filter(Boolean) : [];
        const websiteUrls = basicData['Website'] ? basicData['Website'].split(', ').filter(Boolean) : [];
        const linkedInUrl = basicData['LinkedIn Company'] || '';
        const apolloCompanyUrl = basicData['Apollo_Company_URL'] || '';
        // Apollo Link and LinkedIn URL are already handled above
        
        // Get all URLs from the text content first (since they might be in a single string)
        const textContent = element.textContent.trim();
        console.log('[DEBUG] Text content:', textContent);
        
        let allUrls = [];
        
        // First try to get URLs from links
        allUrls = links.map(link => link.href.trim());
        console.log(`[DEBUG] Found ${allUrls.length} URLs in <a> tags:`, allUrls);
        
        // If no links found in <a> tags, try extracting from text
        if (allUrls.length === 0) {
          console.log('[DEBUG] No URLs found in <a> tags, checking text content');
          const urlRegex = /(https?:\/\/[^\s,]+)/g;
          let match;
          while ((match = urlRegex.exec(textContent)) !== null) {
            const url = match[0].trim();
            console.log(`[DEBUG] Found URL in text: ${url}`);
            allUrls.push(url);
          }
        }
        
        console.log(`[DEBUG] Total URLs to process: ${allUrls.length}`, allUrls);
        
        // Process each URL
        allUrls.forEach((url, i) => {
          if (!url) {
            console.log(`[DEBUG] URL at index ${i} is empty, skipping`);
            return;
          }
          
          console.log(`[DEBUG] Processing URL ${i + 1}/${allUrls.length}: ${url}`);
          
          // Convert to lowercase for case-insensitive comparison
          const lowerUrl = url.toLowerCase();
          
          // Apollo Company URL
          if (/^https:\/\/app\.apollo\.io\/#\/organizations\//.test(url)) {
            console.log(`[DEBUG] Identified as Apollo Company URL: ${url}`);
            if (!apolloCompanyUrl) {
              basicData['Apollo_Company_URL'] = url;
            }
          } 
          // LinkedIn Profile URL
          else if (/^https?:\/\/www\.linkedin\.com\/in\//.test(url)) {
            console.log(`[DEBUG] Identified as LinkedIn Profile URL: ${url}`);
            if (!basicData['LinkedIn URL']) {
              basicData['LinkedIn URL'] = url;
            }
          }
          // LinkedIn (company/page)
          else if (lowerUrl.includes('linkedin.com') && !linkedInUrl) {
            console.log(`[DEBUG] Identified as LinkedIn Company: ${url}`);
            basicData['LinkedIn Company'] = url;
          } 
          // Social Media
          else if (
            (lowerUrl.includes('facebook.com') ||
             lowerUrl.includes('twitter.com') ||
             lowerUrl.includes('x.com') ||
             lowerUrl.includes('instagram.com')) &&
            !socialUrls.includes(url)
          ) {
            console.log(`[DEBUG] Identified as social URL: ${url}`);
            socialUrls.push(url);
          } 
          // Website - only add if it's not a social media URL and we haven't found any social media URLs yet
          else if (url.startsWith('http') && 
                  !socialUrls.length && 
                  !lowerUrl.includes('facebook.com') &&
                  !lowerUrl.includes('twitter.com') &&
                  !lowerUrl.includes('x.com') &&
                  !lowerUrl.includes('instagram.com') &&
                  !websiteUrls.includes(url)) {
            console.log(`[DEBUG] Identified as website URL: ${url}`);
            websiteUrls.push(url);
          } else {
            console.log(`[DEBUG] URL does not match any category or is a duplicate: ${url}`);
          }
        });
        
        // Update the arrays in basicData
        if (socialUrls.length > 0) {
          basicData['Social_URLs'] = socialUrls.join(', ');
        } else {
          basicData['Social_URLs'] = ''; // Explicitly set to empty string if no social URLs found
        }
        if (websiteUrls.length > 0) { 
          basicData['Website'] = websiteUrls.join(', ');
        } else {
          basicData['Website'] = ''; // Also ensure Website is an empty string if no website URLs found
        }
        
        console.log('[DEBUG] Final URL Categorization:', {
          'Apollo_Company_URL': basicData['Apollo_Company_URL'] || '',
          'Apollo Link': basicData['Apollo Link'] || '',
          'LinkedIn URL': basicData['LinkedIn URL'] || '',
          'LinkedIn Company': basicData['LinkedIn Company'] || '',
          'Social_URLs': basicData['Social_URLs'] || '',
          'Website': basicData['Website'] || ''
        });
        
      } else if (!(foundApolloLink || linkedInProfileUrl)) {
        // For columns with a single link, just add it as is if the field doesn't exist
        const url = links[0].href.trim();
        console.log(`[DEBUG] Single link found in column ${index + 1}:`, url);
        if (!basicData[`Column_${index + 1}_URL`]) {
          basicData[`Column_${index + 1}_URL`] = url;
        }
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
      console.log(`Processing page ${currentPage}, found ${rows.length} rows`);
      // Wait for rows to finish rendering to avoid empty columns (lighter, faster)
      const pageStable = await waitForRowsToStabilize(6000, 2, 150);
      
      // Process all rows in current page immediately
      const pageBatch = [];
      for (const row of rows) {
        if (!isScrapingActive) {
          console.log('Scraping stopped by user');
          return;
        }
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
        cleanupMemory();
        
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
function cleanupMemory() {
  console.log('Starting memory cleanup...');
  
  // Clear the data cache
  scrapedDataCache.clear();
  
  // Remove from localStorage
  try {
    localStorage.removeItem('scrapedDataCache');
  } catch (error) {
    console.log('Error clearing localStorage:', error);
  }
  
  // Clear any global references
  lastHoveredElement = null;
  
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
