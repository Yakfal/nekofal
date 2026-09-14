# Yakfal Hub - Windows PowerShell deployment script.
#
# Deploys backend/server.js + PocketBase (docker) to the server and seeds it.
# Original bash version: deploy.sh (for WSL / Linux users).
#
# Prereqs (auto-checked):
#   - OpenSSH client (ssh.exe / scp.exe) on PATH
#   - An SSH key that can log in as the given user without a password prompt
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File deploy.ps1
#
# Overrides (env vars):
#   YAKFAL_HOST         server address (public IP or Tailscale name/IP)
#   YAKFAL_USER         ssh user                                (default: ubuntu)
#   YAKFAL_KEY          private key path                        (default: ~/.ssh/jarvis_key)
#   YAKFAL_ADMIN_EMAIL  PocketBase superuser email (else prompted)
#   YAKFAL_ADMIN_PASSWORD  PocketBase superuser password (else prompted)

param()

$ErrorActionPreference = "Stop"

$Hostname   = if ($env:YAKFAL_HOST)  { $env:YAKFAL_HOST }  else { "132.145.159.2" }
$User       = if ($env:YAKFAL_USER)  { $env:YAKFAL_USER }  else { "ubuntu" }
$Key        = if ($env:YAKFAL_KEY)   { $env:YAKFAL_KEY }   else { Join-Path $env:USERPROFILE ".ssh\jarvis_key" }
$AdminEmail = $env:YAKFAL_ADMIN_EMAIL
$AdminPass  = $env:YAKFAL_ADMIN_PASSWORD

$Root       = Split-Path -Parent $PSScriptRoot         # repo root (contains backend/ and deploy/)
$Ssh        = "C:\Windows\System32\OpenSSH\ssh.exe"
$Scp        = "C:\Windows\System32\OpenSSH\scp.exe"
$CommonArgs = @("-i", $Key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10")
$Target     = "$User@$Hostname"

function Ssh-Run([string]$cmd) {
  & $Ssh @CommonArgs -T $Target $cmd
  if ($LASTEXITCODE -ne 0) { throw "ssh command failed (exit $LASTEXITCODE): $cmd" }
}

function Ssh-Run-NoThrow([string]$cmd) {
  & $Ssh @CommonArgs -T $Target $cmd
  return $LASTEXITCODE
}

# Write a bash task to /tmp/yakfal_task.sh on the server as LF-only text,
# then run it. Avoids all PowerShell/ssh quote-mangling and CRLF pitfalls.
function Run-RemoteTask([string[]]$scriptLines) {
  $script = ($scriptLines -join "`n") + "`n"   # LF terminated, single trailing newline
  $tmp = Join-Path $env:TEMP "yakfal-task.sh"
  [System.IO.File]::WriteAllText($tmp, $script, [System.Text.UTF8Encoding]::new($false))
  & $Scp @CommonArgs $tmp "${Target}:/tmp/yakfal_task.sh"
  if ($LASTEXITCODE -ne 0) { throw "scp task script failed" }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  Ssh-Run "bash /tmp/yakfal_task.sh"
}

function Check-Password($p) {
  if ($p -match "['`"`$`\\]") { return $false }
  return $true
}

Write-Host ""
Write-Host "=== Yakfal Hub deploy ===" -ForegroundColor Cyan
Write-Host "  host: $Hostname   user: $User   key: $Key"
Write-Host ""

if (-not (Test-Path -LiteralPath $Key)) { throw "SSH key not found: $Key" }
if (-not (Test-Path -LiteralPath "$Root\backend\server.js")) { throw "backend/ not found under $Root" }
if (-not (Test-Path -LiteralPath "$Root\deploy\docker-compose.yml")) { throw "deploy/ not found under $Root" }

# ---- 0) admin credentials ---------------------------------------------------
if (-not $AdminEmail) { $AdminEmail = Read-Host "PocketBase superuser email" }
if (-not $AdminPass)  { $AdminPass  = Read-Host -AsSecureString "PocketBase superuser password" | ForEach-Object { [System.Net.NetworkCredential]::new('', $_).Password } }
while (-not (Check-Password $AdminPass)) {
  Write-Host "Password contains a character (double quote, backtick, dollar, backslash) that breaks shell quoting - please use letters, digits and basic punctuation only." -ForegroundColor Yellow
  $AdminPass = Read-Host -AsSecureString "PocketBase superuser password" | ForEach-Object { [System.Net.NetworkCredential]::new('', $_).Password }
}

# ---- 1) connectivity + sudo -------------------------------------------------
Write-Host "[1/6] Checking SSH connectivity to $Target ..." -ForegroundColor Cyan
Ssh-Run "echo CONNECTED && hostname"
Write-Host "      Checking passwordless sudo ..." -ForegroundColor Cyan
if ((Ssh-Run-NoThrow "sudo -n true 2>/dev/null") -ne 0) {
  throw "The user needs passwordless sudo on the server (or use a cloud-compatible sudo setup)."
}
Write-Host "      OK."

# ---- 2) stage directories ---------------------------------------------------
Write-Host "[2/6] Staging /opt/yakfal-hub/..." -ForegroundColor Cyan
Ssh-Run "sudo mkdir -p /opt/yakfal-hub/backend /opt/yakfal-hub/deploy && sudo chown -R $User /opt/yakfal-hub"

# ---- 3) copy files ----------------------------------------------------------
Write-Host "[3/6] Copying backend + deploy files ..." -ForegroundColor Cyan
& $Scp @CommonArgs "$Root\backend\package.json" "$Root\backend\package-lock.json" "$Root\backend\server.js" "$Root\backend\Dockerfile" "$Root\backend\pb_schema.json" "$Root\backend\init-schema.mjs" "${Target}:/opt/yakfal-hub/backend/"
if ($LASTEXITCODE -ne 0) { throw "scp backend failed" }
& $Scp @CommonArgs "$Root\deploy\docker-compose.yml" "$Root\deploy\Caddyfile" "${Target}:/opt/yakfal-hub/deploy/"
if ($LASTEXITCODE -ne 0) { throw "scp deploy failed" }

# ---- 4) .env ----------------------------------------------------------------
Write-Host "[4/6] Writing .env (encryption key) ..." -ForegroundColor Cyan
$envContent = "DOMAIN=`nPB_ENCRYPTION_KEY=$([guid]::NewGuid().ToString('N'))`n"
$envTemp = Join-Path $env:TEMP "yakfal-env.txt"
Set-Content -LiteralPath $envTemp -Value $envContent -NoNewline -Encoding Ascii
& $Scp @CommonArgs $envTemp "${Target}:/tmp/yakfal-env.txt"
if ($LASTEXITCODE -ne 0) { throw "scp .env failed" }
Remove-Item -LiteralPath $envTemp -Force
Ssh-Run "sudo mv /tmp/yakfal-env.txt /opt/yakfal-hub/deploy/.env && sudo chmod 600 /opt/yakfal-hub/deploy/.env"

# ---- 5) compose up + health -------------------------------------------------
Write-Host "[5/6] docker compose up -d --build ..." -ForegroundColor Cyan
Ssh-Run "cd /opt/yakfal-hub/deploy && sudo docker compose up -d --build"

Write-Host "      Waiting for health endpoints ..." -ForegroundColor Cyan
# Poll docker's own healthchecks (authoritative) for up to ~4 min.
$healthLines = @(
  'set -e',
  'for i in $(seq 1 80); do',
  '  S=$(sudo docker inspect --format "{{.State.Health.Status}}" yakfal-pb yakfal-api 2>/dev/null | tr "\n" " ")',
  '  if echo "$S" | grep -q "healthy healthy"; then echo "HEALTHY: $S"; exit 0; fi',
  '  sleep 3',
  'done',
  'echo "UNHEALTHY after 240s"; exit 1'
)
try { Run-RemoteTask $healthLines } catch {
  Ssh-Run "cd /opt/yakfal-hub/deploy && sudo docker compose ps"
  throw "Services did not become healthy in 240s - see docker compose ps above."
}

# ---- 6) seed superuser + schema ---------------------------------------------
Write-Host "[6/6] Seeding PocketBase superuser ..." -ForegroundColor Cyan
$escapedEmail = $AdminEmail.Replace("'", '').Replace('"', '')
# Credentials travel as container env vars so no shell quoting of the password
# is needed ($AdminPass was validated to avoid ' " ` $ \ characters).
# The inner sh -c uses "$PB_EMAIL" / "$PB_PASS" exactly (expanded inside the container).
# The sh -c argument is single-quoted so the REMOTE host bash does NOT expand
# $PB_EMAIL / $PB_PASS; they are only expanded inside the container (via -e env).
$seedCmd = 'sudo docker compose exec -T -e PB_EMAIL=' + "'$escapedEmail'" + ' -e PB_PASS=' + "'$AdminPass'" + " pocketbase sh -c 'pocketbase superuser upsert `"`$PB_EMAIL`" `"`$PB_PASS`" || pocketbase superuser create `"`$PB_EMAIL`" `"`$PB_PASS`"'"
$seedLines = @(
  'set -e',
  'cd /opt/yakfal-hub/deploy',
  $seedCmd
)
Run-RemoteTask $seedLines

Write-Host "      Running init-schema (from this machine) ..." -ForegroundColor Cyan
$env:POCKETBASE_URL = "http://${Hostname}:8090"
$env:POCKETBASE_ADMIN_EMAIL = $AdminEmail
$env:POCKETBASE_ADMIN_PASSWORD = $AdminPass
Push-Location "$Root\backend"
try {
  & node init-schema.mjs
  if ($LASTEXITCODE -ne 0) { throw "init-schema exit $LASTEXITCODE" }
} catch {
  Write-Host "      Local reach to $Hostname`:8090 failed - running init-schema inside the backend container instead ..." -ForegroundColor Yellow
  if (-not $AdminEmail) { $AdminEmail = $env:POCKETBASE_ADMIN_EMAIL }
  $schemaLines = @(
    'set -e',
    'cd /opt/yakfal-hub/deploy',
    'sudo docker compose cp /opt/yakfal-hub/backend/pb_schema.json backend:/tmp/pb_schema.json',
    'sudo docker compose cp /opt/yakfal-hub/backend/init-schema.mjs backend:/tmp/init-schema.mjs',
    "sudo docker compose exec -T -e POCKETBASE_URL=http://pocketbase:8090 -e POCKETBASE_ADMIN_EMAIL='$escapedEmail' -e POCKETBASE_ADMIN_PASSWORD='$AdminPass' backend node /tmp/init-schema.mjs"
  )
  Run-RemoteTask $schemaLines
}
finally {
  Pop-Location
}
Remove-Item Env:POCKETBASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:POCKETBASE_ADMIN_EMAIL -ErrorAction SilentlyContinue
Remove-Item Env:POCKETBASE_ADMIN_PASSWORD -ErrorAction SilentlyContinue

# ---- summary ----------------------------------------------------------------
Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Ssh-Run "cd /opt/yakfal-hub/deploy && sudo docker compose ps"
Write-Host ""
Write-Host "  Backend API : http://$Hostname`:3000  (health: /api/health)"          -ForegroundColor Cyan
Write-Host "  PocketBase  : http://$Hostname`:8090/_/   (login as $AdminEmail)"      -ForegroundColor Cyan
Write-Host "  Admin shell : ssh -i $Key $User@$Hostname"                            -ForegroundColor Cyan
Write-Host ""
Write-Host "Tailscale (private): also reachable at the server's tailnet address, e.g." -ForegroundColor Cyan
Write-Host "  http://crypto-jarvis.tail606ea9.ts.net:3000  and  ...:8090"           -ForegroundColor Cyan