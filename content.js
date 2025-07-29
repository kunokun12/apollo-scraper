let nextButtonSelector = '';
let isScrapingActive = false;
let currentPage = 1;
let maxPages = 1;
let lastHoveredElement = null;
let scrapedDataCache = new Map();
let scrapeIteration = 1;
const MAX_ITERATIONS = Infinity; // Allow infinite iterations until stopped

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
    
    basicData[`Column_${index + 1}_Text`] = cleanText;
    
    if (links.length > 0) {
      if (index === 5) {
        const socialUrls = [];
        const websiteUrls = [];
        
        links.forEach(a => {
          const href = a.href.toLowerCase();
          if (href.includes('linkedin.com')) {
            basicData['LinkedIn_URL'] = href;
          } else if (
            href.includes('facebook.com') ||
            href.includes('twitter.com') ||
            href.includes('x.com') ||
            href.includes('instagram.com')
          ) {
            socialUrls.push(href);
          } else {
            websiteUrls.push(href);
          }
        });
        
        basicData['Social_URLs'] = socialUrls.join(', ');
        basicData['Website_URL'] = websiteUrls.join(', ');
      } else {
        basicData[`Column_${index + 1}_URL`] = links.map(a => a.href).join(', ');
      }
    } else {
      if (index === 5) {
        basicData['LinkedIn_URL'] = '';
        basicData['Social_URLs'] = '';
        basicData['Website_URL'] = '';
      } else {
        basicData[`Column_${index + 1}_URL`] = '';
      }
    }
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

async function startScraping() {
  console.log(`Starting scraping iteration ${scrapeIteration}...`);
  
  try {
    while (isScrapingActive && currentPage <= maxPages) {
      const rows = document.getElementsByClassName('zp_Uiy0R');
      console.log(`Processing page ${currentPage}, found ${rows.length} rows`);
      
      // Process all rows in current page immediately
      for (const row of rows) {
        if (!isScrapingActive) {
          console.log('Scraping stopped by user');
          return;
        }
        
        const basicData = getRowBasicData(row);
        const rowId = generateRowId(row);
        
        // Check if this row is already in the cache
        if (!scrapedDataCache.has(rowId)) {
          scrapedDataCache.set(rowId, basicData);
          try {
            await chrome.runtime.sendMessage({
              type: 'scrapedData',
              data: basicData
            });
            console.log('Sent new scraped data:', basicData);
          } catch (error) {
            console.log('Error sending data:', error);
          }
        } else {
          console.log('Skipping duplicate row with ID:', rowId);
        }
      }
      
      // Check if we've reached the last page
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
        currentPage = 1;
        
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
              const newRows = document.getElementsByClassName('zp_hWv1I');
              if (newRows.length > 0) {
                clearInterval(checkForRows);
                // Add additional wait time after rows are found
                setTimeout(resolve, 2000);
              }
            }, 200); // Check every 200ms
            
            // Increase timeout to 10 seconds
            setTimeout(() => {
              clearInterval(checkForRows);
              resolve();
            }, 10000);
          });
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
      .map(data => data['Website_URL'])
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