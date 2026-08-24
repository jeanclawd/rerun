import { exportNotebook, parseNotebook } from '../host/format.js';
import { buildGraph } from '../host/dag.js';
import assert from 'node:assert';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

const cells = [
  { id: 'plotc', source: 'plot(t, y);' },                       // page 1, runs last
  { id: 'fdef', source: 'f = 3;' },
  { id: 'tdef', source: 't = linspace(0, 1, 10);' },
  { id: 'ydef', source: 'y = sin(f*t);' },
  { id: 'fnc', source: 'function r = dbl(x)\n  r = 2*x;\nend' },
];

t('export: dependency order, functions last, footer carries page order', () => {
  const text = exportNotebook(cells, buildGraph(cells));
  const iPlot = text.indexOf('plot(t, y)');
  const iY = text.indexOf('y = sin');
  const iFn = text.indexOf('function r = dbl');
  assert.ok(iY < iPlot, 'y before plot');
  assert.ok(iFn > iPlot, 'function cell last');
  assert.ok(text.includes('% ⟳ page-order: plotc fdef tdef ydef fnc'));
});

t('round-trip: same ids, same page order, same sources', () => {
  const text = exportNotebook(cells, buildGraph(cells));
  const back = parseNotebook(text);
  assert.deepEqual(back.map((c) => c.id), cells.map((c) => c.id));
  for (let i = 0; i < cells.length; i++) assert.equal(back[i].source, cells[i].source);
});

t('stable ids → editing one cell changes one section only', () => {
  const a = exportNotebook(cells, buildGraph(cells));
  const edited = cells.map((c) => (c.id === 'fdef' ? { ...c, source: 'f = 7;' } : c));
  const b = exportNotebook(edited, buildGraph(edited));
  const diff = a.split('\n').filter((l) => !b.includes(l));
  assert.deepEqual(diff, ['f = 3;']);
});

t('plain %%-sectioned .m imports with fresh ids, file order', () => {
  const back = parseNotebook('%% one\na = 1;\n\n%% two\nb = a + 1;\n');
  assert.equal(back.length, 2);
  assert.equal(back[0].source, 'a = 1;');
  assert.ok(back[0].id && back[1].id && back[0].id !== back[1].id);
});

t('headerless script imports as one cell', () => {
  const back = parseNotebook('x = 1;\ny = x + 1;\n');
  assert.equal(back.length, 1);
  assert.ok(back[0].source.includes('y = x + 1;'));
});

console.log(`\n${n} passed`);
