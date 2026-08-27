<p align="center">
  <img src="assets/banner.svg" width="760" alt="rerun">
</p>

# ReRun ⟳

An experiment: a **marimo-like reactive notebook for the MATLAB language**,
running entirely in the browser on [RunMat](https://github.com/runmat-org/runmat)'s
wasm build.

Live (private box): served under `/rerun/` behind the box's reverse proxy.

## The idea

Jupyter notebooks lie: run cells out of order, delete one, and the kernel
remembers things the page no longer says. marimo fixed this for Python by
making the notebook a **dataflow graph** — every variable is defined by exactly
one cell, edges are inferred from the code, and editing a cell reruns exactly
its dependents. ReRun applies the same discipline to MATLAB:

- **Cells form a DAG.** A lexical analyzer (`host/dag.js`) extracts which names
  each cell *binds* (assignments, `for` variables, function definitions) and
  which it *reads*. Reads of another cell's binding become edges. MATLAB's
  `x(1)`-is-it-indexing-or-a-call ambiguity resolves at the graph level: a name
  only creates an edge if some cell defines it, so builtins fall out.
- **Page order is cosmetic.** Execution order is topological. Move cells
  around freely; the export (`.m`) is written in dependency order so it runs
  top-to-bottom in any MATLAB.
- **Reactive reruns.** Edit a cell (or toggle off `reactive` and hit
  Ctrl+Enter) and it reruns together with its transitive dependents — nothing
  else.
- **No hidden state.** A variable a cell stops defining is `clear`ed before
  the rerun; deleting a cell clears its variables and reruns the orphaned
  dependents, which then fail *honestly*.
- **Guardrails, marimo-style.** Two cells defining the same variable, a
  dependency cycle, or a cell mutating another cell's variable (`v(2) = …`)
  are flagged as graph errors instead of silently producing order-dependent
  results.

The workspace panel shows every variable with its value preview, type, and the
cell that owns it.

## Architecture

```
host/
  dag.js           the analyzer + graph (pure, unit-tested: test/dag.test.mjs)
  app.js           cells UI + reactive scheduler + one persistent RunMat session
  session-core.mjs vendored from runmat-jupyter — exec → {stdout, displays,
                   figures(SVG via figrender), workspace, error}
  figrender.mjs    vendored from runmat-lab — figure scene JSON → SVG
  index.html / style.css
```

One RunMat wasm session holds the workspace across cell runs (no reset — this
is what makes incremental reruns cheap: only the dirty subgraph re-executes).
The 52 MB runtime is loaded from `/streamlab/runtime` (same origin, immutable-
cached, shared with the streamlab player so browsers download it once).

### RunMat 0.6.1 quirks this design absorbs

- *Function defs riding along with a script make RunMat echo suppressed
  assignments, and a pure-function-file exec wipes the workspace* (both probed
  live) → function cells are installed by a separate exec guarded with
  `if false, end`; ordinary cells run bare. Installed functions persist until
  the next exec that contains function defs, so one install per library edit
  suffices.
- *Figure scenes reference live workspace variables* → figures are exported at
  the end of the exec that touched them, while their variables are alive.
- *`global` is broken* → irrelevant here; the graph is the state channel.

## Run the tests

```bash
node test/dag.test.mjs
```

## Deploy

```bash
./deploy.sh   # version-stamps assets into /opt/sites/rerun (Cloudflare-safe)
```

## Pair (`hold on`) — agents on the notebook

An agent (Claude Code, Codex, opencode, Cursor — anything MCP) can pair with a
notebook through `pair/mcp/server.mjs`, an MCP stdio server with marimo-pair
semantics: `exec` (scratchpad in the live session, traceless, can't steal
notebook-owned names) and `apply` (transactional cell batches, validated
against the DAG before anything runs, reactive rerun + per-cell report), plus
`notebook`, `read_variable`, `read_figure`, `export_m`.

Two modes:

- **Headless** — `node pair/mcp/server.mjs --notebook nb.rerun.m`: the server
  owns a private session; the file is loaded/replayed on start and saved after
  every apply. Registered for this repo in `.mcp.json`.
- **Live tab** — click **pair** in the ReRun header, hand the shown command
  (`--relay wss://…/rerun/pair --session … --token …`) to the agent: every
  tool call executes in YOUR tab, live — cells appear, plots redraw, and the
  pair button is the kill switch. The relay (`relay/relay.mjs`, systemd
  `rerun-pair-relay`, Caddy `/rerun/pair`) is a dumb token-gated pipe. The
  token is a bearer credential, so prefer the header's `RERUN_PAIR_TOKEN=…`
  form (env var) or `--token-file <path>` over `--token`, which lands in
  shell history and process args.

Design notes and the research behind this: `docs/PAIR-NOTES.md`.

## Signal Lab — real audio/video in, real MATLAB DSP out

Click **🎵 audio** and drop any audio or video file — [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
(vendored under `vendor/ffmpeg/`, runs in a worker, same-origin, no upload
anywhere) decodes/transcodes it to a 16-bit PCM WAV in-browser. That lands in
an in-memory filesystem wired into RunMat via its `fsProvider` hook, so cell 1
becomes `[x, fs] = audioread('input.wav')` — the real builtin, not a custom
shim. From there it's genuine MATLAB Signal Processing Toolbox-shaped code:
`fft`, `pwelch`, `spectrogram`, `fir1`, `filtfilt`, `buttord` all work, so a
notebook can be a real reactive spectral workbench — edit a filter cutoff in
one cell, the spectrogram plot two cells down updates. `examples/signal-lab.m`
is a self-contained (synthesized-tone) starting point.

**💾 export audio** writes a named workspace variable back out as a WAV.
RunMat has no `audiowrite`, and reading a full array back to JS via
`materializeVariable` caps at 4096 elements — so instead the export asks
RunMat to `fwrite` the samples itself (through the same in-memory filesystem),
and a small WAV header gets stitched onto the raw PCM bytes on the JS side.
Implementation: `host/signal-lab.mjs`.

## File format (`.rerun.m`)

A notebook is a valid MATLAB script: `%%` sections in dependency order
(function cells last, as MATLAB requires), so it runs top-to-bottom anywhere.
Round-trip metadata rides in comments — `%% ⟳ <id>` headers and a
`% ⟳ page-order:` footer — so ReRun restores the page layout exactly and git
diffs show one hunk per edited cell. Plain `%%`-sectioned files import fine.
Implementation: `host/format.js`, shared by the app and the pair server.

## Status / limits (v0.1)

- Analyzer is lexical, not a parser: strings/comments/transpose handled,
  `eval`/`assignin`/`load`-into-workspace not tracked (don't use them).
- Function-cell bodies are treated as opaque (locals aren't analyzed); a
  function cell's dependents are its callers.
- Plain textareas, no syntax highlighting yet.
- Everything inherits RunMat 0.6.1's compatibility surface — see the
  [runmat-lab](https://github.com/jeanclawd/runmat-lab) compat matrix.
