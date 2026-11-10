#!/bin/sh
# One-shot setup for the demo (demo/compose.yaml). Safe to run again.
set -eu
if [ ! -f /certs/hmis.crt ]; then
  echo "setup: making a self-signed certificate for the demo HMIS"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=hmis" \
    -addext "subjectAltName=DNS:hmis,DNS:localhost" \
    -keyout /certs/hmis.key -out /certs/hmis.crt 2>/dev/null
  chmod 600 /certs/hmis.key && chmod 644 /certs/hmis.crt
fi
echo "setup: applying database migrations"
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
echo "setup: demo accounts and tests"
node demo/seed.mjs
echo "setup: demo sample data"
node demo/sample.mjs
