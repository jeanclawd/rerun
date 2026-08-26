#!/usr/bin/env node
/* ReRun pair — agent-as-MCP prototype.
 *
 * An MCP server (stdio, JSON-RPC 2.0, protocol 2024-11-05) that owns a live
 * headless RunMat session plus a ReRun notebook (cells + DAG), so ANY
 * MCP-capable harness — Claude Code, Codex, opencode, Cursor, Pydantic AI —
 * can pair with a reactive MATLAB notebook. This is the substrate-eval
 * conclusion applied: "an MCP server is a process you own, so it can hold the
 * real objects while staying reachable from every harness." Here the real
 * objects are the wasm session and the dependency graph.
 *
 * marimo-pair semantics, two verbs:
 *   exec   — scratchpad MATLAB in the live session; traceless, workspace in scope
 *   apply  — transactional batch of cell ops; dag.js validates the whole batch
 *            (duplicate defs, cycles, cross-cell mutation) BEFORE anything
 *            runs; any violation rejects the batch untouched, marimo-style.
 *            On success: changed cells + descendants rerun reactively,
 *            per-cell report returned.
 *
 * Hand-rolled MCP (no SDK dep) — three methods is all the protocol needs here.
 * Run: node pair/mcp/server.mjs   (RUNMAT_PKG overrides the runtime location)
 * Bridge auth: --token-file <path> or RERUN_PAIR_TOKEN env var, in preference to --token.
 */

import { createInterface } from 'node:readline';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { buildGraph } from '../../host/dag.js';
import { SessionRunner } from '../../host/session-core.mjs';
import { exportNotebook, parseNotebook } from '../../host/format.js';

/* ---------------------------------------------------------------- CLI args
 * headless (default):  server.mjs [--notebook nb.rerun.m]
 * relay bridge:        server.mjs --relay wss://…/rerun/pair --session S --token T
 * In bridge mode there is no local session: every tool call is forwarded to
 * the paired browser tab, which executes in ITS live session — the human
 * watches the agent work.
 *
 * The token is a bearer credential (exec access to a live session) and the
 * pairing string is meant to be handed off, so --token on the command line
 * — argv ends up in shell history and is readable via /proc/<pid>/cmdline —
 * is the least private option. Prefer --token-file <path> or the
 * RERUN_PAIR_TOKEN env var; --token is kept for the header's quick-copy
 * command and one-off use. */
const ARGS = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) ARGS[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
const BRIDGE = !!ARGS.relay;

function resolveToken() {
  if (typeof ARGS.token === 'string') return ARGS.token;
  if (typeof ARGS['token-file'] === 'string') return readFileSync(ARGS['token-file'], 'utf8').trim();
  if (process.env.RERUN_PAIR_TOKEN) return process.env.RERUN_PAIR_TOKEN;
  return null;
}

/* ------------------------------------------------------- session bootstrap */
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
globalThis.location ??= new URL(pathToFileURL(process.cwd() + '/'));
globalThis.performance ??= (await import('node:perf_hooks')).performance;
if (!globalThis.crypto?.getRandomValues) globalThis.crypto = (await import('node:crypto')).webcrypto;
console.log = (...a) => console.error(...a); // stdout is protocol-only
console.info = (...a) => console.error(...a);

let session = null;
let runner = null;
if (!BRIDGE) {
  const PKG = process.env.RUNMAT_PKG ??
    '/root/Projects/runmat-jupyter/host/node_modules/runmat/dist/pkg-web';
  const entry = resolve(PKG, 'runmat_wasm_web.js');
  if (!existsSync(entry)) {
    console.error(`RunMat wasm runtime not found at ${PKG}`);
    console.error(
      "Set RUNMAT_PKG to your runmat 'dist/pkg-web' directory " +
      '(the one containing runmat_wasm_web.js and runmat_wasm_web_bg.wasm).'
    );
    process.exit(1);
  }
  const web = await import(pathToFileURL(entry).href);
  await web.default({ module_or_path: await readFile(resolve(PKG, 'runmat_wasm_web_bg.wasm')) });
  session = await web.initRunMat({
    enableGpu: false, enableJit: false, telemetryConsent: false,
    logLevel: 'error', language: { compat: 'matlab' },
  });
  runner = new SessionRunner(session, { figureWidth: 640, figureHeight: 400 });
  try { await web.subscribeStdout((e) => runner.feedStdout(e)); } catch { /* results carry stdout */ }
}

/* ------------------------------------------------------------- notebook */
let cells = [];                    // [{id, source}] page order
let graph = buildGraph(cells);
const cellFigures = new Map();     // id -> [svg] from the cell's last run
const NB_FILE = ARGS.notebook ? resolve(String(ARGS.notebook)) : null;
// A stable identifier so a harness can tell paired sessions apart: the relay
// session id in bridge mode, else the notebook filename headless, else a default.
const TITLE = BRIDGE ? String(ARGS.session ?? 'bridge')
  : (NB_FILE ? basename(NB_FILE) : 'untitled');
if (!BRIDGE && NB_FILE && existsSync(NB_FILE)) {
  cells = parseNotebook(await readFile(NB_FILE, 'utf8'));
  graph = buildGraph(cells);
}
async function persist() {
  if (NB_FILE) await writeFile(NB_FILE, exportNotebook(cells, graph));
}
const prevDefs = new Map();        // id -> Set(names) for no-hidden-state clears
let installedLib = null;
let seq = 0;
const uid = () => `c${(++seq).toString(36).padStart(3, '0')}`;

function functionLibrary() {
  return cells.filter((c) => graph.nodes.get(c.id)?.isFunctionCell)
    .map((c) => c.source).join('\n\n');
}

// F16/F17 workaround: install functions via a guarded script exec.
async function ensureLibrary() {
  const lib = functionLibrary();
  if (lib === installedLib) return null;
  const code = lib
    ? `if false, end\n\n${lib}`
    : 'if false, end\n\nfunction __rerun_noop__()\nend';
  const r = await runner.exec(code, { name: '<functions>' });
  installedLib = r.error ? null : lib;
  return r.error;
}

async function runCell(id) {
  const c = cells.find((x) => x.id === id);
  const n = graph.nodes.get(id);
  if ((graph.errors.get(id) ?? []).length) {
    return { id, status: 'graph-error', errors: graph.errors.get(id) };
  }
  if (n.isFunctionCell) {
    prevDefs.set(id, new Set(n.defs));
    return { id, status: 'ok', note: 'function definitions installed' };
  }
  const gone = [...(prevDefs.get(id) ?? [])].filter((v) => !n.defs.has(v));
  const clearStmt = gone.length ? `clear ${gone.join(' ')};\n` : '';
  const r = await runner.exec(`${clearStmt}${c.source}`, { name: `<${id}>` });
  prevDefs.set(id, new Set(n.defs));
  cellFigures.set(id, (r.figures ?? []).filter((f) => f.svg).map((f) => f.svg));
  return {
    id,
    status: r.error ? 'error' : 'ok',
    ms: r.durationMs,
    stdout: (r.displays ?? []).map((d) => (d.label ? `${d.label} = ${d.text}` : d.text)).join('\n') || undefined,
    figures: (r.figures ?? []).filter((f) => f.svg).length || undefined,
    error: r.error ? `${r.error.identifier ?? r.error.kind}: ${r.error.message}` : undefined,
  };
}

async function runInOrder(ids) {
  const libError = await ensureLibrary();
  if (libError) return [{ status: 'error', error: `function install failed: ${libError.message}` }];
  const order = graph.order.filter((x) => ids.includes(x));
  const report = [];
  for (const id of order) report.push(await runCell(id));
  return report;
}

function notebookView() {
  return {
    title: TITLE,
    session: BRIDGE ? String(ARGS.session ?? '') : undefined,
    cells: cells.map((c, i) => {
      const n = graph.nodes.get(c.id);
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
}

/* --------------------------------------------------------- SVG → PNG raster
 * read_figure can hand back a raster instead of SVG, so a phone/chat client
 * (Telegram shows SVG as a file, PNG as a photo) gets a real preview. We shell
 * out to the box's headless Chrome — zero new npm deps — writing the SVG to a
 * temp file and screenshotting it. On any failure the caller falls back to SVG. */
const execFileP = promisify(execFile);
const CHROME = process.env.RERUN_CHROME || '/usr/bin/google-chrome';

/** Derive pixel size from the SVG's viewBox or width/height attrs. */
function svgSize(svg) {
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(svg);
  if (vb) return { w: Math.round(+vb[1]) || 800, h: Math.round(+vb[2]) || 600 };
  const w = /\bwidth\s*=\s*["']([\d.]+)/.exec(svg);
  const h = /\bheight\s*=\s*["']([\d.]+)/.exec(svg);
  if (w && h) return { w: Math.round(+w[1]) || 800, h: Math.round(+h[1]) || 600 };
  return { w: 800, h: 600 };
}

/** Rasterize one SVG string to PNG bytes via headless Chrome. */
async function svgToPng(svg) {
  if (!existsSync(CHROME)) return { error: `raster unavailable: ${CHROME} not found` };
  const { w, h } = svgSize(svg);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const svgPath = resolve(tmpdir(), `rerun-fig-${stamp}.svg`);
  const pngPath = resolve(tmpdir(), `rerun-fig-${stamp}.png`);
  try {
    await writeFile(svgPath, svg, 'utf8');
    await execFileP(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      `--screenshot=${pngPath}`, `--window-size=${w},${h}`,
      '--default-background-color=00000000', '--virtual-time-budget=2000',
      pathToFileURL(svgPath).href,
    ], { timeout: 30_000 });
    const bytes = await readFile(pngPath);
    if (!bytes.length) return { error: 'raster produced an empty PNG' };
    return { base64: bytes.toString('base64'), width: w, height: h };
  } catch (e) {
    return { error: `raster failed: ${String(e?.message ?? e)}` };
  } finally {
    unlink(svgPath).catch(() => {});
    unlink(pngPath).catch(() => {});
  }
}

/* ------------------------------------------------------------------ tools */
const TOOLS = [
  {
    name: 'notebook',
    description: 'Current notebook: cells (id, source, defines/uses, graph errors), the topological execution order, and the live workspace with previews. Call this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'exec',
    description: "Scratchpad: run MATLAB in the live session WITHOUT touching the notebook. Notebook variables are in scope. Use for inspection (size(x), x(1:5), fieldnames(s)) and trying ideas. Prefix throwaway variables with pad_. Assigning to a notebook-owned variable is refused.",
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'MATLAB source' } },
      required: ['code'],
    },
  },
  {
    name: 'apply',
    description: 'Transactional batch of notebook edits. Ops: {kind:"create", source, after?}, {kind:"edit", id, source}, {kind:"delete", id}. The whole batch is validated against the dependency graph first (one defining cell per variable, no cycles, no mutating another cell\'s variable); ANY violation rejects the batch untouched. On success, changed cells and their transitive dependents rerun in dependency order and a per-cell report is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['create', 'edit', 'delete'] },
              id: { type: 'string' },
              after: { type: 'string' },
              source: { type: 'string' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'read_variable',
    description: 'Materialize a workspace variable beyond the snapshot preview.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        maxElements: { type: 'number', description: 'default 100, cap 4096' },
      },
      required: ['name'],
    },
  },
  {
    name: 'read_figure',
    description: "The figure(s) a cell produced on its last run. format:'svg' (default) returns SVG markup; format:'png' returns a base64 PNG raster (better for phone/chat preview).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'cell id' },
        format: { type: 'string', enum: ['svg', 'png'], description: "output format, default 'svg'" },
      },
      required: ['id'],
    },
  },
  {
    name: 'export_m',
    description: 'The notebook as a plain MATLAB script: %% ⟳-tagged sections in dependency order, function cells last, page-order footer. Runs top-to-bottom in any MATLAB; re-imports into ReRun exactly.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const handlers = {
  async notebook() { return notebookView(); },

  async exec({ code }) {
    // guard: scratch must not assign notebook-owned names
    const probe = buildGraph([...cells, { id: '__pad__', source: String(code) }]);
    const clash = probe.errors.get('__pad__');
    if (clash?.length) return { refused: clash };
    let streamed = '';
    const r = await runner.exec(String(code), {
      name: '<scratch>', onStream: ({ text }) => { streamed += text; },
    });
    const displayLines = (r.displays ?? [])
      .map((d) => (d.label ? `${d.label} = ${d.text}` : d.text))
      .filter((x) => x && !streamed.includes(String(x).trim()));
    return {
      ok: !r.error,
      stdout: (streamed + displayLines.join('\n')).trim(),
      figures: (r.figures ?? []).filter((f) => f.svg).length,
      error: r.error ? `${r.error.identifier ?? r.error.kind}: ${r.error.message}` : undefined,
      workspace: runner.workspace().map((v) => v.name),
    };
  },

  async apply({ ops }) {
    // build the proposed cell list
    const proposed = cells.map((c) => ({ ...c }));
    const touched = [];
    const deletedDefs = [];
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
        deletedDefs.push(...(graph.nodes.get(op.id)?.defs ?? []));
        proposed.splice(i, 1);
      } else {
        return { rejected: [`unknown op kind '${op.kind}'`] };
      }
    }

    // all-or-nothing validation, marimo-style
    const g = buildGraph(proposed);
    if (g.errors.size) {
      const rejected = [];
      for (const [id, msgs] of g.errors) {
        for (const m of msgs) rejected.push(`cell ${id}: ${m}`);
      }
      return { rejected, note: 'batch rejected — notebook unchanged' };
    }

    // commit
    const oldGraph = graph;
    const affected = new Set(touched);
    for (const op of ops.filter((o) => o.kind === 'delete')) {
      for (const d of oldGraph.descendantsOf(op.id)) affected.add(d);
    }
    cells = proposed;
    graph = g;
    for (const id of touched) {
      for (const d of graph.descendantsOf(id)) affected.add(d);
    }
    if (deletedDefs.length) {
      await runner.exec(`clear ${deletedDefs.join(' ')};`, { name: '<clear>' });
    }
    const report = await runInOrder([...affected].filter((id) => cells.some((c) => c.id === id)));
    await persist();
    return { applied: ops.length, report, executionOrder: graph.order };
  },

  async read_figure({ id, format = 'svg' }) {
    const svgs = cellFigures.get(String(id));
    if (!svgs) return { error: `no figures recorded for cell '${id}'` };
    if (String(format).toLowerCase() !== 'png') return { id, format: 'svg', count: svgs.length, svgs };
    // rasterize each SVG; on failure fall back to SVG with a note rather than throwing
    const images = [];
    for (const svg of svgs) {
      const r = await svgToPng(svg);
      if (r.error) return { id, format: 'svg', count: svgs.length, svgs, note: `png unavailable — ${r.error}` };
      images.push({ image_base64: r.base64, width: r.width, height: r.height });
    }
    return {
      id, format: 'png', count: images.length,
      images_base64: images.map((im) => im.image_base64),
      image_base64: images[0]?.image_base64,
      width: images[0]?.width, height: images[0]?.height,
      images,
    };
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

  async export_m() {
    return { source: exportNotebook(cells, graph), file: NB_FILE ?? undefined };
  },
};

/* -------------------------------------------------------------- bridge mode
 * Forward every tool call over the relay to the paired browser tab. Node 22's
 * native WebSocket client — no dependency. */
let tabCall = null;
if (BRIDGE) {
  const token = resolveToken();
  if (!ARGS.session || !token) {
    console.error(
      'bridge mode needs --session and a token — pass --token, --token-file <path>, ' +
      'or set RERUN_PAIR_TOKEN (session/token shown in the ReRun tab header)'
    );
    process.exit(2);
  }
  const ws = new WebSocket(String(ARGS.relay));
  const pendingTab = new Map();
  let wsSeq = 0;
  const ready = new Promise((res, rej) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ role: 'agent', session: ARGS.session, token }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'registered') { res(); return; }
      if (m.type === 'refused') {
        // A relay refusal otherwise reaches the client only as CONNECTION_CLOSED.
        // Make it diagnosable: a greppable stderr line, an optional state file a
        // health check can read, and a distinct exit code (3 = refused).
        const reason = m.reason ?? 'unknown reason';
        console.error(`PAIR REFUSED: ${reason}`);
        if (process.env.RERUN_PAIR_STATE) {
          try {
            writeFileSync(process.env.RERUN_PAIR_STATE,
              JSON.stringify({ state: 'refused', reason, session: ARGS.session ?? null, ts: Date.now() }));
          } catch { /* best-effort */ }
        }
        rej(new Error(`PAIR REFUSED: ${reason}`));
        process.exit(3);
      }
      if (m.type === 'tab-gone') {
        for (const [, cb] of pendingTab) cb({ error: 'the paired tab disconnected' });
        pendingTab.clear();
        return;
      }
      if (m.id !== undefined && pendingTab.has(m.id)) {
        pendingTab.get(m.id)(m.result ?? { error: m.error ?? 'empty reply' });
        pendingTab.delete(m.id);
      }
    };
    ws.onerror = () => rej(new Error(`cannot reach relay ${ARGS.relay}`));
    ws.onclose = () => rej(new Error('relay connection closed'));
  });
  await ready;
  console.error(`bridged to tab (session ${ARGS.session})`);
  tabCall = (name, args) => new Promise((res) => {
    const id = ++wsSeq;
    pendingTab.set(id, res);
    setTimeout(() => {
      if (pendingTab.delete(id)) res({ error: `tab did not answer '${name}' within 120s` });
    }, 120_000);
    ws.send(JSON.stringify({ id, type: 'tool', name, args }));
  });
}

// headless with a loaded notebook: bring the workspace up to the file
if (!BRIDGE && cells.length) {
  const report = await runInOrder(graph.order);
  console.error(`notebook loaded: ${cells.length} cells, ` +
    `${report.filter((r) => r.status === 'ok').length} ok`);
}

/* ----------------------------------------------------------- MCP plumbing */
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  chain = chain.then(() => handle(msg)).catch((e) => console.error('handler:', e));
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    emit({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rerun-pair', version: '0.0.1' },
      },
    });
  } else if (method === 'notifications/initialized') {
    /* no reply to notifications */
  } else if (method === 'tools/list') {
    emit({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {};
    let result;
    try {
      if (tabCall) {
        result = await tabCall(name, args ?? {});
        // the paired tab has no notion of our session id; stamp it on the view
        if (name === 'notebook' && result && typeof result === 'object' && !result.error) {
          result = { title: TITLE, session: String(ARGS.session ?? ''), ...result };
        }
      } else {
        const fn = handlers[name];
        result = fn ? await fn(args ?? {}) : { error: `unknown tool '${name}'` };
      }
    } catch (e) {
      result = { error: String(e?.message ?? e) };
    }
    emit({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] },
    });
  } else if (id !== undefined) {
    emit({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

console.error('rerun-pair MCP server ready (stdio)');
