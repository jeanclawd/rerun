import { analyzeCell, buildGraph, stripNoise } from '../host/dag.js';
import assert from 'node:assert';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };
const S = (s) => [...s].sort().join(',');

t('simple assignment defs', () => {
  const a = analyzeCell('x = 3; y = x + 1;');
  assert.equal(S(a.defs), 'x,y');
});

t('multi-assign and tilde', () => {
  const a = analyzeCell('[q, ~, r] = svd(M);');
  assert.equal(S(a.defs), 'q,r');
  assert.ok(a.idents.has('M'));
});

t('for-loop variable is a def', () => {
  const a = analyzeCell('for k = 1:10\n  s = k;\nend');
  assert.ok(a.defs.has('k') && a.defs.has('s'));
});

t('indexed assignment marks mutation', () => {
  const a = analyzeCell('v(3) = 7; w.f = 1; u{2} = 0;');
  assert.equal(S(a.mutated), 'u,v,w');
});

t('== is not an assignment', () => {
  const a = analyzeCell('if x == 3\n  disp(x)\nend');
  assert.equal(a.defs.size, 0);
});

t('<= >= ~= are not assignments', () => {
  const a = analyzeCell('ok = x <= 3 & y >= 2 & z ~= 1;');
  assert.equal(S(a.defs), 'ok');
});

t('strings and comments are invisible', () => {
  const a = analyzeCell("msg = 'hello ghost'; % ghost = 1\nt = \"another ghost\";");
  assert.equal(S(a.defs), 'msg,t');
  assert.ok(!a.idents.has('ghost'));
});

t('transpose quote is not a string', () => {
  const code = stripNoise("y = A' * b; z = x.' + 1;");
  assert.ok(code.includes('A') && code.includes('b') && code.includes('x'));
});

t('commas inside brackets do not split statements', () => {
  const a = analyzeCell('z = max(a, b);');
  assert.equal(S(a.defs), 'z');
  assert.ok(a.idents.has('a') && a.idents.has('b'));
});

t('function cell defines its functions', () => {
  const a = analyzeCell('function y = smooth(x, w)\n  y = x * w;\nend');
  assert.ok(a.isFunctionCell);
  assert.equal(S(a.funcs), 'smooth');
});

t('graph edges and topo order', () => {
  const cells = [
    { id: 'c', source: 'plot(t, y);' },
    { id: 'a', source: 't = linspace(0, 1, 100);' },
    { id: 'b', source: 'y = sin(2*pi*f*t);' },
    { id: 'f', source: 'f = 3;' },
  ];
  const g = buildGraph(cells);
  assert.equal(g.errors.size, 0);
  assert.equal(S(g.nodes.get('b').uses), 'f,t');
  const order = g.order;
  assert.ok(order.indexOf('a') < order.indexOf('b'));
  assert.ok(order.indexOf('f') < order.indexOf('b'));
  assert.ok(order.indexOf('b') < order.indexOf('c'));
  assert.equal(S(g.descendantsOf('f')), 'b,c');
});

t('builtins create no edges', () => {
  const g = buildGraph([
    { id: 'a', source: 'x = sin(3) + max(1, 2);' },
    { id: 'b', source: 'y = cos(x);' },
  ]);
  assert.equal(g.nodes.get('a').deps.size, 0);
  assert.equal(S(g.nodes.get('b').uses), 'x');
});

t('duplicate definition is an error on both cells', () => {
  const g = buildGraph([
    { id: 'a', source: 'x = 1;' },
    { id: 'b', source: 'x = 2;' },
  ]);
  assert.ok(g.errors.has('a') && g.errors.has('b'));
});

t('cross-cell mutation is an error', () => {
  const g = buildGraph([
    { id: 'a', source: 'v = zeros(1, 3);' },
    { id: 'b', source: 'v(2) = 5;' },
  ]);
  assert.ok(g.errors.get('b')[0].includes("mutates 'v'"));
});

t('cycle detection', () => {
  const g = buildGraph([
    { id: 'a', source: 'x = y + 1;' },
    { id: 'b', source: 'y = x + 1;' },
  ]);
  assert.ok(g.errors.get('a').some((e) => e.includes('cycle')));
  assert.ok(g.errors.get('b').some((e) => e.includes('cycle')));
});

t('self-reference within a cell is fine', () => {
  const g = buildGraph([{ id: 'a', source: 's = 0; s = s + 1;' }]);
  assert.equal(g.errors.size, 0);
});

t('function cell wires callers as dependents', () => {
  const g = buildGraph([
    { id: 'lib', source: 'function y = dbl(x)\n  y = 2*x;\nend' },
    { id: 'use', source: 'r = dbl(21);' },
  ]);
  assert.equal(S(g.nodes.get('use').uses), 'dbl');
  assert.equal(S(g.descendantsOf('lib')), 'use');
});

t('line continuation folds', () => {
  const a = analyzeCell('total = alpha + ...\n    beta;');
  assert.equal(S(a.defs), 'total');
  assert.ok(a.idents.has('beta'));
});

console.log(`\n${n} passed`);
