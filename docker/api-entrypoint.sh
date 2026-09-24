#!/bin/sh
set -eu

PRISMA=./node_modules/.bin/prisma

echo "[entrypoint] applying migrations"
"$PRISMA" migrate deploy

# Seeding is opt-in so a redeploy against a real database cannot overwrite it.
if [ "${SEED_ON_START:-false}" = "true" ]; then
  if [ -f prisma/seed.ts ]; then
    echo "[entrypoint] seeding (SEED_ON_START=true)"
    "$PRISMA" db seed
  else
    echo "[entrypoint] SEED_ON_START=true but no prisma/seed.ts yet — skipping"
  fi
fi

exec "$@"
