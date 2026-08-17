#!/usr/bin/env bash
# Build the pi-code server sidecar and stage desktop resources.
#
#   1. bun --compile the Node server (Fastify + pi SDK) into one binary
#   2. name it with the Rust target triple (Tauri sidecar convention)
#   3. stage the built webapp as a bundle resource the sidecar serves
set -euo pipefail

cd "$(dirname "$0")"

TRIPLE=$(rustc -vV | awk '/^host:/ {print $2}')
ROOT=$(cd .. && pwd)
OUT="src-tauri/binaries/pi-code-server-${TRIPLE}"

mkdir -p "$(dirname "$OUT")"

echo "[sidecar] compiling server with bun..."
(cd "$ROOT/server" && bun build --compile --minify src/main.ts --outfile "$ROOT/desktop/$OUT")

echo "[sidecar] staging webapp resources..."
rm -rf src-tauri/resources/webapp-dist
mkdir -p src-tauri/resources/webapp-dist
if [ -d "$ROOT/webapp/dist" ]; then
  cp -R "$ROOT/webapp/dist/." src-tauri/resources/webapp-dist/
else
  echo "[sidecar] WARNING: webapp/dist missing — build it first: (cd webapp && npm run build)" >&2
  exit 1
fi

chmod +x "$OUT"
echo "[sidecar] done: $OUT"
