const fs = require('fs');

const content = fs.readFileSync('electron/main.js', 'utf8');

// Fix startVideoServer to be async and handle EADDRINUSE properly
const fixedContent = content.replace(
`function startVideoServer() {
  const appPort = parseInt(process.env.API_PORT) || 5001;
`,
`async function startVideoServer() {
  const appPort = parseInt(process.env.API_PORT) || 5001;
`
);

fs.writeFileSync('electron/main.js', fixedContent);
console.log('Fixed startVideoServer async');