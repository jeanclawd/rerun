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
import { exportNotebook, exportIpynb as buildIpynb, parseNotebook, importLiveScript, looksLikeLiveScript } from './format.js';

/* Text/prose cells (kind: 'text') hold Markdown, render statically, and are
 * NOT executed — they are filtered out before buildGraph so the DAG analyzer
 * (dag.js) never sees them and stays code-only. Everything else is a code cell. */
const isText = (c) => c && c.kind === 'text';

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

  cells = (await loadFromUrl()) ?? load() ?? DEMO;
  renderAll();
  status('ready');
  enqueue(() => runIds(graph.order));   // first full run, topological
}

/* ------------------------------------------------------------ persistence */
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(
      cells.map((c) => ({ source: c.source, kind: c.kind || 'code' }))));
  } catch { }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.map((e) => (typeof e === 'string'
      ? { id: uid(), source: e, kind: 'code' }            // pre-text-cell format
      : { id: uid(), source: e.source, kind: e.kind || 'code' }));
  } catch { return null; }
}

/* Entry point mirroring the .rerun.m load path: ?livescript=<url> imports a
 * plain-text live-script .m; ?notebook=<url> loads a .rerun.m. Both are
 * fetched same-origin and fall back silently to localStorage/DEMO on failure. */
async function loadFromUrl() {
  try {
    const q = new URL(location.href).searchParams;
    const lsUrl = q.get('livescript') || q.get('ls');
    const nbUrl = q.get('notebook') || q.get('nb');
    if (lsUrl) return importLiveScript(await (await fetch(lsUrl)).text(), uid);
    if (nbUrl) return parseNotebook(await (await fetch(nbUrl)).text(), uid);
  } catch (e) { console.error('url load:', e); }
  return null;
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

  if (isText(c)) return textCellDom(c, root, head, num, badges, st);

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

/* A text/prose cell: rendered Markdown, double-click to edit the raw source in
 * a textarea, blur to re-render. Not executed; kept out of the DAG. */
function textCellDom(c, root, head, num, badges, st) {
  root.classList.add('text-cell');
  const view = div('cell-md');
  view.innerHTML = renderMarkdown(c.source);
  const ta = document.createElement('textarea');
  ta.className = 'cell-md-edit';
  ta.value = c.source; ta.spellcheck = false; ta.hidden = true;
  view.title = 'double-click to edit';
  view.addEventListener('dblclick', () => { view.hidden = true; ta.hidden = false; grow(ta); ta.focus(); });
  ta.addEventListener('input', () => { c.source = ta.value; grow(ta); save(); });
  ta.addEventListener('blur', () => {
    view.innerHTML = renderMarkdown(c.source); view.hidden = false; ta.hidden = true;
  });
  root.append(head, view, ta);
  meta.set(c.id, { root, num, badges, st, view, ta, isText: true });
  requestAnimationFrame(() => grow(ta));
  return root;
}

function grow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

/* --------------------------------------------------------- markdown (text cells)
 * A deliberately small block+inline Markdown renderer — no external library
 * (CSP-safe). Handles headings, lists, tables, links, bold/italic/mono, the
 * live-script <u> and <div align> passthrough, and images. HTML is escaped
 * before inline formatting so imported prose can't inject markup.
 * TODO(#11 Phase 3): LaTeX equations and inline embedded images. */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, (_, x) => `<code>${x}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/&lt;u&gt;/g, '<u>').replace(/&lt;\/u&gt;/g, '</u>');
}
function renderTableMd(rows) {
  const cellsOf = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((x) => x.trim());
  let h = '<table><thead><tr>';
  h += cellsOf(rows[0]).map((x) => `<th>${inlineMd(x)}</th>`).join('') + '</tr></thead><tbody>';
  for (let r = 2; r < rows.length; r++) {
    h += '<tr>' + cellsOf(rows[r]).map((x) => `<td>${inlineMd(x)}</td>`).join('') + '</tr>';
  }
  return h + '</tbody></table>';
}
function renderMarkdown(md) {
  const lines = String(md).split('\n');
  let html = '', i = 0, list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const isBlockStart = (t) => /^(#{1,6}\s|[-*]\s|\d+\.\s|\|)/.test(t) || /^<\/?div\b/.test(t) || /^!\[/.test(t);
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^<\/?div\b[^>]*>$/.test(t)) { closeList(); html += t.replace(/[^<>="/\w\s-]/g, ''); i++; continue; }
    if (t === '') { closeList(); i++; continue; }
    if (/^\|.*\|$/.test(t)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(lines[i].trim()); i++; }
      html += renderTableMd(rows); continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const l = h[1].length; html += `<h${l}>${inlineMd(h[2])}</h${l}>`; i++; continue; }
    const ul = t.match(/^[-*]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inlineMd(ul[1])}</li>`; i++; continue; }
    const ol = t.match(/^\d+\.\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inlineMd(ol[1])}</li>`; i++; continue; }
    const img = t.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) { closeList(); html += `<p><img alt="${escAttr(img[1])}" src="${escAttr(img[2])}"></p>`; i++; continue; }
    closeList();
    const para = [lines[i]]; i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i].trim())) { para.push(lines[i]); i++; }
    html += `<p>${inlineMd(para.join(' '))}</p>`;
  }
  closeList();
  return html;
}

function div(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

/** Rebuild the DAG and refresh numbers, badges, and graph-error banners. */
function refreshGraph() {
  graph = buildGraph(cells.filter((c) => !isText(c)));  // text cells stay out of the DAG
  cells.forEach((c, i) => {
    const m = meta.get(c.id);
    m.num.textContent = String(i + 1);
    if (isText(c)) {
      m.badges.innerHTML = '';
      m.badges.appendChild(span('badge text', '¶ text'));
      return;
    }
    const n = graph.nodes.get(c.id);
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
    `${graph.nodes.size} cells · ${[...graph.nodes.values()].reduce((s, n) => s + n.deps.size, 0)} edges`;
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
  const report = [];
  for (const id of order) {
    if (!cells.some((c) => c.id === id)) continue; // deleted mid-queue
    report.push(await runOne(id, libError));
  }
  refreshVariables();
  status('idle');
  return report;
}

async function runOne(id, libError = null) {
  const c = cells.find((x) => x.id === id);
  const m = meta.get(id);
  const n = graph.nodes.get(id);
  if ((graph.errors.get(id) ?? []).length) {
    setStatus(id, 'error');
    return { id, status: 'graph-error', errors: graph.errors.get(id) };
  }

  setStatus(id, 'running');
  status(`running cell ${cells.indexOf(c) + 1}…`);
  m.out.innerHTML = '';

  if (n.isFunctionCell) {
    // installed (or refused) by ensureLibrary before this loop
    if (libError) {
      m.out.appendChild(div('run-error', `${libError.identifier ?? 'error'}: ${libError.message}`));
      setStatus(id, 'error');
      m.prevDefs = new Set(n.defs);
      return { id, status: 'error', error: libError.message };
    }
    setStatus(id, 'ok', 'defined');
    m.prevDefs = new Set(n.defs);
    return { id, status: 'ok', note: 'function definitions installed' };
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
  m.figures = (r.figures ?? []).filter((f) => f.svg).map((f) => f.svg);
  m.stdout = [...m.out.querySelectorAll('pre.stdout')]
    .map((p) => p.textContent).join('\n').trim() || undefined;
  return {
    id,
    status: r.error ? 'error' : 'ok',
    ms: r.durationMs,
    stdout: pre.textContent.trim() || undefined,
    figures: m.figures.length || undefined,
    error: r.error ? `${r.error.identifier ?? r.error.kind}: ${r.error.message}` : undefined,
  };
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

function addTextCell(afterId = null) {
  const c = { id: uid(), source: '# text\n\ndouble-click to edit', kind: 'text' };
  const i = afterId ? cells.findIndex((x) => x.id === afterId) + 1 : cells.length;
  cells.splice(i, 0, c);
  renderAll();
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
  const text = exportNotebook(cells, graph);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = 'notebook.rerun.m';
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportIpynb() {
  const outputs = new Map();
  for (const c of cells) {
    const m = meta.get(c.id);
    if (m && (m.stdout || (m.figures && m.figures.length))) {
      outputs.set(c.id, { stdout: m.stdout, figures: m.figures });
    }
  }
  const text = buildIpynb(cells, graph, outputs);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = 'notebook.ipynb';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importM(text) {
  // one import affordance handles both: a plain-text live-script .m routes to
  // the live-script importer, a .rerun.m / plain %%-file to parseNotebook.
  cells = looksLikeLiveScript(text) ? importLiveScript(text, uid) : parseNotebook(text, uid);
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
$('add-text').addEventListener('click', () => addTextCell());
$('export').addEventListener('click', exportM);
$('export-ipynb').addEventListener('click', exportIpynb);
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

/* ------------------------------------------------------- pair ops API
 * The same verbs the pair MCP server exposes, executed against THIS tab's
 * live session — pair.js forwards relay frames here. Everything that runs
 * code goes through enqueue() so agent work serializes with user work. */
const api = {
  async notebook() {
    return {
      cells: cells.map((c, i) => {
        const n = graph.nodes.get(c.id);
        if (!n) return { id: c.id, page: i + 1, source: c.source, kind: 'text' };
        return {
          id: c.id, page: i + 1, source: c.source,
          defines: [...n.defs], uses: [...n.uses],
          isFunctionCell: n.isFunctionCell || undefined,
          graphErrors: graph.errors.get(c.id) ?? undefined,
        };
      }),
      executionOrder: graph.order,
      workspace: runner.workspace().map((v) => ({
        name: v.name, type: v.dtype ?? v.className,
        shape: v.shape?.join('×'), preview: v.preview?.slice(0, 8),
      })),
    };
  },

  async exec({ code }) {
    const probe = buildGraph([...cells.filter((c) => !isText(c)), { id: '__pad__', source: String(code) }]);
    const clash = probe.errors.get('__pad__');
    if (clash?.length) return { refused: clash };
    return enqueue(async () => {
      let streamed = '';
      const r = await runner.exec(String(code), {
        name: '<scratch>', onStream: ({ text }) => { streamed += text; },
      });
      refreshVariables();
      const displays = (r.displays ?? [])
        .map((d) => (d.label ? `${d.label} = ${d.text}` : d.text))
        .filter((t) => t && !streamed.includes(String(t).trim()));
      return {
        ok: !r.error,
        stdout: (streamed + displays.join('\n')).trim(),
        error: r.error ? `${r.error.identifier ?? r.error.kind}: ${r.error.message}` : undefined,
        workspace: runner.workspace().map((v) => v.name),
      };
    });
  },

  async apply({ ops }) {
    const proposed = cells.map((c) => ({ ...c }));
    const touched = [];
    const deletedDefs = [];
    const deletedIds = [];
    for (const op of ops ?? []) {
      if (op.kind === 'create') {
        const c = { id: uid(), source: String(op.source ?? '') };
        const at = op.after ? proposed.findIndex((x) => x.id === op.after) + 1 : proposed.length;
        proposed.splice(at < 1 ? proposed.length : at, 0, c);
        touched.push(c.id);
      } else if (op.kind === 'edit') {
        const c = proposed.find((x) => x.id === op.id);
        if (!c) return { rejected: [`edit: no such cell '${op.id}'`] };
        c.source = String(op.source ?? '');
        touched.push(c.id);
      } else if (op.kind === 'delete') {
        const i = proposed.findIndex((x) => x.id === op.id);
        if (i < 0) return { rejected: [`delete: no such cell '${op.id}'`] };
        deletedIds.push(op.id);
        deletedDefs.push(...(graph.nodes.get(op.id)?.defs ?? []));
        proposed.splice(i, 1);
      } else {
        return { rejected: [`unknown op kind '${op.kind}'`] };
      }
    }
    const g = buildGraph(proposed.filter((c) => !isText(c)));
    if (g.errors.size) {
      const rejected = [];
      for (const [cid, msgs] of g.errors) for (const m of msgs) rejected.push(`cell ${cid}: ${m}`);
      return { rejected, note: 'batch rejected — notebook unchanged' };
    }
    return enqueue(async () => {
      const oldGraph = graph;
      const affected = new Set(touched);
      for (const did of deletedIds) for (const d of oldGraph.descendantsOf(did)) affected.add(d);
      cells = proposed;
      for (const did of deletedIds) meta.delete(did);
      renderAll();
      if (deletedDefs.length) await runner.exec(`clear ${deletedDefs.join(' ')};`, { name: '<clear>' });
      for (const id of touched) for (const d of graph.descendantsOf(id)) affected.add(d);
      const report = await runIds([...affected].filter((id) => cells.some((c) => c.id === id)));
      save();
      return { applied: (ops ?? []).length, report, executionOrder: graph.order };
    });
  },

  async read_variable({ name, maxElements = 100 }) {
    try {
      const v = await session.materializeVariable(
        { name: String(name) }, { maxElements: Math.min(Number(maxElements) || 100, 4096) });
      return { name, shape: v?.shape, values: v?.preview?.values, truncated: v?.preview?.truncated };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  },

  async read_figure({ id }) {
    const svgs = meta.get(String(id))?.figures;
    if (!svgs) return { error: `no figures recorded for cell '${id}'` };
    return { id, count: svgs.length, svgs };
  },

  async export_m() {
    return { source: exportNotebook(cells, graph) };
  },
};

await boot();
window.__rerun = { get cells() { return cells; }, get graph() { return graph; }, commit, runner: () => runner, api };

const { initPair } = await import(/* @vite-ignore */ `./pair.js?v=${document.body.dataset.v ?? ''}`);
initPair(api);
