/* ReRun dependency analysis — MATLAB cells in, a reactive DAG out.
 *
 *   analyzeCell(source) -> {defs, uses idents, funcs, isFunctionCell, mutated}
 *   buildGraph(cells)   -> {nodes, edges, order, errors, descendantsOf()}
 *
 * The model is marimo's: every variable is defined by exactly one cell, edges
 * run from the defining cell to every cell that reads the name, execution
 * order is the topological order of the graph (on-page order is presentation
 * only). Two cells defining the same name, a dependency cycle, or a cell
 * mutating another cell's variable are all reported as graph errors rather
 * than silently producing order-dependent results.
 *
 * The analyzer is lexical, not a full parser. That is the same trade
 * marimo makes (Python's ast is easier, but the idea holds): find the names a
 * cell BINDS and the names it READS, and let the graph do the rest. MATLAB's
 * one genuine ambiguity — `x(1)` as indexing vs function call — resolves at
 * the graph level: the name only creates an edge if some other cell defines
 * it, so builtins fall out naturally.
 */

const KEYWORDS = new Set([
  'if', 'elseif', 'else', 'end', 'for', 'while', 'break', 'continue',
  'return', 'switch', 'case', 'otherwise', 'function', 'try', 'catch',
  'global', 'persistent', 'true', 'false', 'ans', 'parfor', 'spmd',
  'classdef', 'properties', 'methods', 'nargin', 'nargout', 'varargin',
  'varargout', 'pi', 'eps', 'inf', 'Inf', 'nan', 'NaN',
]);

const IDENT = /[A-Za-z_]\w*/g;

/* ------------------------------------------------------------------ lexer */

/** Strip comments and string literals, preserving code structure.
 *  Strings become empty quotes so identifiers inside them vanish. */
export function stripNoise(source) {
  // block comments: lines that are only %{ ... %} (MATLAB requires that)
  const lines = source.split('\n');
  const kept = [];
  let inBlock = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === '%{') { inBlock++; kept.push(''); continue; }
    if (t === '%}' && inBlock) { inBlock--; kept.push(''); continue; }
    kept.push(inBlock ? '' : line);
  }

  const out = [];
  for (const line of kept) {
    let res = '';
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '%') break; // line comment
      if (c === '"') { // double-quoted string
        i++;
        while (i < line.length && !(line[i] === '"' && line[i + 1] !== '"')) {
          i += line[i] === '"' ? 2 : 1;
        }
        i++;
        res += '""';
        continue;
      }
      if (c === "'") {
        // transpose if it follows a value; string otherwise
        const prev = res.trimEnd().slice(-1);
        if (/[\w)\]}.']/.test(prev)) { res += "'"; i++; continue; }
        i++;
        while (i < line.length && !(line[i] === "'" && line[i + 1] !== "'")) {
          i += line[i] === "'" ? 2 : 1;
        }
        i++;
        res += "''";
        continue;
      }
      res += c;
      i++;
    }
    out.push(res);
  }
  // line continuations: fold `...` into a single logical line
  return out.join('\n').replace(/\.\.\.[^\n]*\n/g, ' ');
}

/** Split code into statements at top-level newlines, `;` and `,`. */
function statements(code) {
  const stmts = [];
  let depth = 0;
  let cur = '';
  for (const c of code) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === '\n' || c === ';' || c === ',')) {
      if (cur.trim()) stmts.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

function identsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(IDENT)) {
    if (!KEYWORDS.has(m[0])) found.add(m[0]);
  }
  return found;
}

/* --------------------------------------------------------------- analyzer */

/**
 * One cell's bindings and reads.
 *   defs    — names this cell binds (assignments, for-loop vars, functions)
 *   mutated — names indexed-assigned (`x(i) = …`, `x.f = …`) — a def locally,
 *             an error if the base is owned by another cell
 *   idents  — every identifier read anywhere (graph filters to real deps)
 *   funcs   — function names, when the cell is a pure function-definition cell
 */
export function analyzeCell(source) {
  const code = stripNoise(source);
  const defs = new Set();
  const mutated = new Set();
  const funcs = new Set();
  const idents = identsIn(code);

  const isFunctionCell = /^\s*function\b/.test(code.trimStart());
  if (isFunctionCell) {
    // defs are the function names; bodies are local scope, not analyzed
    for (const m of code.matchAll(/^\s*function\b([^\n]*)/gm)) {
      const sig = m[1];
      const eq = sig.indexOf('=');
      const rhs = eq >= 0 ? sig.slice(eq + 1) : sig;
      const name = rhs.match(/[A-Za-z_]\w*/);
      if (name) { funcs.add(name[0]); defs.add(name[0]); }
    }
    return { defs, uses: new Set(), idents: new Set(), funcs, mutated, isFunctionCell };
  }

  for (const st of statements(code)) {
    // for/parfor loop variable
    const forM = st.match(/^(?:for|parfor)\s+([A-Za-z_]\w*)\s*=/);
    if (forM) { defs.add(forM[1]); continue; }

    // find a top-level `=` that isn't ==, ~=, <=, >=
    let depth = 0, eq = -1;
    for (let i = 0; i < st.length; i++) {
      const c = st[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === '=' && depth === 0 &&
               !'=~<>'.includes(st[i - 1] ?? '') && st[i + 1] !== '=') { eq = i; break; }
    }
    if (eq < 0) continue;

    const lhs = st.slice(0, eq).trim();
    if (/^\[/.test(lhs)) {
      // [a, b, ~] = rhs
      for (const m of lhs.matchAll(IDENT)) {
        if (!KEYWORDS.has(m[0])) defs.add(m[0]);
      }
    } else {
      const base = lhs.match(/^([A-Za-z_]\w*)\s*(.*)$/);
      if (!base) continue;
      if (base[2].trim() === '') defs.add(base[1]);        // x = rhs
      else mutated.add(base[1]);                            // x(i)/x.f/x{..} = rhs
    }
  }
  // a mutated name the cell never plainly assigns still binds it here
  // (MATLAB autocreates on indexed assignment) — but plain defs own first,
  // so buildGraph can tell "defines v" apart from "pokes at cell 1's v".
  const plainDefs = new Set(defs);
  for (const m of mutated) defs.add(m);

  return { defs, plainDefs, uses: new Set(), idents, funcs, mutated, isFunctionCell };
}

/* ------------------------------------------------------------------ graph */

/**
 * cells: [{id, source}] → graph. Reads are matched against other cells'
 * definitions; execution order is Kahn topological order with the on-page
 * order as the tie-break, so unrelated cells run in the order you see them.
 */
export function buildGraph(cells) {
  const nodes = new Map(); // id -> analysis + {deps:Set(ids), dependents:Set(ids)}
  const errors = new Map(); // id -> [messages]
  const err = (id, msg) => {
    if (!errors.has(id)) errors.set(id, []);
    errors.get(id).push(msg);
  };

  for (const c of cells) {
    const a = analyzeCell(c.source);
    nodes.set(c.id, { ...a, id: c.id, deps: new Set(), dependents: new Set() });
  }

  // ownership: a name is defined by exactly one cell. Plain assignments claim
  // first; mutation-only bindings (`v(2) = …` with no `v = …`) claim a name
  // only when nobody else does — otherwise the mutation check below reports it.
  const owner = new Map();
  for (const c of cells) {
    const n = nodes.get(c.id);
    for (const d of n.plainDefs ?? n.defs) {
      if (owner.has(d)) {
        err(c.id, `'${d}' is also defined by cell ${owner.get(d) + 1} — every variable must have exactly one defining cell`);
        err(cellsIndexId(cells, owner.get(d)), `'${d}' is also defined by cell ${cells.findIndex(x => x.id === c.id) + 1}`);
      } else {
        owner.set(d, cells.findIndex(x => x.id === c.id));
      }
    }
  }
  for (const c of cells) {
    const n = nodes.get(c.id);
    for (const m of n.mutated) {
      if (!owner.has(m)) owner.set(m, cells.findIndex(x => x.id === c.id));
    }
  }

  // edges
  for (const c of cells) {
    const n = nodes.get(c.id);
    for (const name of n.idents) {
      if (n.defs.has(name)) continue;
      const ownIdx = owner.get(name);
      if (ownIdx === undefined) continue;
      const ownerId = cells[ownIdx].id;
      if (ownerId === c.id) continue;
      n.deps.add(ownerId);
      n.uses.add(name);
      nodes.get(ownerId).dependents.add(c.id);
    }
    for (const name of n.mutated) {
      const ownIdx = owner.get(name);
      if (ownIdx !== undefined && cells[ownIdx].id !== c.id) {
        err(c.id, `mutates '${name}', which is defined by cell ${ownIdx + 1} — copy it into a new variable instead`);
      }
    }
  }

  // Kahn topological order, page order as tie-break
  const pageIdx = new Map(cells.map((c, i) => [c.id, i]));
  const indeg = new Map(cells.map((c) => [c.id, nodes.get(c.id).deps.size]));
  const ready = cells.filter((c) => indeg.get(c.id) === 0).map((c) => c.id);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => pageIdx.get(a) - pageIdx.get(b));
    const id = ready.shift();
    order.push(id);
    for (const dep of nodes.get(id).dependents) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) ready.push(dep);
    }
  }
  if (order.length < cells.length) {
    for (const c of cells) {
      if (!order.includes(c.id)) err(c.id, 'part of a dependency cycle');
    }
  }

  /** every transitive dependent of id, in topological order */
  function descendantsOf(id) {
    const seen = new Set();
    const walk = (x) => {
      for (const d of nodes.get(x)?.dependents ?? []) {
        if (!seen.has(d)) { seen.add(d); walk(d); }
      }
    };
    walk(id);
    return order.filter((x) => seen.has(x));
  }

  return { nodes, order, errors, descendantsOf };
}

function cellsIndexId(cells, idx) {
  return cells[idx].id;
}
