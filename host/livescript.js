/* Plain-text live-script (.m) parser — standalone, browser-safe, zero deps.
 *
 *   parseLiveScript(text) -> { chunks: [...ordered...], appendix }
 *
 * Input is a plain-text live-script document: prose carried on `%[text]`
 * comment markers, executable code on bare lines, interactive controls on
 * `%[control:*]` markers, and an `%[appendix]` block at the end holding each
 * control's data (defaults / min / max / label / options). This is the
 * interchange format documented at
 *   mathworks.com/help/matlab/matlab_prog/plain-text-file-format-for-live-scripts.html
 *
 * This module is DELIBERATELY self-contained — no import of ReRun internals
 * (dag.js / format.js / app.js). It is written to consolidate cleanly into the
 * shared `runmat-livescript` package that streamlab and the VS Code extension
 * also pull from, so the boundary must stay a pure text -> data transform.
 *
 * Output shape
 * ------------
 * chunks: ordered array of
 *   { kind:'text',       markdown, align? }              a run of prose/list/heading/link lines
 *   { kind:'table',      markdown, rows }                a %[text:table] … %[text:table] block
 *   { kind:'equation',   latex, altText? }               a %[text] $…$ line
 *   { kind:'image-ref',  alt, url }                      a %[text] ![alt](url) line
 *   { kind:'code',       code, controls, index }         a run of bare code lines
 *   { kind:'control-ref', ctype, id, position,           a control marker; `index`/`line` point
 *                        codeChunkIndex, line }            back into the code chunk it splices
 * appendix:
 *   { version, controls:{id:{ctype,data}}, outputs:{id:{data}},
 *     images:{id:{data}}, metadata:{name:data} }
 *
 * A `code` chunk carries its own `controls` list (the same control-ref records
 * that also appear standalone in `chunks`) so a consumer can splice without
 * cross-referencing; a linear renderer can instead walk the ordered `chunks`.
 * That difference is the one place ReRun's importer and a top-to-bottom
 * renderer diverge — see the note in the importer.
 */

const TEXT = /^%\[text\](\{[^}]*\})?\s?(.*)$/;      // %[text]{attrs} content
const TABLE = /^%\[text:table\]\s*$/;
const CONTROL = /^%\[control:([a-zA-Z]+):([^\]]+)\](\{[^}]*\})?\s*$/;
const OUTPUT = /^%\[output:([^\]]+)\]\s*$/;
const APPENDIX = /^%\[appendix\](\{[^}]*\})?\s*$/;
// a trailing control/output marker riding on a code line: `F = -40; %[control:…]`
const TRAILING = /\s*%\[(control|output):([^\]]*)\](\{[^}]*\})?\s*$/;

function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Parse a plain-text live-script document into ordered chunks + appendix. */
export function parseLiveScript(text) {
  const allLines = String(text).replace(/\r\n?/g, '\n').split('\n');

  // Split off the appendix (everything from the %[appendix] marker to EOF).
  let appendixStart = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (APPENDIX.test(allLines[i])) { appendixStart = i; break; }
  }
  const bodyLines = appendixStart < 0 ? allLines : allLines.slice(0, appendixStart);
  const appendix = appendixStart < 0
    ? emptyAppendix()
    : parseAppendix(allLines.slice(appendixStart));

  const chunks = [];
  let textBuf = null;   // { kind:'text', lines:[], align }
  let tableBuf = null;  // { kind:'table', lines:[] }
  let codeBuf = null;   // { kind:'code', lines:[], controls:[], index }

  const flushText = () => {
    if (textBuf && textBuf.lines.length) {
      const c = { kind: 'text', markdown: textBuf.lines.join('\n').trim() };
      if (textBuf.align) c.align = textBuf.align;
      chunks.push(c);
    }
    textBuf = null;
  };
  const flushCode = () => {
    if (codeBuf && codeBuf.lines.join('\n').trim()) {
      codeBuf.code = codeBuf.lines.join('\n').replace(/\s+$/, '');
      delete codeBuf.lines;
      chunks.push(codeBuf);
    }
    codeBuf = null;
  };
  const flushTable = () => {
    if (tableBuf && tableBuf.lines.length) {
      chunks.push({
        kind: 'table',
        markdown: tableBuf.lines.join('\n'),
        rows: tableBuf.lines.map((l) => splitTableRow(l)),
      });
    }
    tableBuf = null;
  };

  for (const raw of bodyLines) {
    const line = raw.replace(/\s+$/, '');

    if (TABLE.test(line)) {
      if (tableBuf) { flushTable(); }
      else { flushText(); flushCode(); tableBuf = { lines: [] }; }
      continue;
    }
    if (tableBuf) {
      const m = line.match(TEXT);
      if (m) tableBuf.lines.push(m[2]);
      continue;
    }

    const tm = line.match(TEXT);
    if (tm) {
      flushCode();
      const attrs = safeJSON(tm[1]) || {};
      const content = tm[2];

      // equation: %[text] $…$   (optionally `${"altText":"…"}`)
      const eq = content.match(/^\$(.*)\$(\{[^}]*\})?\s*$/);
      if (eq) {
        flushText();
        const meta = safeJSON(eq[2]) || {};
        chunks.push({ kind: 'equation', latex: eq[1], altText: meta.altText });
        continue;
      }
      // standalone image: %[text] ![alt](url)
      const img = content.match(/^!\[([^\]]*)\]\(([^)]*)\)\s*$/);
      if (img) {
        flushText();
        chunks.push({ kind: 'image-ref', alt: img[1], url: img[2] });
        continue;
      }
      // ordinary prose / heading / list / link. A trailing ` \` on a list line
      // marks "list continues"; it carries no markdown meaning, so drop it.
      const clean = content.replace(/\s+\\$/, '');
      if (!textBuf) textBuf = { lines: [], align: attrs.align };
      else if (attrs.align && !textBuf.align) textBuf.align = attrs.align;
      textBuf.lines.push(clean);
      continue;
    }

    // standalone control marker
    const cm = line.match(CONTROL);
    if (cm) {
      flushText();
      pushControl(chunks, codeBuf, cm[1], cm[2], safeJSON(cm[3]));
      continue;
    }
    // standalone output marker — ReRun re-executes, so ignore it entirely
    if (OUTPUT.test(line)) { continue; }

    // blank line: paragraph break in prose, cell boundary in code
    if (!line.trim()) {
      if (codeBuf) flushCode();
      else if (textBuf) textBuf.lines.push('');
      continue;
    }

    // otherwise: a bare code line, possibly with a trailing control/output marker
    flushText();
    let codeLine = line;
    const trail = line.match(TRAILING);
    let trailingControl = null;
    if (trail) {
      codeLine = line.slice(0, line.length - trail[0].length).replace(/\s+$/, '');
      if (trail[1] === 'control') {
        trailingControl = { ctype: trail[2].split(':')[0], id: trail[2].split(':').slice(1).join(':'), attrs: safeJSON(trail[3]) };
      }
      // trailing %[output:…] is dropped
    }
    if (!codeBuf) codeBuf = { kind: 'code', lines: [], controls: [], index: chunks.length };
    codeBuf.lines.push(codeLine);
    if (trailingControl) {
      pushControl(chunks, codeBuf, trailingControl.ctype, trailingControl.id, trailingControl.attrs, codeBuf.lines.length - 1);
    }
  }
  flushText(); flushTable(); flushCode();

  return { chunks, appendix };
}

/** Record a control-ref both standalone (ordered stream) and on its code chunk. */
function pushControl(chunks, codeBuf, ctype, id, attrs, lineInChunk = null) {
  const pos = attrs && Array.isArray(attrs.position) ? attrs.position : null;
  const ref = {
    kind: 'control-ref',
    ctype,
    id,
    position: pos,
    codeChunkIndex: codeBuf ? codeBuf.index : null,
    line: lineInChunk,
  };
  chunks.push(ref);
  if (codeBuf) codeBuf.controls.push(ref);
}

function splitTableRow(l) {
  return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

function emptyAppendix() {
  return { version: null, controls: {}, outputs: {}, images: {}, metadata: {} };
}

/** Parse the %[appendix] block: %--- separated sections, each `%[type:id]`
 *  followed by `%   data: {json}`. */
function parseAppendix(lines) {
  const out = emptyAppendix();
  const head = lines[0]?.match(APPENDIX);
  if (head) out.version = (safeJSON(head[1]) || {}).version ?? null;

  let cur = null; // { marker:'control'|'output'|'image'|'metadata', ctype, id, dataText }
  const finish = () => {
    if (!cur) return;
    const data = safeJSON(cur.dataText);
    if (cur.marker === 'control') out.controls[cur.id] = { ctype: cur.ctype, data };
    else if (cur.marker === 'output') out.outputs[cur.id] = { data };
    else if (cur.marker === 'image') out.images[cur.id] = { data };
    else if (cur.marker === 'metadata') out.metadata[cur.id] = data;
    cur = null;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^%---\s*$/.test(line)) { finish(); continue; }
    const mk = line.match(/^%\[([a-zA-Z]+)(?::([^\]]+))?\]\s*$/);
    if (mk) {
      finish();
      const kind = mk[1];
      const rest = mk[2] ?? '';
      if (kind === 'control') {
        // %[control:slider:id]
        const [ctype, ...idParts] = rest.split(':');
        cur = { marker: 'control', ctype, id: idParts.join(':'), dataText: '' };
      } else if (kind === 'output') {
        cur = { marker: 'output', id: rest, dataText: '' };
      } else if (kind === 'image') {
        cur = { marker: 'image', id: rest, dataText: '' };
      } else if (kind === 'metadata') {
        cur = { marker: 'metadata', id: rest, dataText: '' };
      } else {
        cur = null;
      }
      continue;
    }
    // `%   data: {…}` (or a continuation line of the JSON)
    if (cur) {
      const dm = line.match(/^%\s*data:\s*(.*)$/);
      if (dm) cur.dataText += dm[1];
      else if (/^%/.test(line)) cur.dataText += line.replace(/^%\s?/, '');
    }
  }
  finish();
  return out;
}

/** Render a control's default value as a code literal for splicing (Phase 1).
 *  Numbers/bools splice raw; strings are single-quoted; arrays (e.g. an RGB
 *  colorPicker) become a bracket vector. Returns null when there is no default. */
export function controlDefaultLiteral(data) {
  if (!data || !('defaultValue' in data)) return null;
  const v = data.defaultValue;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (Array.isArray(v)) return `[${v.join(' ')}]`;
  return null;
}
