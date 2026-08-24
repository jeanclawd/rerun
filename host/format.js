/* ReRun file format v1 — a notebook that IS a valid MATLAB script.
 *
 * Cells are %% sections written in DEPENDENCY order (function cells last, as
 * MATLAB itself requires of scripts), so the file runs top-to-bottom in any
 * MATLAB. Round-trip metadata rides in comments, Pluto.jl-style:
 *
 *   %% ⟳ c7a3f21b
 *   f = 3;
 *
 *   % ⟳ page-order: c7a3f21b 9d2e44a1 …
 *
 * Stable IDs mean git diffs show one hunk per edited cell; the footer restores
 * the on-page layout exactly. Plain %%-sectioned .m files (no ⟳ metadata)
 * import fine — they just get fresh IDs and file order as page order.
 * Shared verbatim by the browser app and the pair MCP server.
 */

const HEAD = /^%% ⟳ ([A-Za-z0-9_-]+)\s*$/;
const FOOT = /^% ⟳ page-order:\s*(.*)$/;

/** cells (page order) + graph → the .rerun.m text. */
export function exportNotebook(cells, graph) {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const scripts = graph.order.filter((id) => !graph.nodes.get(id).isFunctionCell);
  const fns = graph.order.filter((id) => graph.nodes.get(id).isFunctionCell);
  const section = (id) => `%% ⟳ ${id}\n${byId.get(id).source.replace(/\s+$/, '')}`;
  const pageOrder = cells.map((c) => c.id).join(' ');
  return [
    '% ReRun notebook — cells in dependency order; runs top-to-bottom in MATLAB.',
    '',
    ...scripts.map(section),
    ...fns.map(section),
    '',
    `% ⟳ page-order: ${pageOrder}`,
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** .m text → [{id, source}] in page order. Accepts plain %%-sectioned files. */
export function parseNotebook(text, mkId = defaultId) {
  const lines = String(text).split('\n');
  const cells = [];
  let cur = null;
  let pageOrder = null;

  const flush = () => {
    if (!cur) return;
    const source = cur.lines.join('\n').trim();
    if (source) cells.push({ id: cur.id ?? mkId(), source });
    cur = null;
  };

  for (const line of lines) {
    const foot = line.match(FOOT);
    if (foot) { pageOrder = foot[1].trim().split(/\s+/).filter(Boolean); continue; }
    const head = line.match(HEAD);
    if (head) { flush(); cur = { id: head[1], lines: [] }; continue; }
    if (/^%%/.test(line)) { flush(); cur = { id: null, lines: [] }; continue; }
    if (!cur) {
      if (!line.trim() || /^%/.test(line)) continue; // preamble comments
      cur = { id: null, lines: [line] };             // headerless first cell
      continue;
    }
    cur.lines.push(line);
  }
  flush();

  if (pageOrder) {
    const byId = new Map(cells.map((c) => [c.id, c]));
    const ordered = pageOrder.map((id) => byId.get(id)).filter(Boolean);
    for (const c of cells) if (!ordered.includes(c)) ordered.push(c);
    return ordered;
  }
  return cells;
}

let n = 0;
function defaultId() {
  return `m${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
