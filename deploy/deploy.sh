#!/usr/bin/env bash
# ============================================================================
#  Yakfal Hub - automated deployment to 132.145.159.2
#
#  Run from Windows anywhere bash is available (Git Bash / WSL / MSYS):
#     bash deploy/deploy.sh
#
#  Uses your Windows SSH key exactly as specified:
#     ssh -i C:\Users\Yakfal\.ssh\id_rsa root@132.145.159.2
#
#  What it does:
#    1. Verifies SSH connectivity with your key
#    2. Copies  backend/  and  deploy/  to /opt/yakfal-hub on the server
#    3. Installs Docker + compose plugin when missing
#    4. docker compose up --build  (pocketbase + express gateway + caddy)
#    5. Seeds the PocketBase superuser (creates admin login)
#    6. Runs  backend/init-schema.mjs  to create the collections from
#       backend/pb_schema.json
#
#  Env overrides:
#    YAKFAL_KEY      path to your SSH private key (default from spec path)
#    SERVER          ssh target, default root@132.145.159.2
#    DOMAIN          your hostname -> automatic Let's Encrypt via Caddy
#                    (omit or leave blank when using the raw IP only)
#    ADMIN_EMAIL     PocketBase superuser email (prompted if unset)
#    ADMIN_PASSWORD  PocketBase superuser password (prompted if unset)
#    POCKETBASE_URL  used for local schema init, default http://132.145.159.2:8090
# ============================================================================
set -euo pipefail

# --- Config ---------------------------------------------------------------
SERVER="${SERVER:-root@132.145.159.2}"
DEFAULT_KEY='C:\Users\Yakfal\.ssh\id_rsa'
KEY="${YAKFAL_KEY:-$DEFAULT_KEY}"
DOMAIN="${DOMAIN:-}"
POCKETBASE_URL="${POCKETBASE_URL:-http://132.145.159.2:8090}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
REMOTE_DIR="/opt/yakfal-hub"

echo ""
echo "==> Yakfal Hub deploy -> ${SERVER}"
echo "    local source : ${ROOT_DIR}"
echo "    ssh key      : ${KEY}"
echo "    remote dir   : ${REMOTE_DIR}"

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$SERVER")

# --- 1. Connectivity -------------------------------------------------------
echo ""
echo "==> [1/6] Checking SSH connectivity to ${SERVER} ..."
"${SSH[@]}" "echo connected && uname -a" || {
  echo "ERROR: cannot reach $SERVER with key '$KEY'." >&2
  echo "       Set YAKFAL_KEY=\"path\" if your key lives elsewhere." >&2
  exit 1
}

# --- 2. Collect admin credentials for PocketBase ---------------------------
if [[ -z "${ADMIN_EMAIL:-}" ]]; then
  read -r -p "PocketBase admin email (create): " ADMIN_EMAIL
fi
if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  read -r -s -p "PocketBase admin password: " ADMIN_PASSWORD
  echo ""
fi
if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: admin email and password are required." >&2
  exit 1
fi

# --- 3. Copy files to the server --------------------------------------------
echo ""
echo "==> [2/6] Copying source files to ${SERVER}:${REMOTE_DIR} ..."
"${SSH[@]}" "mkdir -p ${REMOTE_DIR}/backend ${REMOTE_DIR}/pb_data ${REMOTE_DIR}/caddy_data ${REMOTE_DIR}/caddy_config"
scp -q -i "$KEY" -o StrictHostKeyChecking=accept-new \
  "$ROOT_DIR/backend/package.json" \
  "$ROOT_DIR/backend/server.js" \
  "$ROOT_DIR/backend/Dockerfile" \
  "$ROOT_DIR/backend/init-schema.mjs" \
  "$ROOT_DIR/backend/pb_schema.json" \
  "$SERVER:${REMOTE_DIR}/backend/"
scp -q -i "$KEY" -o StrictHostKeyChecking=accept-new \
  "$ROOT_DIR/deploy/docker-compose.yml" \
  "$ROOT_DIR/deploy/Caddyfile" \
  "$SERVER:${REMOTE_DIR}/"

# --- 4. Provision docker if needed, write env, compose up --------------------
echo ""
echo "==> [3/6] Ensuring docker + compose on the server ..."
PB_KEY="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
"${SSH[@]}" bash -s <<'REMOTE'
set -e
command -v docker >/dev/null 2>&1 || {
  echo "  installing docker.io + compose plugin ..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null
  apt-get install -y docker.io docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
}
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose unavailable" >&2; exit 1; }
echo "  docker ready"
REMOTE

echo ""
echo "==> [4/6] Writing .env and building the stack ..."
cat > "$SCRIPT_DIR/../.tmp-env" <<EOF
DOMAIN=${DOMAIN}
PB_ENCRYPTION_KEY=${PB_KEY}
EOF
scp -q -i "$KEY" -o StrictHostKeyChecking=accept-new "$SCRIPT_DIR/../.tmp-env" "$SERVER:${REMOTE_DIR}/.env"
rm -f "$SCRIPT_DIR/../.tmp-env"

"${SSH[@]}" bash -s <<REMOTE
set -e
cd ${REMOTE_DIR}
docker compose config --quiet
docker compose pull --quiet || true
docker compose up -d --build
# wait for services
for i in \$(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null && curl -sf http://127.0.0.1:8090/api/health >/dev/null; then
    echo "  both services healthy"
    break
  fi
  [ \$i -eq 30 ] && { echo "ERROR: services did not become healthy in time" >&2; exit 1; }
  sleep 2
done
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
REMOTE

# --- 5. Seed PocketBase superuser -------------------------------------------
echo ""
echo "==> [5/6] Seeding PocketBase superuser ..."
"${SSH[@]}" bash -s <<REMOTE
set -e
cd ${REMOTE_DIR}
if docker compose exec -T pocketbase pocketbase superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" >/dev/null 2>&1; then
  echo "  superuser ensured"
else
  docker compose exec -T pocketbase pocketbase superuser create "$ADMIN_EMAIL" "$ADMIN_PASSWORD" >/dev/null 2>&1 && echo "  superuser created"
fi
REMOTE

# --- 6. Create the collections via init-schema.mjs (run from this machine) ---
echo ""
echo "==> [6/6] Initializing collections from backend/pb_schema.json ..."
if command -v node >/dev/null 2>&1; then
  (
    cd "$ROOT_DIR/backend"
    POCKETBASE_URL="$POCKETBASE_URL" \
    POCKETBASE_ADMIN_EMAIL="$ADMIN_EMAIL" \
    POCKETBASE_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    node init-schema.mjs
  )
else
  echo "  node not found locally — run schema init manually from a machine with node:"
  echo "    cd backend && POCKETBASE_URL=$POCKETBASE_URL POCKETBASE_ADMIN_EMAIL=$ADMIN_EMAIL POCKETBASE_ADMIN_PASSWORD=... node init-schema.mjs"
fi

# --- Summary ----------------------------------------------------------------
echo ""
echo "=========================================================================="
echo " Deployment complete!"
echo "  Express gateway        http://132.145.159.2:3000/api/health"
echo "  PocketBase (admin UI)  http://132.145.159.2:8090/_/"
echo "  PocketBase API         http://132.145.159.2:8090/api/health"
if [[ -n "$DOMAIN" ]]; then
  echo "  HTTPS app              https://${DOMAIN}  (Let's Encrypt via Caddy)"
  echo "  PocketBase via TLS     https://${DOMAIN}/pb/_/"
fi
echo ""
echo "  In the app:  Settings -> Cloud Sync"
echo "    server URL:  http://132.145.159.2:8090"
echo "    email/pass:  the admin credentials above (create a normal account too)"
echo "=========================================================================="