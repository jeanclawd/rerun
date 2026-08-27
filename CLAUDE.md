# CLAUDE.md

Guidance for Claude Code (and any contributor) working in the ReRun repo.

## What this is

ReRun is a marimo-like **reactive notebook** that runs `.m` code in the browser
on the [RunMat](https://github.com/runmat-org/runmat) wasm runtime. Cells form a
dependency DAG (`host/dag.js`); editing a cell reruns exactly its transitive
dependents. See `README.md` for the full model, `host/format.js` for the
`.rerun.m` ⇄ cells serializer, and `host/livescript.js` for the plain-text
live-script importer.

## Naming rigor (enforced)

- **Do not write "MATLAB" in prose** — comments, docs, UI strings, examples,
  commit messages, PR text. Refer to the language as **`.m` files** / **the
  `.m` language**, and to the engine as **the RunMat runtime**.
- **Functional identifiers and API values are exempt** — do not rename them:
  e.g. the RunMat `languageCompat: 'matlab'` config value, a kernelspec's
  `language: 'matlab'`, the `MATLAB_ORDER` constant, the `matlabCodeExample`
  fence token, and the MathWorks format-spec URLs are external/functional
  literals and stay as-is.
- **Trademark disclaimer** lives exactly once, at the bottom of `README.md`:
  > RunMat™ is a registered trademark of Dystr, Inc. MATLAB® is a registered trademark of The MathWorks, Inc. ReRun is not affiliated with, endorsed by, or sponsored by Dystr, Inc or The MathWorks, Inc.

  (This is the only place the trademarked word appears, and it appears as a
  trademark acknowledgement, not as a description of the project.)

## Tests

```bash
node test/dag.test.mjs
node test/format.test.mjs
node test/livescript.test.mjs
```

Do not deploy from an agent session — `deploy.sh` writes the live `/rerun/`
site. Verify locally with the tests and `node --check` on edited modules.
