// Listen for extension icon click
chrome.action.onClicked.addListener((tab) => {
  // Open new window with extension UI
  chrome.windows.create({
    url: 'index.html',
    type: 'popup',
    width: 800,
    height: 600
  });
});

// Store scraped data if popup is closed
let storedData = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scrapedData') {
    // Store the data
    storedData.push(message.data);
    
    // Try to forward to popup if it's open
    try {
      chrome.runtime.sendMessage(message);
    } catch (error) {
      console.log('Popup not available, data stored in background');
    }
  }
});

// When popup requests stored data
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getStoredData') {
    sendResponse({ data: storedData });
    storedData = []; // Clear stored data after sending
  }
}); 