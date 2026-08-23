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
 */

import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraph } from '../../host/dag.js';
import { SessionRunner } from '../../host/session-core.mjs';

/* ------------------------------------------------------- session bootstrap */
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
globalThis.location ??= new URL(pathToFileURL(process.cwd() + '/'));
globalThis.performance ??= (await import('node:perf_hooks')).performance;
if (!globalThis.crypto?.getRandomValues) globalThis.crypto = (await import('node:crypto')).webcrypto;
console.log = (...a) => console.error(...a); // stdout is protocol-only
console.info = (...a) => console.error(...a);

const PKG = process.env.RUNMAT_PKG ??
  '/root/Projects/runmat-jupyter/host/node_modules/runmat/dist/pkg-web';
const web = await import(pathToFileURL(resolve(PKG, 'runmat_wasm_web.js')).href);
await web.default({ module_or_path: await readFile(resolve(PKG, 'runmat_wasm_web_bg.wasm')) });
const session = await web.initRunMat({
  enableGpu: false, enableJit: false, telemetryConsent: false,
  logLevel: 'error', language: { compat: 'matlab' },
});
const runner = new SessionRunner(session, { figureWidth: 640, figureHeight: 400 });
try { await web.subscribeStdout((e) => runner.feedStdout(e)); } catch { /* results carry stdout */ }

/* ------------------------------------------------------------- notebook */
let cells = [];                    // [{id, source}] page order
let graph = buildGraph(cells);
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
    name: 'export_m',
    description: 'The notebook as a plain MATLAB script: %% sections in dependency order, function cells last. Runs top-to-bottom in any MATLAB.',
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
    const r = await runner.exec(String(code), { name: '<scratch>' });
    return {
      ok: !r.error,
      stdout: (r.displays ?? []).map((d) => (d.label ? `${d.label} = ${d.text}` : d.text)).join('\n'),
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
    return { applied: ops.length, report, executionOrder: graph.order };
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
    const script = graph.order
      .filter((id) => !graph.nodes.get(id).isFunctionCell)
      .map((id, i) => `%% cell ${i + 1}\n${cells.find((c) => c.id === id).source}`)
      .join('\n\n');
    const fns = graph.order
      .filter((id) => graph.nodes.get(id).isFunctionCell)
      .map((id) => cells.find((c) => c.id === id).source)
      .join('\n\n');
    return { source: `% exported by ReRun pair\n\n${script}${fns ? '\n\n' + fns : ''}\n` };
  },
};

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
      const fn = handlers[name];
      result = fn ? await fn(args ?? {}) : { error: `unknown tool '${name}'` };
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
