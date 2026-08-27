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

/** Split a source string into nbformat `source` lines: each line keeps its
 * trailing newline except the last. An empty source becomes []. */
function toSourceLines(source) {
  const text = String(source).replace(/\s+$/, '');
  if (!text) return [];
  const lines = text.split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l));
}

/** cells (page order) + graph → a Jupyter nbformat 4 notebook JSON string.
 *
 * One code cell per ReRun cell in dependency (topological) order, function
 * cells last — exactly the ordering exportNotebook uses. `outputs` is an
 * optional Map/object of cell id → { stdout?: string, figures?: string[] }
 * (figures are SVG markup); when present, matching cells embed a `stream`
 * stdout output and a `display_data` image/svg+xml output per figure.
 * Dependency-free; returns a pretty-printed string. One-way export only. */
export function exportIpynb(cells, graph, outputs = null) {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const scripts = graph.order.filter((id) => !graph.nodes.get(id).isFunctionCell);
  const fns = graph.order.filter((id) => graph.nodes.get(id).isFunctionCell);
  const getOut = (id) => {
    if (!outputs) return null;
    return typeof outputs.get === 'function' ? outputs.get(id) : outputs[id];
  };
  const cellFor = (id) => {
    const src = byId.get(id);
    const outs = [];
    const rec = getOut(id);
    if (rec) {
      if (rec.stdout && String(rec.stdout).trim()) {
        outs.push({
          output_type: 'stream',
          name: 'stdout',
          text: toSourceLines(String(rec.stdout).replace(/\s+$/, '') + '\n'),
        });
      }
      for (const svg of rec.figures ?? []) {
        if (!svg) continue;
        outs.push({
          output_type: 'display_data',
          data: { 'image/svg+xml': toSourceLines(svg) },
          metadata: {},
        });
      }
    }
    return {
      cell_type: 'code',
      metadata: {},
      execution_count: null,
      outputs: outs,
      source: toSourceLines(src.source),
    };
  };
  const nb = {
    cells: [...scripts, ...fns].map(cellFor),
    metadata: {
      kernelspec: { name: 'runmat', display_name: 'RunMat', language: 'matlab' },
      language_info: { name: 'matlab' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(nb, null, 2);
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

/* ---------------------------------------------------- live-script importer */
import { parseLiveScript, controlDefaultLiteral } from './livescript.js';

/** Plain-text live-script .m text → ReRun cells `[{id, source, kind}]`.
 *
 * Maps the parser's ordered chunks onto ReRun's in-memory cell model — the
 * SAME shape parseNotebook yields, plus a `kind`:
 *   - prose/table/equation/image chunks → a `text` cell (Markdown, excluded
 *     from the DAG — see app.js: text cells are filtered out before buildGraph).
 *   - code chunks → a `code` cell; each attached control's default value is
 *     spliced into the code at its `position` so the notebook runs with no
 *     widgets yet (Phase 1). Standalone `control-ref` chunks are for a linear
 *     renderer and are skipped here — ReRun reads a code chunk's own `controls`
 *     list instead. That is the one boundary where ReRun's graph importer and a
 *     top-to-bottom renderer diverge.
 *
 * Consecutive text-like chunks are merged into one prose cell so headings and
 * their paragraphs stay together. Controls become live widgets in Phase 2. */
export function importLiveScript(text, mkId = defaultId) {
  const { chunks, appendix } = parseLiveScript(text);
  const cells = [];
  let prose = null; // accumulating markdown for the current text cell

  const flushProse = () => {
    if (prose && prose.trim()) cells.push({ id: mkId(), source: prose.trim(), kind: 'text' });
    prose = null;
  };
  const addProse = (md) => { prose = prose ? `${prose}\n\n${md}` : md; };

  for (const ch of chunks) {
    if (ch.kind === 'text') {
      addProse(ch.align ? `<div align="${ch.align}">\n\n${ch.markdown}\n\n</div>` : ch.markdown);
    } else if (ch.kind === 'table') {
      addProse(ch.markdown);
    } else if (ch.kind === 'equation') {
      // TODO(#11 Phase 3): render LaTeX. For now show it verbatim as mono.
      addProse('`' + `$${ch.latex}$` + '`');
    } else if (ch.kind === 'image-ref') {
      // TODO(#11 Phase 3): inline embedded appendix images. External ![]() only.
      addProse(`![${ch.alt}](${ch.url})`);
    } else if (ch.kind === 'code') {
      flushProse();
      cells.push({ id: mkId(), source: spliceControls(ch, appendix), kind: 'code' });
    }
    // control-ref chunks: skipped — spliced via the code chunk's own controls.
  }
  flushProse();
  return cells;
}

/** Splice each control's default value into a code chunk at its position, so
 *  Phase-1 code runs without widgets. Defensive: only replaces when the
 *  position falls inside the target line; otherwise the existing literal (the
 *  control's last saved value) is left untouched, which also runs fine. */
function spliceControls(codeChunk, appendix) {
  const lines = codeChunk.code.split('\n');
  // apply right-to-left within a line so earlier columns keep their indices
  const byLine = new Map();
  for (const ctl of codeChunk.controls ?? []) {
    if (ctl.line == null || !Array.isArray(ctl.position)) continue;
    if (!byLine.has(ctl.line)) byLine.set(ctl.line, []);
    byLine.get(ctl.line).push(ctl);
  }
  for (const [li, ctls] of byLine) {
    if (li < 0 || li >= lines.length) continue;
    ctls.sort((a, b) => b.position[0] - a.position[0]);
    let line = lines[li];
    for (const ctl of ctls) {
      const def = appendix.controls[ctl.id];
      const lit = def ? controlDefaultLiteral(def.data) : null;
      const [start, end] = ctl.position;
      if (lit == null || !(start >= 1 && end >= start && end <= line.length)) continue;
      line = line.slice(0, start - 1) + lit + line.slice(end);
    }
    lines[li] = line;
  }
  return lines.join('\n').replace(/\s+$/, '');
}

/** Heuristic: does this .m text look like a plain-text live script (vs a plain
 *  or .rerun.m script)? Used to route the import affordance. */
export function looksLikeLiveScript(text) {
  return /^%\[(text|control|appendix|output)\b/m.test(String(text));
}
