const fs = require('fs');

const content = fs.readFileSync('electron/main.js', 'utf8');

// Fix startVideoServer to handle EADDRINUSE by trying alternative ports
const fixedContent = content.replace(
`  videoServer.listen(appPort, () => {
    console.log(\`Video server running on port \${appPort}\`);
  });
}`,
`  const tryListen = (port) => {
    return new Promise((resolve, reject) => {
      const server = videoServer.listen(port, () => {
        console.log(\`Video server running on port \${port}\`);
        resolve(port);
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(err);
        } else {
          reject(err);
        }
      });
    };
  };

  // Try ports starting from appPort, up to appPort + 10
  let actualPort = appPort;
  for (let i = 0; i < 10; i++) {
    try {
      actualPort = await tryListen(appPort + i);
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        continue;
      }
      throw err;
    }
  }
  console.log(\`Video server running on port \${actualPort}\`);
}`,
);

fs.writeFileSync('electron/main.js', fixedContent);
console.log('Fixed port handling');