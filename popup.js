let isSelecting = false;
let isScrapingActive = false;

document.getElementById('selectNextButton').addEventListener('click', async () => {
  isSelecting = true;
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {action: "selectNextButton"});
  });
});

document.getElementById('startScraping').addEventListener('click', async () => {
  const maxPages = document.getElementById('maxPages').value;
  isScrapingActive = true;
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {
      action: "startScraping",
      maxPages: maxPages
    });
  });
});

document.getElementById('stopScraping').addEventListener('click', () => {
  isScrapingActive = false;
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {action: "stopScraping"});
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scrapedData') {
    updateTable(message.data);
  }
});

function updateTable(data) {
  const tbody = document.querySelector('#dataTable tbody');
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${data.rowData}</td>
    <td>${data.links.join('<br>')}</td>
  `;
  tbody.appendChild(row);
} 