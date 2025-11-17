document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const maxPagesInput = document.getElementById('maxPages');
    const saveCSVBtn = document.getElementById('saveCSVBtn');
    const cidInput = document.getElementById('cidInput');
    const modeRadios = document.querySelectorAll('input[name="runMode"]');
    let columnNames = {};
    const processedRows = new Set();
    let currentCid = '';
    let currentMode = 'realtime';
    let currentDataKeys = [];
    let currentDisplayHeaders = [];

    chrome.storage.local.get(['columnNames'], result => {
        if (result.columnNames) {
            columnNames = result.columnNames;
            refreshDisplayHeaders();
        }
    });

    function sanitizeCid(rawValue) {
        return (rawValue || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function formatDateForFilename(date = new Date()) {
        const pad = num => String(num).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    }

    function buildFileName(cidValue) {
        const safeCid = sanitizeCid(cidValue) || 'scrape';
        return `${safeCid}_${formatDateForFilename()}.csv`;
    }

    function refreshDisplayHeaders() {
        if (!currentDataKeys.length) {
            currentDisplayHeaders = [];
            return;
        }
        currentDisplayHeaders = currentDataKeys.map(key => columnNames[key] || key);
    }

    function getSelectedMode() {
        const selected = Array.from(modeRadios).find(radio => radio.checked);
        return selected ? selected.value : 'realtime';
    }

    function updateModeState() {
        currentMode = getSelectedMode();
        const isRealtime = currentMode === 'realtime';
        saveCSVBtn.disabled = isRealtime;
        saveCSVBtn.title = isRealtime ? 'Realtime mode streams rows into the desktop monitor.' : '';
    }

    modeRadios.forEach(radio => radio.addEventListener('change', updateModeState));
    updateModeState();

    function createHeaderCell(key) {
        const th = document.createElement('th');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'column-name';
        nameSpan.textContent = columnNames[key] || key;

        const actionsSpan = document.createElement('span');
        actionsSpan.className = 'column-actions';

        const editBtn = document.createElement('span');
        editBtn.className = 'edit-column';
        editBtn.textContent = 'Edit';
        editBtn.onclick = () => {
            const input = document.createElement('input');
            input.className = 'column-input';
            input.value = nameSpan.textContent;

            input.onblur = () => {
                columnNames[key] = input.value;
                nameSpan.textContent = input.value;
                refreshDisplayHeaders();
                th.replaceChild(nameSpan, input);
                th.appendChild(actionsSpan);
                chrome.storage.local.set({ columnNames });
            };

            input.onkeydown = e => {
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
        deleteBtn.onclick = () => {
            if (!confirm(`Are you sure you want to delete the column "${nameSpan.textContent}"?`)) {
                return;
            }
            const table = document.getElementById('resultsTable');
            const columnIndex = Array.from(th.parentElement.children).indexOf(th);
            th.remove();

            const rows = table.getElementsByTagName('tr');
            Array.from(rows).forEach(row => {
                const cells = row.getElementsByTagName('td');
                if (cells[columnIndex]) {
                    cells[columnIndex].remove();
                }
            });

            const position = currentDataKeys.indexOf(key);
            if (position !== -1) {
                currentDataKeys.splice(position, 1);
                refreshDisplayHeaders();
            }
            delete columnNames[key];
            chrome.storage.local.set({ columnNames });
        };

        actionsSpan.appendChild(editBtn);
        actionsSpan.appendChild(deleteBtn);

        th.appendChild(nameSpan);
        th.appendChild(actionsSpan);
        return th;
    }

    function normaliseCellValue(value) {
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (error) {
                console.error('Failed to stringify cell value:', error);
                return '';
            }
        }
        return String(value);
    }

    function removeInvisibles(text) {
        return text
            .replace(/\u00A0/g, ' ')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .trim();
    }

    function toCsvRow(values) {
        return values
            .map(value => {
                const clean = removeInvisibles(normaliseCellValue(value));
                return `"${clean.replace(/"/g, '""')}"`;
            })
            .join(',');
    }

    function updateTable(data) {
        const headerRow = document.getElementById('headerRow');
        const resultsBody = document.getElementById('resultsBody');
        const rowIdentifier = Object.values(data || {}).join('|');

        if (processedRows.has(rowIdentifier)) {
            console.log('Skipping duplicate row:', data);
            return false;
        }
        processedRows.add(rowIdentifier);

        const incomingKeys = Object.keys(data || {});
        if (!incomingKeys.length) {
            return false;
        }

        if (headerRow.children.length === 0) {
            currentDataKeys = incomingKeys;
            refreshDisplayHeaders();
            currentDataKeys.forEach(key => headerRow.appendChild(createHeaderCell(key)));
        } else if (incomingKeys.join('|') !== currentDataKeys.join('|')) {
            console.warn('Incoming row structure differs from header; table rendering may be inconsistent.');
        }

        const keysForRow = currentDataKeys.length ? currentDataKeys : incomingKeys;
        const row = document.createElement('tr');
        keysForRow.forEach(key => {
            const td = document.createElement('td');
            td.textContent = normaliseCellValue(data[key]);
            row.appendChild(td);
        });
        resultsBody.appendChild(row);

        return true;
    }

    async function getMainWindowTab() {
        const tabs = await chrome.tabs.query({ active: true });
        return tabs.find(tab => !tab.url.includes('chrome-extension://'));
    }

    async function injectContentScript(tabId) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            });
            await chrome.scripting.insertCSS({
                target: { tabId },
                files: ['styles.css']
            });
        } catch (error) {
            console.log('Script already injected or injection failed:', error);
        }
    }

    const REALTIME_SERVER_ROOT = 'http://127.0.0.1:5055';

    startBtn.addEventListener('click', async () => {
        const cidValue = cidInput.value.trim();
        if (!cidValue) {
            alert('Please enter a CID before starting.');
            return;
        }

        currentCid = cidValue;
        updateModeState();
        const isRealtime = currentMode === 'realtime';

        cleanupTable({ clearDom: true });

        if (isRealtime) {
            try {
                const response = await fetch(`${REALTIME_SERVER_ROOT}/health`, {
                    method: 'GET',
                    cache: 'no-store'
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (error) {
                console.warn('Realtime server ping failed:', error);
                const proceed = confirm('Realtime server is not responding. Continue anyway? Rows will queue locally until it is available.');
                if (!proceed) {
                    return;
                }
            }
        }

        try {
            const tab = await getMainWindowTab();
            if (!tab) {
                alert('Please open a webpage first!');
                return;
            }

            await injectContentScript(tab.id);
            await chrome.tabs.sendMessage(tab.id, {
                action: 'startScraping',
                maxPages: maxPagesInput.value,
                mode: currentMode,
                cid: currentCid
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
            }
        } catch (error) {
            console.error('Error sending stop command:', error);
        } finally {
            cleanupTable();
        }
    });

    chrome.runtime.onMessage.addListener(message => {
        if (message.type === 'scrapedData') {
            updateTable(message.data);
        } else if (message.type === 'scrapedDataBatch') {
            const batch = Array.isArray(message.data) ? message.data : [];
            batch.forEach(item => updateTable(item));
        } else if (message.type === 'error') {
            alert(message.message);
        } else if (message.type === 'scrapeStopped') {
            // no-op; UI cleanup handled elsewhere
        }
    });

    function isCellEmptyText(text) {
        return removeInvisibles(text || '') === '';
    }

    function isRowEmpty(row) {
        const cells = Array.from(row.getElementsByTagName('td'));
        if (cells.length === 0) {
            return true;
        }
        return cells.every(td => isCellEmptyText(td.textContent));
    }

    async function saveCSV() {
        const cidValue = cidInput.value.trim() || currentCid;
        if (!cidValue) {
            alert('Please enter a CID before saving.');
            return;
        }
        currentCid = cidValue;

        const table = document.getElementById('resultsTable');
        const rows = Array.from(table.getElementsByTagName('tr'));

        if (rows.length <= 1) {
            alert('No data to export!');
            return;
        }

        const csvContent = [];
        const headerCells = rows[0].getElementsByClassName('column-name');
        const headers = Array.from(headerCells).map(cell => removeInvisibles(cell.textContent));
        csvContent.push(toCsvRow(headers));

        const tbody = table.getElementsByTagName('tbody')[0];
        let dataRows = Array.from(tbody.getElementsByTagName('tr'));
        dataRows = dataRows.filter(row => !isRowEmpty(row));

        if (dataRows.length === 0) {
            alert('No data to export!');
            return;
        }

        dataRows.forEach(row => {
            const cells = Array.from(row.getElementsByTagName('td'));
            const rowValues = cells.map(cell => removeInvisibles(cell.textContent));
            csvContent.push(toCsvRow(rowValues));
        });

        const csvString = csvContent.join('\n');
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = buildFileName(currentCid);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    saveCSVBtn.addEventListener('click', saveCSV);

    function cleanupTable(options = {}) {
        processedRows.clear();
        if (options.clearDom) {
            currentDataKeys = [];
            currentDisplayHeaders = [];
            document.getElementById('headerRow').innerHTML = '';
            document.getElementById('resultsBody').innerHTML = '';
        }
    }

});
