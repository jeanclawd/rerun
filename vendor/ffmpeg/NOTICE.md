# Vendored: ffmpeg.wasm

Fetched from npm, unmodified except splitting into files for direct `<script type=module>` use (no bundler in this repo).

- `@ffmpeg/ffmpeg` 0.12.15 (`*.js` in this directory except `core/`) — MIT.
- `@ffmpeg/core` 0.12.10 (`core/ffmpeg-core.js`, `core/ffmpeg-core.wasm`, ~32MB) — **GPL-2.0-or-later**. This is a compiled build of FFmpeg itself; it's loaded as a standalone WASM module by the MIT-licensed JS wrapper above (the same architecture used by every other ffmpeg.wasm deployment), not statically linked into this repo's own code — but it *is* GPL code. Worth knowing before this repo picks a license of its own. Not committed to git (see `.gitignore`) — `deploy.sh` fetches it from npm on first deploy, same as the RunMat runtime living outside this repo.
- Source: https://github.com/ffmpegwasm/ffmpeg.wasm
