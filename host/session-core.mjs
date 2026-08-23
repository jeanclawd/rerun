// session-core — the RunMat-session-to-Jupyter glue, environment-neutral.
//
// Used verbatim by both faces of the kernel:
//   host/session-host.mjs          (Node, behind the native Python kernel)
//   litekernel/src/…               (browser, inside the JupyterLite kernel)
//
// It owns the fiddly parts so they exist once:
//   - line-buffered stdout streaming (echoes can flush after executeRequest)
//   - holding back `x = GpuTensor(…)` echoes and substituting materialised
//     values (runmat 0.6.1 leaks accelerator handles into display)
//   - deduping the runtime's double-report of the same unmaterialised buffer
//   - exporting figure scenes and rendering them to SVG via figrender
//   - normalising workspace snapshots and errors

import { renderFigureScene } from "./figrender.mjs";

const GPU_ECHO = /^(\w+) = GpuTensor\([^)]*\)\s*$/;

export function cleanWorkspace(ws) {
  return (ws?.values ?? []).map((v) => ({
    name: v.name,
    className: v.className,
    dtype: v.dtype ?? null,
    shape: v.shape ?? [],
    isGpu: !!v.isGpu,
    sizeBytes: v.sizeBytes ?? null,
    preview: v.preview?.values?.slice(0, 12) ?? null,
    previewTruncated: !!v.preview?.truncated || (v.preview?.values?.length ?? 0) > 12,
  }));
}

const fmtNum = (x) => (Number.isInteger(x) ? String(x) : Number(x).toPrecision(5));

async function materialiseLabel(session, label) {
  try {
    const v = await session.materializeVariable({ name: label }, { maxElements: 8 });
    const values = v?.preview?.values;
    if (values && values.length > 0) {
      return values.map(fmtNum).join("  ") + (v.preview.truncated ? " …" : "");
    }
  } catch {
    /* fall through */
  }
  return null;
}

function snapshotFallback(label, text, workspace) {
  if (!/^GpuTensor\(/.test(String(text).trim())) return text;
  const entry = (workspace?.values ?? []).find((v) => v.name === label);
  const values = entry?.preview?.values;
  if (!values || values.length === 0) return `${text}  (value not materialized)`;
  return values.slice(0, 8).map(fmtNum).join(", ") + (entry.preview.truncated || values.length > 8 ? " …" : "");
}

/**
 * A single-session executor. `subscribeStdout` events must be routed to
 * `feedStdout` by the embedder (Node and browser subscribe differently).
 */
export class SessionRunner {
  constructor(session, { figureWidth = 700, figureHeight = 430, figureOptions = {} } = {}) {
    this.session = session;
    this.figureOptions = { width: figureWidth, height: figureHeight, ...figureOptions };
    this._active = false;
    this._onStream = null;
    this._tail = "";
    this._streamed = "";
    this._held = [];
    // The raw wasm session reports workspace *deltas* ({full:false, values,
    // removals}) on some requests; merge them so consumers always see the
    // whole workspace.
    this._ws = new Map();
  }

  _mergeWorkspace(ws) {
    if (!ws) return this.workspace();
    if (ws.full) this._ws.clear();
    for (const name of ws.removals ?? []) this._ws.delete(name);
    for (const v of ws.values ?? []) this._ws.set(v.name, v);
    return this.workspace();
  }

  /** The full, merged workspace as normalised entries. */
  workspace() {
    return cleanWorkspace({ values: [...this._ws.values()].sort((a, b) => a.name.localeCompare(b.name)) });
  }

  /** Forget everything (call alongside session.resetSession()). */
  clear() {
    this._ws.clear();
  }

  /** Route a subscribeStdout entry here. Safe to call when idle. */
  feedStdout(entry) {
    if (!this._active) return;
    const text = entry.text ?? entry.chunk ?? "";
    if (entry.stream === "stderr") {
      this._onStream?.({ name: "stderr", text });
      return;
    }
    this._tail += text;
    let nl;
    while ((nl = this._tail.indexOf("\n")) >= 0) {
      this._line(this._tail.slice(0, nl));
      this._tail = this._tail.slice(nl + 1);
    }
  }

  _line(line) {
    const m = line.match(GPU_ECHO);
    if (m) {
      this._held.push({ label: m[1], raw: line });
      return;
    }
    this._streamed += line + "\n";
    this._onStream?.({ name: "stdout", text: line + "\n" });
  }

  /**
   * Execute one cell. Streams flow through `onStream({name, text})` while it
   * runs; the resolved value carries displays, SVG figures, the workspace,
   * and a normalised error (or null).
   */
  async exec(code, { name = "<cell>", onStream = null } = {}) {
    this._active = true;
    this._onStream = onStream;
    this._tail = "";
    this._streamed = "";
    this._held = [];
    const started = Date.now();

    let result;
    try {
      result = await this.session.executeRequest({ source: { kind: "text", name, text: code } });
    } finally {
      if (this._tail.trim()) this._line(this._tail.replace(/\n$/, ""));
      this._tail = "";
      this._active = false;
    }

    // Held-back GpuTensor echoes → materialised values.
    const displays = [];
    for (const held of this._held) {
      const text =
        (await materialiseLabel(this.session, held.label)) ??
        snapshotFallback(held.label, held.raw.slice(held.label.length + 3), result.workspace);
      displays.push({ label: held.label, text });
    }
    const heldRaw = new Set(this._held.map((h) => h.raw.slice(h.label.length + 3).trim()));
    this._held = [];

    // Display events: skip ones that already streamed or duplicate a held buffer.
    for (const ev of result.displayEvents ?? []) {
      const rawText = String(ev.valueText ?? "").trim();
      if (heldRaw.has(rawText)) continue;
      let shown = snapshotFallback(ev.label, ev.valueText, result.workspace);
      if (/^GpuTensor\(/.test(String(shown).trim()) && ev.label) {
        shown = (await materialiseLabel(this.session, ev.label)) ?? shown;
      }
      if (shown && !this._streamed.includes(rawText) && !this._streamed.includes(String(shown).trim())) {
        displays.push({ label: ev.label ?? null, text: shown });
      }
    }

    // Figures: exported scene JSON → SVG. No GPU anywhere in this path.
    const figures = [];
    for (const handle of result.figuresTouched ?? []) {
      try {
        const bytes = await this.session.exportFigureScene(handle);
        if (!bytes || bytes.length === 0) continue;
        const scene = JSON.parse(new TextDecoder().decode(bytes));
        figures.push({
          handle,
          kinds: [...new Set((scene.figure.plots ?? []).map((p) => p.kind))],
          svg: renderFigureScene(scene, this.figureOptions),
        });
      } catch (err) {
        figures.push({ handle, error: String(err?.message ?? err) });
      }
    }

    const error = result.error
      ? {
          kind: result.error.kind ?? "runtime",
          identifier: result.error.identifier ?? null,
          message: result.error.message,
          line: result.error.span?.line ?? null,
          column: result.error.span?.column ?? null,
        }
      : null;

    return {
      ok: !error,
      durationMs: Date.now() - started,
      displays,
      figures,
      warnings: (result.warnings ?? []).map((w) => w.message ?? String(w)),
      workspace: this._mergeWorkspace(result.workspace),
      error,
    };
  }
}
