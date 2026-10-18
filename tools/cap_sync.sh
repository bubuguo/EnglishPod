#!/bin/sh
# Sync the web app (repo root = source of truth) into the Capacitor Android
# project. Usage: tools/cap_sync.sh
set -e
cd "$(dirname "$0")/.."

# 1. Copy web assets into www/ (Capacitor's webDir).
mkdir -p www
cp index.html styles.css app.js sw.js lessons.json manifest.webmanifest www/
rm -rf www/icons
cp -R icons www/

# 2. Run cap sync inside the podman node:20 container (Node isn't installed
#    on the host). Requires the podman machine to be running:
#    podman machine start
podman run --rm -v "$PWD":/work -w /work docker.io/library/node:20 npx cap sync
