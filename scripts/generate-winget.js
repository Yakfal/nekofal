/* Nekofal — winget manifest generator.
   Runs as part of `npm run dist` / `npm run dist:publish` after electron-builder
   has produced the NSIS installer. It hashes the setup executable with SHA-256
   and writes a Windows Package Manager (winget) installer manifest so users can
   `winget install Yakfal.Nekofal` (or `winget install --source winget ...` once
   the package is submitted), bypassing browser/SmartScreen friction. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));

const setupName = `Nekofal-Setup-${version}.exe`;
const setupPath = path.join(root, 'dist', setupName);
if (!fs.existsSync(setupPath)) {
  console.error(`[winget] setup installer not found: ${setupPath}`);
  console.error('[winget] run `npm run dist` (or `npm run dist:publish`) first.');
  process.exit(1);
}

const sha256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync(setupPath))
  .digest('hex')
  .toUpperCase();

const installerUrl = `https://github.com/Yakfal/nekofal/releases/download/v${version}/${setupName}`;
const releaseDate = new Date().toISOString().slice(0, 10);

const yaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
---
PackageIdentifier: Yakfal.Nekofal
PackageVersion: ${version}
InstallerType: nsis
Scope: machine
UpgradeBehavior: uninstallPrevious
InstallModes:
  - interactive
  - silent
  - silentWithProgress
InstallerSuccessCodes:
  - 0
ReleaseDate: ${releaseDate}
Installers:
  - Architecture: x64
    InstallerLocale: en-US
    InstallerUrl: ${installerUrl}
    InstallerSha256: ${sha256}
ManifestType: installer
ManifestVersion: 1.6.0
`;

const outDir = path.join(root, 'dist', 'winget');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'nekofal.yaml');
fs.writeFileSync(outFile, yaml, 'utf8');

console.log(`[winget] manifest written: ${path.relative(root, outFile)}`);
console.log(`[winget] version=${version} sha256=${sha256}`);
console.log(`[winget] installer=${installerUrl}`);