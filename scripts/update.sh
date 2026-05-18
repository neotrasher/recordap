#!/usr/bin/env bash
#
# update.sh — actualizar recordap en el VPS sin downtime
#
# Uso (desde el VPS, dentro de /root/recordap):
#   ./scripts/update.sh
#
# Hace:
#   1. git pull
#   2. npm install --omit=dev  (solo si package-lock.json cambió)
#   3. npm run build
#   4. pm2 restart recordap --update-env
#
# Es idempotente — correrlo varias veces no rompe nada.

set -euo pipefail

cd "$(dirname "$0")/.."   # parado en el root del repo

# ── 1. Pull los cambios ─────────────────────────────────────────────────────
echo "→ git pull"
PRE_LOCK=$(sha256sum package-lock.json | cut -d' ' -f1)
git pull --ff-only
POST_LOCK=$(sha256sum package-lock.json | cut -d' ' -f1)

# ── 2. npm install solo si las deps cambiaron ───────────────────────────────
# Nota: instalamos TODO (incluyendo devDeps) porque TypeScript vive ahí y lo
# necesitamos para `npm run build` en el paso 3. El overhead es ~40MB de
# node_modules — aceptable.
if [ "$PRE_LOCK" != "$POST_LOCK" ]; then
  echo "→ package-lock.json cambió, instalando deps"
  npm install
else
  echo "→ deps sin cambios, salteando npm install"
fi

# ── 3. Build TypeScript ─────────────────────────────────────────────────────
echo "→ npm run build"
npm run build

# ── 4. Restart en PM2 con env fresh ─────────────────────────────────────────
echo "→ pm2 restart recordap --update-env"
pm2 restart recordap --update-env

# ── 5. Confirmar ────────────────────────────────────────────────────────────
pm2 status recordap
echo "✓ recordap actualizado"
