/* Live-script parser + importer tests. Exercises examples/livescript-demo.m:
 * asserts the chunk/appendix structure the parser yields and that the importer
 * produces a valid ReRun cell model (text cells + DAG-clean code cells). */
import { parseLiveScript, controlDefaultLiteral } from '../host/livescript.js';
import { importLiveScript, looksLikeLiveScript } from '../host/format.js';
import { buildGraph } from '../host/dag.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

const demo = readFileSync(
  fileURLToPath(new URL('../examples/livescript-demo.m', import.meta.url)), 'utf8');

/* ---------------------------------------------------------------- parser */

t('parses ordered chunks: text, code, table, control-ref', () => {
  const { chunks } = parseLiveScript(demo);
  const kinds = new Set(chunks.map((c) => c.kind));
  for (const k of ['text', 'code', 'table', 'control-ref']) assert.ok(kinds.has(k), `has ${k}`);
});

t('text chunk carries Markdown; heading preserved', () => {
  const { chunks } = parseLiveScript(demo);
  const first = chunks.find((c) => c.kind === 'text');
  assert.ok(first.markdown.startsWith('# Damped Oscillator'));
  assert.ok(first.markdown.includes('**live-script**'));
});

t('table chunk has rows', () => {
  const { chunks } = parseLiveScript(demo);
  const tbl = chunks.find((c) => c.kind === 'table');
  assert.deepEqual(tbl.rows[0], ['quantity', 'value']);
  assert.deepEqual(tbl.rows[2], ['samples', '400']);
});

t('trailing control markers become control-refs bound to their code chunk', () => {
  const { chunks } = parseLiveScript(demo);
  const refs = chunks.filter((c) => c.kind === 'control-ref');
  assert.equal(refs.length, 2);
  const ids = refs.map((r) => r.id).sort();
  assert.deepEqual(ids, ['damp01', 'freq01']);
  for (const r of refs) {
    assert.equal(r.ctype, 'slider');
    assert.ok(Array.isArray(r.position));
    assert.equal(typeof r.codeChunkIndex, 'number');
  }
});

t('code chunk excludes the trailing control comment', () => {
  const { chunks } = parseLiveScript(demo);
  const freqCode = chunks.find((c) => c.kind === 'code' && c.code.includes('f ='));
  assert.ok(!freqCode.code.includes('%[control'));
  assert.ok(freqCode.controls.length >= 1);
});

t('appendix: version, control defaults, ignored output', () => {
  const { appendix } = parseLiveScript(demo);
  assert.equal(appendix.version, '1.0');
  assert.equal(appendix.controls.freq01.ctype, 'slider');
  assert.equal(appendix.controls.freq01.data.defaultValue, 4);
  assert.equal(appendix.controls.damp01.data.defaultValue, 6);
  assert.ok('ignored99' in appendix.outputs);
  assert.equal(appendix.metadata.view.layout, 'inline');
});

t('output markers produce no chunk (ReRun re-executes)', () => {
  const { chunks } = parseLiveScript(demo);
  assert.ok(!chunks.some((c) => c.kind === 'output'));
});

t('controlDefaultLiteral renders types', () => {
  assert.equal(controlDefaultLiteral({ defaultValue: 4 }), '4');
  assert.equal(controlDefaultLiteral({ defaultValue: true }), 'true');
  assert.equal(controlDefaultLiteral({ defaultValue: 'red' }), "'red'");
  assert.equal(controlDefaultLiteral({ defaultValue: [1, 0, 0] }), '[1 0 0]');
  assert.equal(controlDefaultLiteral({}), null);
});

/* -------------------------------------------------------------- importer */

t('looksLikeLiveScript discriminates', () => {
  assert.ok(looksLikeLiveScript(demo));
  assert.ok(!looksLikeLiveScript('x = 1;\n%% two\ny = x + 1;'));
});

t('imports a valid cell model: text + code cells with ids', () => {
  const cells = importLiveScript(demo);
  assert.ok(cells.length > 4);
  assert.ok(cells.every((c) => c.id && typeof c.source === 'string'));
  assert.ok(cells.some((c) => c.kind === 'text'));
  assert.ok(cells.some((c) => c.kind === 'code'));
});

t('control defaults are spliced into code (Phase 1 runs with no widgets)', () => {
  const cells = importLiveScript(demo);
  const freq = cells.find((c) => c.kind === 'code' && c.source.startsWith('f ='));
  const damp = cells.find((c) => c.kind === 'code' && c.source.startsWith('tau ='));
  assert.equal(freq.source, 'f = 4;');   // default 4 spliced over literal 3
  assert.equal(damp.source, 'tau = 6;'); // default 6 spliced over literal 4
});

t('table + prose land in text cells (Markdown)', () => {
  const cells = importLiveScript(demo);
  const tblCell = cells.find((c) => c.kind === 'text' && c.source.includes('| quantity | value |'));
  assert.ok(tblCell, 'a text cell holds the table markdown');
});

t('imported code cells form a clean DAG', () => {
  const cells = importLiveScript(demo);
  const code = cells.filter((c) => c.kind !== 'text');
  const g = buildGraph(code);
  assert.equal(g.errors.size, 0, 'no graph errors');
  const yNode = [...g.nodes.values()].find((nd) => nd.defs.has('y'));
  assert.ok(yNode.defs.has('t'), 't and y share a cell');
  assert.ok(yNode.uses.has('f'), 'y-cell depends on f (defined elsewhere)');
});

t('control-ref chunks are not turned into their own cells', () => {
  const cells = importLiveScript(demo);
  assert.ok(!cells.some((c) => c.kind === 'control-ref'));
});

/* --------------------------------------------------- standalone control line */

t('control on its own line (not trailing) still parses', () => {
  const src = [
    '%[text] # T',
    'a = 1;',
    '%[control:slider:x1]{"position":[5,5]}',
    '%[appendix]{"version":"1.0"}',
    '%---',
    '%[control:slider:x1]',
    '%   data: {"defaultValue":9}',
    '%---',
  ].join('\n');
  const { chunks, appendix } = parseLiveScript(src);
  assert.ok(chunks.some((c) => c.kind === 'control-ref' && c.id === 'x1'));
  assert.equal(appendix.controls.x1.data.defaultValue, 9);
});

console.log(`\n${n} passed`);
