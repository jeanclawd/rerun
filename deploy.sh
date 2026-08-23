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
cp host/style.css host/app.js host/dag.js host/session-core.mjs host/figrender.mjs "$DEST/"
cp -r examples "$DEST/" 2>/dev/null || true
chmod -R a+rX "$DEST"
echo "deployed rerun @ v=$V"
