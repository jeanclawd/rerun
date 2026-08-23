# ReRun ⟳

An experiment: a **marimo-like reactive notebook for the MATLAB language**,
running entirely in the browser on [RunMat](https://github.com/runmat-org/runmat)'s
wasm build.

Live (private box): `https://jean-clawd.com/rerun/`

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

- *Every exec replaces all script-defined functions* → the sources of all
  function cells are appended to every exec (the streamlab library trick), so
  editing a function propagates exactly like editing data.
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

## Status / limits (v0.1)

- Analyzer is lexical, not a parser: strings/comments/transpose handled,
  `eval`/`assignin`/`load`-into-workspace not tracked (don't use them).
- Function-cell bodies are treated as opaque (locals aren't analyzed); a
  function cell's dependents are its callers.
- Plain textareas, no syntax highlighting yet.
- Everything inherits RunMat 0.6.1's compatibility surface — see the
  [runmat-lab](https://github.com/jeanclawd/runmat-lab) compat matrix.
