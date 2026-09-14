const fs = require('fs');

const content = fs.readFileSync('electron/main.js', 'utf8');

// Fix missing closing parenthesis for new Promise in tryListen
const fixedContent = content.replace(
`    };
  };
`,
`    });
  };
`
);

fs.writeFileSync('electron/main.js', fixedContent);
console.log('Fixed missing parenthesis');