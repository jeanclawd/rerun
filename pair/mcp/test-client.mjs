#!/usr/bin/env node
/* Exercise the rerun-pair MCP server over stdio like a harness would:
 * initialize → tools/list → a full pair session (build a notebook, scratch-
 * inspect, reactive edit, guardrail rejection, export). */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert';

const HERE = dirname(new URL(import.meta.url).pathname);
const NB = '/tmp/claude-0/-root/7d6489b7-1433-47fd-905a-f55e36d48df5/scratchpad/pairtest.rerun.m';
const { rmSync } = await import('node:fs');
try { rmSync(NB); } catch { }
const srv = spawn('node', [resolve(HERE, 'server.mjs'), '--notebook', NB], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: srv.stdout });

let nextId = 1;
const pending = new Map();
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`timeout on ${method}`)); }, 120_000);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return JSON.parse(r.result.content[0].text);
};

let n = 0;
const pass = (msg) => console.log(`ok ${++n} - ${msg}`);

// -- handshake ---------------------------------------------------------------
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
});
assert.equal(init.result.serverInfo.name, 'rerun-pair');
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);
assert.deepEqual(tools.sort(), ['apply', 'exec', 'export_m', 'notebook', 'read_figure', 'read_variable']);
pass(`MCP handshake, 6 tools: ${tools.join(' ')}`);

// -- build a notebook in one transactional batch ------------------------------
const built = await call('apply', {
  ops: [
    { kind: 'create', source: 'f = 3;' },
    { kind: 'create', source: 't = linspace(0, 2*pi, 400);' },
    { kind: 'create', source: 'y = sin(f*t) .* exp(-t/4);' },
    { kind: 'create', source: 'peak = max(y)' },
  ],
});
assert.equal(built.applied, 4);
assert.ok(built.report.every((r) => r.status === 'ok'), JSON.stringify(built.report));
const peakLine = built.report.find((r) => r.stdout?.includes('peak'));
assert.ok(peakLine, 'peak echo expected');
pass(`apply(create×4): all ok, ${peakLine.stdout.trim()}`);

// -- notebook view -------------------------------------------------------------
const nb = await call('notebook');
assert.equal(nb.cells.length, 4);
const yCell = nb.cells.find((c) => c.defines.includes('y'));
assert.deepEqual(yCell.uses.sort(), ['f', 't']);
assert.ok(nb.workspace.some((v) => v.name === 'peak'));
pass(`notebook: y uses [${yCell.uses.join(', ')}], workspace has ${nb.workspace.length} vars`);

// -- scratchpad ----------------------------------------------------------------
const scratch = await call('exec', { code: 'pad_m = mean(y)' });
assert.ok(scratch.ok, JSON.stringify(scratch));
assert.ok(scratch.stdout.includes('pad_m'), scratch.stdout);
pass(`exec scratchpad sees notebook vars: ${scratch.stdout.trim()}`);

// scratch may not steal a notebook-owned name
const stolen = await call('exec', { code: 'f = 99;' });
assert.ok(stolen.refused?.length, 'assigning notebook-owned f must be refused');
pass(`exec guard: "${stolen.refused[0].slice(0, 58)}…"`);

// -- the reactive edit ----------------------------------------------------------
const fId = nb.cells.find((c) => c.defines.includes('f')).id;
const edited = await call('apply', { ops: [{ kind: 'edit', id: fId, source: 'f = 7;' }] });
const reran = edited.report.map((r) => r.id);
assert.ok(reran.length >= 3, `expected f + descendants to rerun, got ${reran}`);
const newPeak = edited.report.find((r) => r.stdout?.includes('peak'));
assert.ok(newPeak && !newPeak.stdout.includes('0.88'), 'peak must change with f=7');
pass(`apply(edit f=7): ${reran.length} cells reran reactively, ${newPeak.stdout.trim()}`);

// -- guardrail: batch violating the graph is rejected untouched ------------------
const bad = await call('apply', { ops: [{ kind: 'create', source: 'f = 100;' }] });
assert.ok(bad.rejected?.length, 'duplicate def must reject');
const after = await call('notebook');
assert.equal(after.cells.length, 4, 'notebook must be unchanged after rejection');
pass(`apply guardrail: duplicate def rejected, notebook untouched`);

// -- read a variable deeply ------------------------------------------------------
const y = await call('read_variable', { name: 'y', maxElements: 10 });
assert.ok(Array.isArray(y.values) && y.values.length > 0, JSON.stringify(y));
pass(`read_variable(y): ${y.values.length} values, truncated=${y.truncated}`);

// -- figures -----------------------------------------------------------------------
const withPlot = await call('apply', {
  ops: [{ kind: 'create', source: "plot(t, y); title('paired plot');" }],
});
const plotId = withPlot.report.find((r) => r.figures)?.id;
assert.ok(plotId, 'plot cell should report a figure');
const fig = await call('read_figure', { id: plotId });
assert.ok(fig.svgs?.[0]?.includes('<svg') && fig.svgs[0].includes('paired plot'), 'svg with title expected');
pass(`read_figure(${plotId}): ${Math.round(fig.svgs[0].length / 1024)} KB svg with the title`);

// -- export (v1 format) --------------------------------------------------------------
const m = await call('export_m');
assert.ok(m.source.includes('%% ⟳ ') && m.source.includes('f = 7;') && m.source.includes('% ⟳ page-order:'));
assert.equal(m.file, NB);
pass('export_m: ⟳-tagged dependency-ordered MATLAB, persisted to --notebook file');

// -- persistence across restart -------------------------------------------------------
srv.kill();
await new Promise((r) => setTimeout(r, 300));
const srv2 = spawn('node', [resolve(HERE, 'server.mjs'), '--notebook', NB], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl2 = createInterface({ input: srv2.stdout });
rl2.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const rpc2 = (method, params) => {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`timeout on ${method}`)); }, 120_000);
    srv2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
};
await rpc2('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
const nb2r = await rpc2('tools/call', { name: 'notebook', arguments: {} });
const nb2 = JSON.parse(nb2r.result.content[0].text);
assert.equal(nb2.cells.length, 5);
assert.ok(nb2.workspace.some((v) => v.name === 'peak'), 'restart must replay the notebook');
const f2 = nb2.cells.find((c) => c.defines.includes('f'));
assert.equal(f2.source, 'f = 7;');
pass(`restart with --notebook: ${nb2.cells.length} cells replayed, ids stable (f is '${f2.id}')`);

console.log(`\n${n} passed — pair-over-MCP works`);
srv2.kill();
process.exit(0);
