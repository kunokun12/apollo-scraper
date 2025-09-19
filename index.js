document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const maxPagesInput = document.getElementById('maxPages');
    const saveCSVBtn = document.getElementById('saveCSVBtn');
    const saveLocationInput = document.getElementById('saveLocation');
    let columnNames = {};
    const processedRows = new Set();
    
    // Load saved column names
    chrome.storage.local.get(['columnNames'], function(result) {
        if (result.columnNames) {
            columnNames = result.columnNames;
        }
    });

    function createHeaderCell(key, value) {
        const th = document.createElement('th');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'column-name';
        nameSpan.textContent = columnNames[key] || key;
        
        const actionsSpan = document.createElement('span');
        actionsSpan.className = 'column-actions';
        
        const editBtn = document.createElement('span');
        editBtn.className = 'edit-column';
        editBtn.textContent = 'Edit';
        editBtn.onclick = function() {
            const input = document.createElement('input');
            input.className = 'column-input';
            input.value = nameSpan.textContent;
            
            input.onblur = function() {
                columnNames[key] = input.value;
                nameSpan.textContent = input.value;
                th.replaceChild(nameSpan, input);
                th.appendChild(actionsSpan);
                
                // Save to storage
                chrome.storage.local.set({ columnNames: columnNames });
            };
            
            input.onkeydown = function(e) {
                if (e.key === 'Enter') {
                    input.blur();
                }
            };
            
            th.replaceChild(input, nameSpan);
            th.removeChild(actionsSpan);
            input.focus();
        };
        
        const deleteBtn = document.createElement('span');
        deleteBtn.className = 'delete-column';
        deleteBtn.textContent = 'Close';
        deleteBtn.title = 'Delete column';
        deleteBtn.onclick = function() {
            if (confirm(`Are you sure you want to delete the column "${nameSpan.textContent}"?`)) {
                const table = document.getElementById('resultsTable');
                const columnIndex = Array.from(th.parentElement.children).indexOf(th);
                
                // Remove header
                th.remove();
                
                // Remove column from all rows
                const rows = table.getElementsByTagName('tr');
                Array.from(rows).forEach(row => {
                    const cells = row.getElementsByTagName('td');
                    if (cells[columnIndex]) {
                        cells[columnIndex].remove();
                    }
                });
                
                // Remove from columnNames
                delete columnNames[key];
                chrome.storage.local.set({ columnNames: columnNames });
            }
        };
        
        actionsSpan.appendChild(editBtn);
        actionsSpan.appendChild(deleteBtn);
        
        th.appendChild(nameSpan);
        th.appendChild(actionsSpan);
        return th;
    }

    function updateTable(data) {
        const headerRow = document.getElementById('headerRow');
        const resultsBody = document.getElementById('resultsBody');
        
        // Create a unique identifier for the row based on its content
        const rowIdentifier = Object.values(data).join('|');
        
        // Skip if we've already processed this row
        if (processedRows.has(rowIdentifier)) {
            console.log('Skipping duplicate row:', data);
            return;
        }
        
        // Add to processed rows set
        processedRows.add(rowIdentifier);
        
        // Clear existing headers if this is the first data
        if (headerRow.children.length === 0) {
            // Create headers based on the data structure
            for (const key in data) {
                headerRow.appendChild(createHeaderCell(key, data[key]));
            }
        }
        
        // Add data row
        const row = document.createElement('tr');
        for (const key in data) {
            const td = document.createElement('td');
            td.textContent = typeof data[key] === 'object' ? 
                JSON.stringify(data[key]) : data[key];
            row.appendChild(td);
        }
        resultsBody.appendChild(row);
    }

    // Function to get the active tab in the original window
    async function getMainWindowTab() {
        const tabs = await chrome.tabs.query({ active: true });
        return tabs.find(tab => !tab.url.includes('chrome-extension://'));
    }

    // Function to ensure content script is injected
    async function injectContentScript(tabId) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            await chrome.scripting.insertCSS({
                target: { tabId: tabId },
                files: ['styles.css']
            });
        } catch (err) {
            console.log('Script already injected or injection failed:', err);
        }
    }

    

    startBtn.addEventListener('click', async () => {
        try {
            cleanupTable(); // Clear processed rows before starting new session
            const tab = await getMainWindowTab();
            if (!tab) {
                alert('Please open a webpage first!');
                return;
            }
            await injectContentScript(tab.id);
            await chrome.tabs.sendMessage(tab.id, { 
                action: 'startScraping',
                maxPages: maxPagesInput.value 
            });
        } catch (error) {
            console.error('Error:', error);
            alert('Error: Make sure you have a webpage open in another tab');
        }
    });

    stopBtn.addEventListener('click', async () => {
        try {
            const tab = await getMainWindowTab();
            if (tab) {
                await chrome.tabs.sendMessage(tab.id, { action: 'stopScraping' });
                cleanupTable();
            }
        } catch (error) {
            console.error('Error:', error);
        }
    });

    // Update the message listener to use the table (supports batch)
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'scrapedData') {
            updateTable(message.data);
        } else if (message.type === 'scrapedDataBatch') {
            const batch = Array.isArray(message.data) ? message.data : [];
            // Use a DocumentFragment to minimize reflows
            const headerRow = document.getElementById('headerRow');
            const resultsBody = document.getElementById('resultsBody');
            const frag = document.createDocumentFragment();
            batch.forEach(item => {
                // Initialize headers on first data if needed
                if (headerRow.children.length === 0) {
                    for (const key in item) {
                        headerRow.appendChild(createHeaderCell(key, item[key]));
                    }
                }
                // Dedup relies on processedRows in updateTable; call it for its logic
                updateTable(item);
            });
            resultsBody.appendChild(frag);
        } else if (message.type === 'error') {
            alert(message.message);
        }
    });



    // Helpers to detect empty cells/rows in table
    function isCellEmptyText(text) {
        const s = (text || '')
            .replace(/\u00A0/g, ' ')   // non-breaking spaces
            .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width chars
            .trim();
        return s === '';
    }

    function isRowEmpty(row) {
        const cells = Array.from(row.getElementsByTagName('td'));
        if (cells.length === 0) return true;
        return cells.every(td => isCellEmptyText(td.textContent));
    }

    async function saveCSV() {
        const table = document.getElementById('resultsTable');
        const rows = Array.from(table.getElementsByTagName('tr'));

        if (rows.length <= 1) {
            alert('No data to export!');
            return;
        }

        let csvContent = [];
        const headerCells = rows[0].getElementsByClassName('column-name');
        const headers = Array.from(headerCells).map(cell => cell.textContent.trim());
        csvContent.push(headers.map(header => `"${header}"`).join(','));

        const tbody = table.getElementsByTagName('tbody')[0];
        let dataRows = Array.from(tbody.getElementsByTagName('tr'));
        // Filter out any fully empty data rows (including a leading blank row)
        dataRows = dataRows.filter(row => !isRowEmpty(row));

        if (dataRows.length === 0) {
            alert('No data to export!');
            return;
        }
        dataRows.forEach(row => {
            const cells = Array.from(row.getElementsByTagName('td'));
            const rowData = cells.map(cell => {
                const value = (cell.textContent || '')
                    .replace(/\u00A0/g, ' ')
                    .replace(/[\u200B-\u200D\uFEFF]/g, '')
                    .trim();
                return `"${value.replace(/"/g, '""')}"`;
            });
            csvContent.push(rowData.join(','));
        });

        const csvString = csvContent.join('\n');
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scraped_data.csv';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    saveCSVBtn.addEventListener('click', saveCSV);

    function cleanupTable() {
        processedRows.clear();
    }
}); 
