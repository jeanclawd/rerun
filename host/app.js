/* ReRun — a reactive MATLAB notebook on RunMat, marimo-style.
 *
 * One persistent wasm session holds the workspace. Cells form a dependency
 * DAG (dag.js); running a cell runs it and its transitive dependents in
 * topological order. Page order is presentation; the graph decides execution.
 *
 * No hidden state: when a cell stops defining a variable (edit or delete),
 * the variable is cleared from the workspace before anything reruns, so
 * downstream cells fail honestly instead of feeding on ghosts.
 *
 * Function cells are installed by a separate guarded exec (see ensureLibrary)
 * because RunMat 0.6.1 misbehaves when function defs ride along with a script
 * — details at the ensureLibrary comment.
 */

import { buildGraph } from './dag.js';
import { SessionRunner } from './session-core.mjs';

const $ = (id) => document.getElementById(id);
const RUNTIME = '/streamlab/runtime'; // shared 52 MB wasm build, same origin
const STORE = 'rerun-notebook-v1';

const DEMO = [
  'f = 3;          % frequency — edit me and watch everything below react',
  't = linspace(0, 2*pi, 400);',
  'y = sin(f*t) .* exp(-t/4);',
  "plot(t, y);\ntitle(sprintf('damped sine, f = %d', f));\nxlabel('t');",
  'peak = max(y)',
  "function s = describe(v)\n  s = sprintf('%d samples, mean %.3f', numel(v), mean(v));\nend",
  'summary = describe(y)',
].map((source) => ({ id: uid(), source }));

function uid() {
  return 'c' + Math.random().toString(36).slice(2, 9);
}

/* ------------------------------------------------------------------ state */
let cells = [];               // [{id, source}] in page order
const meta = new Map();       // id -> {prevDefs, status, node DOM refs}
let graph = null;
let session = null;
let runner = null;
let autoRun = true;
let runChain = Promise.resolve();   // serialize all execution
let streamTarget = null;            // cell id currently receiving stdout

/* ------------------------------------------------------------------- boot */
async function boot() {
  status('loading RunMat…');
  const web = await import(/* @vite-ignore */ `${RUNTIME}/runmat_wasm_web.js`);
  await web.default({ module_or_path: `${RUNTIME}/runmat_wasm_web_bg.wasm` });
  session = await web.initRunMat({
    enableGpu: false, enableJit: false, telemetryConsent: false,
    logLevel: 'error', languageCompat: 'matlab',
  });
  runner = new SessionRunner(session, { figureWidth: 640, figureHeight: 400 });
  try { await web.subscribeStdout((e) => runner.feedStdout(e)); } catch { /* stdout arrives in results */ }

  cells = load() ?? DEMO;
  renderAll();
  status('ready');
  enqueue(() => runIds(graph.order));   // first full run, topological
}

/* ------------------------------------------------------------ persistence */
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(cells.map((c) => c.source))); } catch { }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const sources = JSON.parse(raw);
    if (!Array.isArray(sources) || !sources.length) return null;
    return sources.map((source) => ({ id: uid(), source }));
  } catch { return null; }
}

/* -------------------------------------------------------------- rendering */
function renderAll() {
  const host = $('cells');
  host.innerHTML = '';
  for (const c of cells) host.appendChild(cellDom(c));
  refreshGraph();
}

function cellDom(c) {
  const root = div('cell');
  root.dataset.id = c.id;

  const head = div('cell-head');
  const num = div('cell-num');
  const badges = div('cell-badges');
  const st = div('cell-status');
  st.dataset.s = 'idle';
  const tools = div('cell-tools');
  for (const [label, title, fn] of [
    ['▶', 'run this cell and its dependents (Ctrl+Enter)', () => commit(c.id)],
    ['↑', 'move up (page order only)', () => move(c.id, -1)],
    ['↓', 'move down (page order only)', () => move(c.id, +1)],
    ['＋', 'add a cell below', () => addCell(c.id)],
    ['✕', 'delete cell (its variables are cleared)', () => removeCell(c.id)],
  ]) {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    b.addEventListener('click', fn);
    tools.appendChild(b);
  }
  head.append(num, badges, st, tools);

  const ta = document.createElement('textarea');
  ta.value = c.source;
  ta.spellcheck = false;
  ta.rows = 1;
  ta.addEventListener('input', () => {
    c.source = ta.value;
    grow(ta);
    save();
    onEdit(c.id);
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit(c.id); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const [s, epos] = [ta.selectionStart, ta.selectionEnd];
      ta.setRangeText('    ', s, epos, 'end');
      c.source = ta.value; save();
    }
  });

  const gerr = div('cell-graph-errors');
  const out = div('cell-out');
  root.append(head, ta, gerr, out);

  meta.set(c.id, { prevDefs: meta.get(c.id)?.prevDefs ?? new Set(), root, num, badges, st, ta, gerr, out });
  requestAnimationFrame(() => grow(ta));
  return root;
}

function grow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

function div(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

/** Rebuild the DAG and refresh numbers, badges, and graph-error banners. */
function refreshGraph() {
  graph = buildGraph(cells);
  cells.forEach((c, i) => {
    const m = meta.get(c.id);
    const n = graph.nodes.get(c.id);
    m.num.textContent = String(i + 1);
    m.badges.innerHTML = '';
    if (n.isFunctionCell) m.badges.appendChild(span('badge fn', `ƒ ${[...n.funcs].join(', ')}`));
    else if (n.defs.size) m.badges.appendChild(span('badge def', `→ ${[...n.defs].join(', ')}`));
    if (n.uses.size) m.badges.appendChild(span('badge use', `← ${[...n.uses].join(', ')}`));
    const errs = graph.errors.get(c.id) ?? [];
    m.gerr.innerHTML = '';
    for (const e of errs) m.gerr.appendChild(div('graph-error', e));
    m.root.classList.toggle('has-graph-error', errs.length > 0);
  });
  $('dag-stat').textContent =
    `${cells.length} cells · ${[...graph.nodes.values()].reduce((s, n) => s + n.deps.size, 0)} edges`;
  save();
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls; s.textContent = text;
  return s;
}

/* -------------------------------------------------------------- reactivity */
let editTimer = null;

function onEdit(id) {
  refreshGraph();
  setStatus(id, 'stale');
  for (const d of graph.descendantsOf(id)) setStatus(d, 'stale');
  if (autoRun) {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => commit(id), 700);
  }
}

/** Run a cell and everything downstream of it. */
function commit(id) {
  clearTimeout(editTimer);
  refreshGraph();
  const ids = [id, ...graph.descendantsOf(id)];
  enqueue(() => runIds(ids));
}

function enqueue(job) {
  runChain = runChain.then(job).catch((e) => console.error('run chain:', e));
  return runChain;
}

/* Function cells are installed by a separate, guarded exec — two RunMat 0.6.1
 * quirks force this shape (probed live, both absent from plain execs):
 *   - a source that appends function defs to a script ECHOES suppressed
 *     assignments (`x = 1;` prints anyway)
 *   - a source that is ONLY function defs is treated as a function file and
 *     WIPES the workspace
 * So: `if false, end` makes the library exec a script (no wipe, no echo), and
 * ordinary cells run bare. Functions persist across plain execs; only an exec
 * containing function defs replaces the installed set. */
let installedLib = null;

function functionLibrary() {
  return cells
    .filter((c) => graph.nodes.get(c.id)?.isFunctionCell)
    .map((c) => c.source)
    .join('\n\n');
}

async function ensureLibrary() {
  const lib = functionLibrary();
  if (lib === installedLib) return null;
  const code = lib
    ? `if false, end\n\n${lib}`
    : 'if false, end\n\nfunction __rerun_noop__()\nend'; // replace set with a stub
  const r = await runner.exec(code, { name: '<functions>' });
  installedLib = r.error ? null : lib;
  return r.error;
}

async function runIds(ids) {
  const order = graph.order.filter((x) => ids.includes(x));
  for (const id of order) setStatus(id, 'queued');
  const libError = await ensureLibrary();
  for (const id of order) {
    if (!cells.some((c) => c.id === id)) continue; // deleted mid-queue
    await runOne(id, libError);
  }
  refreshVariables();
  status('idle');
}

async function runOne(id, libError = null) {
  const c = cells.find((x) => x.id === id);
  const m = meta.get(id);
  const n = graph.nodes.get(id);
  if ((graph.errors.get(id) ?? []).length) { setStatus(id, 'error'); return; }

  setStatus(id, 'running');
  status(`running cell ${cells.indexOf(c) + 1}…`);
  m.out.innerHTML = '';

  if (n.isFunctionCell) {
    // installed (or refused) by ensureLibrary before this loop
    if (libError) {
      m.out.appendChild(div('run-error', `${libError.identifier ?? 'error'}: ${libError.message}`));
      setStatus(id, 'error');
    } else {
      setStatus(id, 'ok', 'defined');
    }
    m.prevDefs = new Set(n.defs);
    return;
  }

  const pre = document.createElement('pre');
  pre.className = 'stdout';
  m.out.appendChild(pre);

  // no hidden state: names this cell used to define but no longer does
  const gone = [...m.prevDefs].filter((v) => !n.defs.has(v));
  const clearStmt = gone.length ? `clear ${gone.join(' ')};\n` : '';

  const code = `${clearStmt}${c.source}`;

  streamTarget = id;
  const r = await runner.exec(code, {
    name: `<cell ${cells.indexOf(c) + 1}>`,
    onStream: ({ text }) => {
      if (streamTarget === id) { pre.textContent += text; pre.hidden = !pre.textContent.trim(); }
    },
  });
  streamTarget = null;

  pre.hidden = !pre.textContent.trim();
  for (const d of r.displays) {
    if (d.text && !pre.textContent.includes(String(d.text).trim())) {
      const p = document.createElement('pre');
      p.className = 'stdout';
      p.textContent = d.label ? `${d.label} = ${d.text}` : String(d.text);
      m.out.appendChild(p);
    }
  }
  for (const f of r.figures) {
    if (!f.svg) continue;
    const box = div('figure');
    box.innerHTML = f.svg;
    m.out.appendChild(box);
  }
  if (r.error) {
    const eb = div('run-error',
      `${r.error.identifier ?? r.error.kind}: ${r.error.message}` +
      (r.error.line ? ` (line ${r.error.line})` : ''));
    m.out.appendChild(eb);
    setStatus(id, 'error');
  } else {
    setStatus(id, 'ok', `${r.durationMs} ms`);
  }
  m.prevDefs = new Set(n.defs);
}

function setStatus(id, s, detail = '') {
  const m = meta.get(id);
  if (!m) return;
  m.st.dataset.s = s;
  m.st.textContent = { idle: '', stale: 'stale', queued: 'queued', running: 'running', ok: detail, error: 'error' }[s] ?? s;
}

/* --------------------------------------------------------- cell operations */
function addCell(afterId = null) {
  const c = { id: uid(), source: '' };
  const i = afterId ? cells.findIndex((x) => x.id === afterId) + 1 : cells.length;
  cells.splice(i, 0, c);
  renderAll();
  meta.get(c.id).ta.focus();
}

function removeCell(id) {
  const wasDefs = [...(graph.nodes.get(id)?.defs ?? [])];
  const downstream = graph.descendantsOf(id);
  cells = cells.filter((c) => c.id !== id);
  meta.delete(id);
  renderAll();
  enqueue(async () => {
    if (wasDefs.length) await runner.exec(`clear ${wasDefs.join(' ')};`, { name: '<clear>' });
    await runIds(downstream.filter((d) => cells.some((c) => c.id === d)));
  });
}

function move(id, delta) {
  const i = cells.findIndex((c) => c.id === id);
  const j = i + delta;
  if (j < 0 || j >= cells.length) return;
  [cells[i], cells[j]] = [cells[j], cells[i]];
  renderAll(); // page order only — the DAG decides execution, nothing reruns
}

/* --------------------------------------------------------- variables panel */
function refreshVariables() {
  const tbody = $('vars');
  tbody.innerHTML = '';
  const ownerOf = new Map();
  cells.forEach((c, i) => {
    for (const d of graph.nodes.get(c.id)?.defs ?? []) ownerOf.set(d, i + 1);
  });
  for (const v of runner.workspace()) {
    const tr = document.createElement('tr');
    const preview = v.preview
      ? v.preview.map((x) => (Number.isInteger(x) ? x : Number(x).toPrecision(4))).join(' ') +
        (v.previewTruncated ? ' …' : '')
      : '';
    const shape = v.shape?.length ? v.shape.join('×') : '';
    for (const text of [v.name, preview, `${shape} ${v.dtype ?? v.className ?? ''}`.trim(),
                        ownerOf.has(v.name) ? `#${ownerOf.get(v.name)}` : '']) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

/* ----------------------------------------------------------- file handling */
function exportM() {
  const order = graph.order; // topological → the export runs top-to-bottom in plain MATLAB
  const script = order
    .filter((id) => !graph.nodes.get(id).isFunctionCell)
    .map((id, i) => `%% cell ${i + 1}\n${cells.find((c) => c.id === id).source}`)
    .join('\n\n');
  const fns = order
    .filter((id) => graph.nodes.get(id).isFunctionCell)
    .map((id) => cells.find((c) => c.id === id).source)
    .join('\n\n');
  const text = `% exported by ReRun — cells in dependency order, runs top-to-bottom\n\n${script}${fns ? '\n\n' + fns : ''}\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = 'notebook.m';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importM(text) {
  const parts = text.split(/^\s*%%[^\n]*$/m).map((s) => s.trim()).filter(Boolean);
  cells = (parts.length ? parts : [text.trim()]).map((source) => ({ id: uid(), source }));
  meta.clear();
  renderAll();
  enqueue(async () => {
    await session.resetSession();
    runner.clear();
    installedLib = null;
    await runIds(graph.order);
  });
}

/* ------------------------------------------------------------------- shell */
function status(t) { $('status').textContent = t; }

$('run-all').addEventListener('click', () => { refreshGraph(); enqueue(() => runIds(graph.order)); });
$('add-cell').addEventListener('click', () => addCell());
$('export').addEventListener('click', exportM);
$('import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) importM(await f.text());
  e.target.value = '';
});
$('auto').addEventListener('change', (e) => { autoRun = e.target.checked; });
$('reset').addEventListener('click', () => {
  if (!confirm('Reset to the demo notebook? Your cells are replaced.')) return;
  localStorage.removeItem(STORE);
  cells = DEMO.map((c) => ({ id: uid(), source: c.source }));
  meta.clear();
  renderAll();
  enqueue(async () => {
    await session.resetSession();
    runner.clear();
    installedLib = null;
    await runIds(graph.order);
  });
});

await boot();
window.__rerun = { get cells() { return cells; }, get graph() { return graph; }, commit, runner: () => runner };
