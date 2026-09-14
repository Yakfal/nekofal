const fs = require('fs');
const content = fs.readFileSync('H:/MyownX/src/pages/Settings.jsx', 'utf8');
const lines = content.split('\n');
const result = [];
const seen = new Set();
const functionsToDedup = ['showToast', 'saveSettings', 'addUrlField', 'removeUrlField', 'handleAddScraper', 'removeScraper', 'testScraper', 'syncScrapers', 'clearDatabase', 'toggleYtDlp', 'saveSettings'];
let inFunction = false;
let currentFn = null;
let braceCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const match = line.match(/const\s+(\w+)\s*=\s*(async\s+)?\(/);
  if (match) {
    const fnName = match[1];
    if (['showToast', 'saveSettings', 'addUrlField', 'removeUrlField', 'handleAddScraper', 'removeScraper', 'testScraper', 'syncScrapers', 'clearDatabase', 'toggleYtDlp', 'saveSettings'].includes(fnName)) {
      if (seen.has(fnName)) {
        let braceCount = 0;
        let inFunction = true;
        while (i < lines.length && inFunction) {
          const line = lines[i];
          for (let j = 0; j < line.length; j++) {
            if (line[j] === '{') braceCount++;
            if (line[j] === '}') {
              braceCount--;
              if (braceCount === 0) {
                inFunction = false;
              }
            }
          }
          if (!inFunction) break;
          i++;
        }
        continue;
      } else {
        seen.add(fnName);
      }
    }
    result.push(line);
  }

  fs.writeFileSync('H:/MyownX/src/pages/Settings.jsx', result.join('\n'));
  console.log('Done');
}