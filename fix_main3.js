const fs = require('fs');

const content = fs.readFileSync('electron/main.js', 'utf8');
const lines = content.split('\n');
// Remove the extra }); at line 796 (0-indexed: 795)
const fixedLines = lines.filter((line, index) => index !== 795);
fs.writeFileSync('electron/main.js', fixedLines.join('\n'));
console.log('Fixed');