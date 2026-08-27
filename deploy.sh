#!/bin/bash
# Deploy the ReRun app to /opt/sites/rerun with version-stamped asset URLs
# (Cloudflare caches per-encoding variants; bare copies go stale — see
# streamlab's deploy.sh, same trick).
set -euo pipefail
cd "$(dirname "$0")"

V="$(git rev-parse --short HEAD 2>/dev/null || echo dev)$(date +%H%M)"
DEST=/opt/sites/rerun
mkdir -p "$DEST"

sed "s/__V__/$V/g" host/index.html > "$DEST/index.html"
cp host/style.css host/app.js host/dag.js host/format.js host/pair.js host/session-core.mjs host/figrender.mjs host/signal-lab.mjs "$DEST/"
cp assets/logo.svg "$DEST/"
cp -r examples "$DEST/" 2>/dev/null || true

# vendor/ffmpeg/core/{ffmpeg-core.js,ffmpeg-core.wasm} are GPL binaries (~32MB) —
# not committed (see vendor/ffmpeg/NOTICE.md), fetched from npm here instead,
# same as the RunMat runtime itself living outside this repo.
if [ ! -f vendor/ffmpeg/core/ffmpeg-core.wasm ]; then
  echo "fetching @ffmpeg/core (one-time, ~20MB download)…"
  TMP="$(mktemp -d)"
  (cd "$TMP" && npm pack @ffmpeg/core@0.12.10 >/dev/null && tar xzf ffmpeg-core-*.tgz)
  cp "$TMP/package/dist/esm/ffmpeg-core.js" "$TMP/package/dist/esm/ffmpeg-core.wasm" vendor/ffmpeg/core/
  rm -rf "$TMP"
fi
cp -r vendor "$DEST/"
chmod -R a+rX "$DEST"
echo "deployed rerun @ v=$V"
