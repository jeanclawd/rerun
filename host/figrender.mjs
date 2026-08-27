// figrender — render a RunMat figure scene to SVG, with no GPU involved.
//
// RunMat's plotting normally goes through its wgpu renderer, so `plot(...)`
// draws nothing in a browser without a working WebGPU adapter, and there is no
// fallback in the package. But `session.exportFigureScene(handle)` hands back
// JSON that contains the entire figure — every series' data, colours, line and
// marker styles, per-axes limits, log flags, grid state, labels, legend entries
// and text annotations. That is enough to draw the figure ourselves.
//
//   const bytes = await session.exportFigureScene(handle);
//   const svg = renderFigureScene(JSON.parse(new TextDecoder().decode(bytes)));
//
// Zero dependencies, no DOM: the output is an SVG string, so this works in a
// browser, in Node, and server-side.
//
// Supported plot kinds: line, line3 (projected to xy), scatter, bar (vertical,
// horizontal, grouped, stacked, histogram bin edges), stairs, stem, area,
// error_bar, quiver, pie, reference_line (xline/yline), plus per-axes text
// annotations and subplot grids. 3D surfaces/meshes are reported as unsupported
// rather than drawn wrong; see UNSUPPORTED_KINDS.

export const UNSUPPORTED_KINDS = new Set(["surface", "mesh", "scatter3", "contour", "contour_fill"]);

const THEMES = {
  light: {
    figure: "#ffffff", axes: "#ffffff", frame: "#3c3c3c", grid: "#d0d0d0",
    text: "#1a1a1a", muted: "#555555", legendFill: "#ffffff", legendStroke: "#b0b0b0",
  },
  dark: {
    figure: "#16181d", axes: "#1d2027", frame: "#8a8f98", grid: "#2f343d",
    text: "#e6e6e6", muted: "#a0a6b0", legendFill: "#1d2027", legendStroke: "#454b56",
  },
};

const DASHES = { solid: null, dash: "8 5", dot: "2 4", dashdot: "8 4 2 4", none: null };

// RunMat 0.6.1 does not cycle colors: every default-styled series in an axes
// gets the SAME color (line family [0.35,0.78,0.48], scatter [0,0.4,0.8]), so
// `plot(a); hold on; plot(b)` is indistinguishable. The `.m` language cycles its
// ColorOrder. When two or more series in one axes share an engine default,
// re-color them (and their legend swatches) with the `.m` language's ColorOrder — an
// explicit user color ('r', RGB triplet) never matches a default and is left
// alone. Disable with options.cycleDefaults = false.
const ENGINE_DEFAULTS = [
  [0.35, 0.78, 0.48],
  [0, 0.4, 0.8],
  [0, 0.447, 0.741],
];
const MATLAB_ORDER = [
  [0, 0.447, 0.741], [0.85, 0.325, 0.098], [0.929, 0.694, 0.125],
  [0.494, 0.184, 0.556], [0.466, 0.674, 0.188], [0.301, 0.745, 0.933],
  [0.635, 0.078, 0.184],
];
const CYCLABLE = new Set(["line", "line3", "scatter", "stairs", "stem", "area", "error_bar"]);

const sameColor = (a, b) =>
  Array.isArray(a) && a.length >= 3 && Math.abs(a[0] - b[0]) < 5e-3 && Math.abs(a[1] - b[1]) < 5e-3 && Math.abs(a[2] - b[2]) < 5e-3;

function cycleDefaultColors(fig) {
  const byAxes = new Map();
  for (const p of fig.plots ?? []) {
    if (!CYCLABLE.has(p.kind)) continue;
    if (!ENGINE_DEFAULTS.some((d) => sameColor(p.color_rgba, d))) continue;
    const key = p.axes_index ?? 0;
    if (!byAxes.has(key)) byAxes.set(key, []);
    byAxes.get(key).push(p);
  }
  const recolored = new Map(); // label -> new color, for legend swatches
  for (const group of byAxes.values()) {
    if (group.length < 2) continue; // a single default series keeps the engine look
    group.forEach((p, i) => {
      const alpha = Array.isArray(p.color_rgba) && p.color_rgba.length > 3 ? p.color_rgba[3] : 1;
      p.color_rgba = [...MATLAB_ORDER[i % MATLAB_ORDER.length], alpha];
      if (p.label != null) recolored.set(p.label, p.color_rgba);
    });
  }
  for (const e of fig.metadata?.legendEntries ?? []) {
    const c = recolored.get(e.label);
    if (c) e.colorRgba = c;
  }
}

// RunMat populates `legendEntries` for every series whether or not the script
// called `legend()`, and `legendEnabled` is true either way — so the scene
// carries no signal for "a legend was actually requested" (see
// ../issues/10-figure-scene-export-gaps.md). The `.m` language only draws one when asked.
// Heuristic: a single series whose label is one of RunMat's auto-generated
// defaults tells the reader nothing, so suppress it; anything else is kept.
const AUTO_LABEL = /^(series \d+|data|frequency|count|y|z|__\w+)$/i;
const DEFAULT_OPTIONS = {
  width: 640, height: 480, theme: "light",
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  fontSize: 12, titleFontSize: 15, padding: 12, tickCount: 6,
  // "auto" draws a legend only when it carries information — see AUTO_LABEL.
  legend: "auto",
  // Optional per-key overrides on top of the chosen theme, so a host app can
  // match its own palette: {figure, axes, frame, grid, text, muted,
  // legendFill, legendStroke}. Any subset is fine.
  palette: null,
  // A scene's own metadata.position carries the `.m` language's figure size; honour it
  // unless the caller pins width/height explicitly.
  useScenePosition: true,
};

// ---------------------------------------------------------------- utilities

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

function rgba(c, fallback = "#1f77b4") {
  if (!Array.isArray(c) || c.length < 3) return fallback;
  const [r, g, b, a = 1] = c;
  const to255 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  return a >= 0.999
    ? `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`
    : `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${Math.round(a * 1000) / 1000})`;
}

const dashFor = (style) => DASHES[String(style ?? "solid").toLowerCase()] ?? null;
const isFinitePair = (x, y) => Number.isFinite(x) && Number.isFinite(y);

/** 1–2–5 "nice" ticks spanning [lo, hi]. */
function niceTicks(lo, hi, target) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(2, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) {
    out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return out.length ? out : [lo, hi];
}

/** Decade ticks for a log axis, thinned if the span is wide. */
function logTicks(lo, hi) {
  const first = Math.floor(Math.log10(lo));
  const last = Math.ceil(Math.log10(hi));
  const stride = Math.max(1, Math.ceil((last - first) / 8));
  const out = [];
  for (let e = first; e <= last; e += stride) {
    const v = Math.pow(10, e);
    if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
  }
  return out.length ? out : [lo, hi];
}

/** Log ticks are decades: label them as plain numbers or as 1eN, never rounded. */
function formatLogTick(v) {
  if (!(v > 0)) return "";
  const e = Math.round(Math.log10(v));
  if (Math.abs(Math.pow(10, e) - v) > Math.abs(v) * 1e-9) return String(Number(v.toPrecision(3)));
  if (e >= -3 && e <= 5) return Number(Math.pow(10, e).toPrecision(6)).toString();
  return `1e${e}`;
}

function formatTick(v, span) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-4) return v.toExponential(1).replace("e+", "e");
  const decimals = span > 0 ? Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(span / 6)))) : 2;
  return Number(v.toFixed(decimals)).toString();
}

// ---------------------------------------------------------------- data extent

/** Grow `ext` to include the data of one plot. */
function extendExtent(ext, p) {
  const push = (x, y) => {
    if (Number.isFinite(x)) { ext.xmin = Math.min(ext.xmin, x); ext.xmax = Math.max(ext.xmax, x); }
    if (Number.isFinite(y)) { ext.ymin = Math.min(ext.ymin, y); ext.ymax = Math.max(ext.ymax, y); }
  };
  const xs = p.x ?? [], ys = p.y ?? [];

  switch (p.kind) {
    case "bar": {
      const n = (p.values ?? []).length;
      const edges = p.histogram_bin_edges;
      const horizontal = String(p.orientation ?? "Vertical").toLowerCase() === "horizontal";
      for (let i = 0; i < n; i++) {
        const base = (p.stack_offsets?.[i] ?? 0);
        const v = base + (p.values[i] ?? 0);
        const [lo, hi] = edges ? [edges[i], edges[i + 1]] : [i + 0.5, i + 1.5];
        if (horizontal) { push(base, lo); push(v, hi); } else { push(lo, base); push(hi, v); }
      }
      break;
    }
    case "area":
      for (let i = 0; i < xs.length; i++) {
        push(xs[i], ys[i]);
        push(xs[i], p.lower_y?.[i] ?? p.baseline ?? 0);
      }
      break;
    case "stem":
      for (let i = 0; i < xs.length; i++) { push(xs[i], ys[i]); push(xs[i], p.baseline ?? 0); }
      break;
    case "error_bar":
      for (let i = 0; i < xs.length; i++) {
        push(xs[i] - (p.x_err_low?.[i] ?? 0), ys[i] - (p.err_low?.[i] ?? 0));
        push(xs[i] + (p.x_err_high?.[i] ?? 0), ys[i] + (p.err_high?.[i] ?? 0));
      }
      break;
    case "quiver": {
      const s = p.scale ?? 1;
      for (let i = 0; i < xs.length; i++) {
        push(xs[i], ys[i]);
        push(xs[i] + (p.u?.[i] ?? 0) * s, ys[i] + (p.v?.[i] ?? 0) * s);
      }
      break;
    }
    case "reference_line": // xline/yline should not drive the limits
    case "pie":
      break;
    default:
      for (let i = 0; i < Math.max(xs.length, ys.length); i++) push(xs[i], ys[i]);
  }
  return ext;
}

function computeExtent(plots, meta) {
  let ext = { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity };
  for (const p of plots) if (p.visible !== false) ext = extendExtent(ext, p);

  const fix = (lo, hi) => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (lo === hi) return lo === 0 ? [-1, 1] : [lo - Math.abs(lo) * 0.1, hi + Math.abs(hi) * 0.1];
    return [lo, hi];
  };
  let [xmin, xmax] = fix(ext.xmin, ext.xmax);
  let [ymin, ymax] = fix(ext.ymin, ext.ymax);

  // the `.m` language fits x tightly and pads y a little. Pad in log space on a log axis,
  // otherwise the padding can push the lower bound to or past zero.
  if (meta?.yLog) {
    if (ymin > 0 && ymax > 0) {
      const f = Math.pow(ymax / ymin, 0.04);
      ymin /= f; ymax *= f;
    }
  } else {
    const padY = (ymax - ymin) * 0.06;
    ymin -= padY; ymax += padY;
  }

  if (Array.isArray(meta?.xLimits) && meta.xLimits.length === 2) [xmin, xmax] = meta.xLimits;
  if (Array.isArray(meta?.yLimits) && meta.yLimits.length === 2) [ymin, ymax] = meta.yLimits;

  // A log axis cannot show non-positive values.
  if (meta?.xLog) { xmin = xmin > 0 ? xmin : 1e-3; xmax = xmax > xmin ? xmax : xmin * 10; }
  if (meta?.yLog) { ymin = ymin > 0 ? ymin : 1e-3; ymax = ymax > ymin ? ymax : ymin * 10; }

  return { xmin, xmax, ymin, ymax };
}

// ---------------------------------------------------------------- primitives

function markerPath(style, cx, cy, size) {
  const r = Math.max(1.5, size / 2);
  switch (String(style ?? "circle").toLowerCase()) {
    case "square": return `M${num(cx - r)},${num(cy - r)}h${num(2 * r)}v${num(2 * r)}h${num(-2 * r)}Z`;
    case "diamond": return `M${num(cx)},${num(cy - r)}L${num(cx + r)},${num(cy)}L${num(cx)},${num(cy + r)}L${num(cx - r)},${num(cy)}Z`;
    case "triangleup": case "triangle": return `M${num(cx)},${num(cy - r)}L${num(cx + r)},${num(cy + r)}L${num(cx - r)},${num(cy + r)}Z`;
    case "triangledown": return `M${num(cx)},${num(cy + r)}L${num(cx + r)},${num(cy - r)}L${num(cx - r)},${num(cy - r)}Z`;
    case "plus": return `M${num(cx - r)},${num(cy)}H${num(cx + r)}M${num(cx)},${num(cy - r)}V${num(cy + r)}`;
    case "cross": case "x": return `M${num(cx - r)},${num(cy - r)}L${num(cx + r)},${num(cy + r)}M${num(cx - r)},${num(cy + r)}L${num(cx + r)},${num(cy - r)}`;
    case "asterisk": case "star": return `M${num(cx - r)},${num(cy)}H${num(cx + r)}M${num(cx)},${num(cy - r)}V${num(cy + r)}M${num(cx - r * 0.7)},${num(cy - r * 0.7)}L${num(cx + r * 0.7)},${num(cy + r * 0.7)}M${num(cx - r * 0.7)},${num(cy + r * 0.7)}L${num(cx + r * 0.7)},${num(cy - r * 0.7)}`;
    default: return null; // circle — emitted as <circle>
  }
}

const OPEN_MARKERS = new Set(["plus", "cross", "x", "asterisk", "star"]);

function marker(style, cx, cy, size, color, filled) {
  const key = String(style ?? "circle").toLowerCase();
  const stroke = `stroke="${color}" stroke-width="1.4"`;
  if (OPEN_MARKERS.has(key)) return `<path d="${markerPath(key, cx, cy, size)}" fill="none" ${stroke}/>`;
  const fill = filled === false ? `fill="none"` : `fill="${color}"`;
  const d = markerPath(key, cx, cy, size);
  return d
    ? `<path d="${d}" ${fill} ${stroke}/>`
    : `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(Math.max(1.5, size / 2))}" ${fill} ${stroke}/>`;
}

function polyline(points, color, width, dash, extra = "") {
  if (points.length < 2) return "";
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${num(x)},${num(y)}`).join("");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}${extra}/>`;
}

// ---------------------------------------------------------------- plot kinds

/** Draw one plot inside an axes. `sx`/`sy` map data coords to pixels. */
function drawPlot(p, sx, sy, ax, opt, theme) {
  const color = rgba(p.color_rgba);
  const lw = p.line_width ?? 1.5;
  const dash = dashFor(p.line_style);
  const xs = p.x ?? [], ys = p.y ?? [];
  const out = [];

  const pts = () => {
    const acc = [];
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
      if (!isFinitePair(xs[i], ys[i])) continue;               // NaN breaks the line in the `.m` language
      const px = sx(xs[i]), py = sy(ys[i]);
      if (Number.isFinite(px) && Number.isFinite(py)) acc.push([px, py]);
    }
    return acc;
  };

  switch (p.kind) {
    case "line":
    case "line3":
      out.push(polyline(pts(), color, lw, dash));
      break;

    case "scatter": {
      const size = p.marker_size ?? 6;
      for (const [px, py] of pts()) out.push(marker(p.marker_style, px, py, size, color, p.marker_filled !== false));
      break;
    }

    case "stairs": {
      const acc = [];
      const q = pts();
      for (let i = 0; i < q.length; i++) {
        acc.push(q[i]);
        if (i + 1 < q.length) acc.push([q[i + 1][0], q[i][1]]);
      }
      out.push(polyline(acc, color, lw, dash));
      break;
    }

    case "stem": {
      const base = sy(p.baseline ?? 0);
      const mcolor = rgba(p.marker_color_rgba ?? p.color_rgba);
      for (const [px, py] of pts()) {
        out.push(`<line x1="${num(px)}" y1="${num(base)}" x2="${num(px)}" y2="${num(py)}" stroke="${color}" stroke-width="${lw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
        out.push(marker("circle", px, py, p.marker_size ?? 6, mcolor, p.marker_filled !== false));
      }
      if (p.baseline_visible !== false) {
        out.push(`<line x1="${num(ax.x)}" y1="${num(base)}" x2="${num(ax.x + ax.w)}" y2="${num(base)}" stroke="${rgba(p.baseline_color_rgba ?? p.color_rgba)}" stroke-width="1"/>`);
      }
      break;
    }

    case "area": {
      const top = pts();
      if (top.length < 2) break;
      const bottom = [];
      for (let i = xs.length - 1; i >= 0; i--) {
        const yb = p.lower_y?.[i] ?? p.baseline ?? 0;
        if (isFinitePair(xs[i], yb)) bottom.push([sx(xs[i]), sy(yb)]);
      }
      const d = [...top, ...bottom].map(([x, y], i) => `${i ? "L" : "M"}${num(x)},${num(y)}`).join("") + "Z";
      out.push(`<path d="${d}" fill="${color}" stroke="${rgba(p.color_rgba)}" stroke-width="1"/>`);
      break;
    }

    case "bar": {
      const values = p.values ?? [];
      const edges = p.histogram_bin_edges;
      const horizontal = String(p.orientation ?? "Vertical").toLowerCase() === "horizontal";
      const groups = Math.max(1, p.group_count ?? 1);
      const gi = p.group_index ?? 0;
      const bw = p.bar_width ?? 0.75;
      const outline = p.outline_color_rgba ? rgba(p.outline_color_rgba) : null;

      for (let i = 0; i < values.length; i++) {
        const base = p.stack_offsets?.[i] ?? 0;
        const v = base + (values[i] ?? 0);
        // Category slot: bin edges when present, else unit-wide slot at i+1.
        let lo, hi;
        if (edges) { lo = edges[i]; hi = edges[i + 1]; }
        else {
          const centre = i + 1 - bw / 2 + (bw / groups) * (gi + 0.5);
          const half = bw / groups / 2;
          lo = centre - half; hi = centre + half;
        }
        const [a1, a2] = horizontal ? [sy(hi), sy(lo)] : [sx(lo), sx(hi)];
        const [b1, b2] = horizontal ? [sx(base), sx(v)] : [sy(base), sy(v)];
        const x = horizontal ? Math.min(b1, b2) : Math.min(a1, a2);
        const y = horizontal ? Math.min(a1, a2) : Math.min(b1, b2);
        const w = Math.abs(horizontal ? b2 - b1 : a2 - a1);
        const h = Math.abs(horizontal ? a2 - a1 : b2 - b1);
        out.push(`<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${color}"${outline ? ` stroke="${outline}" stroke-width="${p.outline_width ?? 1}"` : ""}/>`);
      }
      break;
    }

    case "error_bar": {
      const cap = (p.cap_width ?? 6) / 2;
      const q = pts();
      out.push(polyline(q, color, lw, dash));
      for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
        const px = sx(xs[i]);
        const lo = sy(ys[i] - (p.err_low?.[i] ?? 0));
        const hi = sy(ys[i] + (p.err_high?.[i] ?? 0));
        if (lo !== hi) {
          out.push(`<line x1="${num(px)}" y1="${num(lo)}" x2="${num(px)}" y2="${num(hi)}" stroke="${color}" stroke-width="1.2"/>`);
          out.push(`<line x1="${num(px - cap)}" y1="${num(lo)}" x2="${num(px + cap)}" y2="${num(lo)}" stroke="${color}" stroke-width="1.2"/>`);
          out.push(`<line x1="${num(px - cap)}" y1="${num(hi)}" x2="${num(px + cap)}" y2="${num(hi)}" stroke="${color}" stroke-width="1.2"/>`);
        }
        const xl = sx(xs[i] - (p.x_err_low?.[i] ?? 0)), xh = sx(xs[i] + (p.x_err_high?.[i] ?? 0));
        if (xl !== xh) {
          const py = sy(ys[i]);
          out.push(`<line x1="${num(xl)}" y1="${num(py)}" x2="${num(xh)}" y2="${num(py)}" stroke="${color}" stroke-width="1.2"/>`);
        }
        if (p.marker_style) {
          out.push(marker(p.marker_style, px, sy(ys[i]), p.marker_size ?? 6,
            rgba(p.marker_face_color ?? p.color_rgba), p.marker_filled !== false));
        }
      }
      break;
    }

    case "quiver": {
      const s = p.scale ?? 1;
      const head = p.head_size ?? 0.1;
      for (let i = 0; i < xs.length; i++) {
        const x0 = sx(xs[i]), y0 = sy(ys[i]);
        const x1 = sx(xs[i] + (p.u?.[i] ?? 0) * s), y1 = sy(ys[i] + (p.v?.[i] ?? 0) * s);
        if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
        out.push(`<line x1="${num(x0)}" y1="${num(y0)}" x2="${num(x1)}" y2="${num(y1)}" stroke="${color}" stroke-width="${lw}"/>`);
        const ang = Math.atan2(y1 - y0, x1 - x0);
        const len = Math.max(6, Math.hypot(x1 - x0, y1 - y0) * Math.max(0.08, head));
        const spread = 0.4;
        out.push(`<path d="M${num(x1)},${num(y1)}L${num(x1 - len * Math.cos(ang - spread))},${num(y1 - len * Math.sin(ang - spread))}M${num(x1)},${num(y1)}L${num(x1 - len * Math.cos(ang + spread))},${num(y1 - len * Math.sin(ang + spread))}" fill="none" stroke="${color}" stroke-width="${lw}"/>`);
      }
      break;
    }

    case "reference_line": {
      const horizontal = String(p.orientation ?? "horizontal").toLowerCase() === "horizontal";
      const d = dashFor(p.line_style) ?? "6 4";
      if (horizontal) {
        const y = sy(p.value);
        out.push(`<line x1="${num(ax.x)}" y1="${num(y)}" x2="${num(ax.x + ax.w)}" y2="${num(y)}" stroke="${color}" stroke-width="${p.line_width ?? 1}" stroke-dasharray="${d}"/>`);
      } else {
        const x = sx(p.value);
        out.push(`<line x1="${num(x)}" y1="${num(ax.y)}" x2="${num(x)}" y2="${num(ax.y + ax.h)}" stroke="${color}" stroke-width="${p.line_width ?? 1}" stroke-dasharray="${d}"/>`);
      }
      const label = p.label ?? p.display_name;
      if (label) {
        const [tx, ty] = horizontal ? [ax.x + ax.w - 4, sy(p.value) - 4] : [sx(p.value) + 4, ax.y + 12];
        out.push(`<text x="${num(tx)}" y="${num(ty)}" font-size="${opt.fontSize - 1}" fill="${color}" text-anchor="${horizontal ? "end" : "start"}">${esc(label)}</text>`);
      }
      break;
    }

    default:
      break; // unsupported kinds are reported by the caller
  }
  return out.join("");
}

// ---------------------------------------------------------------- pie

function drawPie(p, ax, opt, theme) {
  const values = (p.values ?? []).map(Math.abs);
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return "";
  const cx = ax.x + ax.w / 2, cy = ax.y + ax.h / 2;
  const r = Math.min(ax.w, ax.h) / 2 - 28;
  const out = [];
  let angle = -Math.PI / 2; // the `.m` language starts at 12 o'clock, going clockwise
  for (let i = 0; i < values.length; i++) {
    const frac = values[i] / total;
    const sweep = frac * Math.PI * 2;
    const explode = (p.explode?.[i] ?? 0) ? 0.1 * r : 0;
    const mid = angle + sweep / 2;
    const ox = Math.cos(mid) * explode, oy = Math.sin(mid) * explode;
    const x0 = cx + ox + r * Math.cos(angle), y0 = cy + oy + r * Math.sin(angle);
    const x1 = cx + ox + r * Math.cos(angle + sweep), y1 = cy + oy + r * Math.sin(angle + sweep);
    const large = sweep > Math.PI ? 1 : 0;
    const fill = rgba(p.colors_rgba?.[i], "#888");
    out.push(`<path d="M${num(cx + ox)},${num(cy + oy)}L${num(x0)},${num(y0)}A${num(r)},${num(r)} 0 ${large} 1 ${num(x1)},${num(y1)}Z" fill="${fill}" stroke="${theme.axes}" stroke-width="1.5"/>`);
    const label = p.slice_labels?.[i] ?? `${Math.round(frac * 100)}%`;
    const lx = cx + ox + (r + 16) * Math.cos(mid), ly = cy + oy + (r + 16) * Math.sin(mid);
    out.push(`<text x="${num(lx)}" y="${num(ly + 4)}" font-size="${opt.fontSize}" fill="${theme.text}" text-anchor="${Math.cos(mid) < -0.2 ? "end" : Math.cos(mid) > 0.2 ? "start" : "middle"}">${esc(label)}</text>`);
    angle += sweep;
  }
  return out.join("");
}

// ---------------------------------------------------------------- legend

/**
 * Pick the corner holding the fewest plotted points, so the legend covers as
 * little data as possible — the `.m` language's "best" location, crudely.
 */
function bestCorner(plots, sx, sy, ax, w, h) {
  const boxes = {
    ne: { x: ax.x + ax.w - w - 8, y: ax.y + 8 },
    nw: { x: ax.x + 8, y: ax.y + 8 },
    se: { x: ax.x + ax.w - w - 8, y: ax.y + ax.h - h - 8 },
    sw: { x: ax.x + 8, y: ax.y + ax.h - h - 8 },
  };
  const counts = { ne: 0, nw: 0, se: 0, sw: 0 };
  for (const p of plots) {
    const xs = p.x ?? [], ys = p.y ?? [];
    const stride = Math.max(1, Math.floor(xs.length / 200)); // sample long series
    for (let i = 0; i < Math.min(xs.length, ys.length); i += stride) {
      const px = sx(xs[i]), py = sy(ys[i]);
      if (!isFinitePair(px, py)) continue;
      for (const [k, b] of Object.entries(boxes)) {
        if (px >= b.x - 4 && px <= b.x + w + 4 && py >= b.y - 4 && py <= b.y + h + 4) counts[k]++;
      }
    }
  }
  const best = Object.keys(boxes).sort((a, b) => counts[a] - counts[b])[0];
  return boxes[best];
}

function drawLegend(entries, ax, opt, theme, plots = [], sx = null, sy = null) {
  if (!entries.length) return "";
  const lh = opt.fontSize + 7;
  const swatch = 18;
  const textW = Math.max(...entries.map((e) => String(e.label ?? "").length)) * opt.fontSize * 0.58;
  const w = swatch + 10 + Math.min(180, Math.max(24, textW)) + 12;
  const h = entries.length * lh + 10;
  const spot = sx && sy ? bestCorner(plots, sx, sy, ax, w, h) : { x: ax.x + ax.w - w - 8, y: ax.y + 8 };
  const x = spot.x, y = spot.y;
  const out = [`<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="3" fill="${theme.legendFill}" fill-opacity="0.88" stroke="${theme.legendStroke}" stroke-width="1"/>`];
  entries.forEach((e, i) => {
    const cy = y + 5 + lh * i + lh / 2;
    const color = rgba(e.colorRgba ?? e.color_rgba);
    const kind = String(e.plotType ?? e.kind ?? "line");
    if (kind === "scatter" || kind === "scatter3") {
      out.push(marker("circle", x + 6 + swatch / 2, cy, 7, color, true));
    } else if (kind === "bar" || kind === "area" || kind === "pie") {
      out.push(`<rect x="${num(x + 6)}" y="${num(cy - 5)}" width="${swatch}" height="10" fill="${color}"/>`);
    } else {
      out.push(`<line x1="${num(x + 6)}" y1="${num(cy)}" x2="${num(x + 6 + swatch)}" y2="${num(cy)}" stroke="${color}" stroke-width="2.2"/>`);
    }
    out.push(`<text x="${num(x + 6 + swatch + 8)}" y="${num(cy + opt.fontSize * 0.35)}" font-size="${opt.fontSize}" fill="${theme.text}">${esc(e.label ?? "")}</text>`);
  });
  return out.join("");
}

// ---------------------------------------------------------------- one axes

function drawAxes(cell, plots, meta, figMeta, opt, theme, warnings) {
  const out = [];
  const pieOnly = plots.length > 0 && plots.every((p) => p.kind === "pie");
  const title = meta?.title ?? (plots.length ? figMeta?.title : null);
  const titleVisible = meta?.titleStyle?.visible !== false;

  // Room for decorations: left for y ticks, bottom for x ticks, top for title.
  const left = pieOnly ? 8 : 58;
  const bottom = pieOnly ? 8 : 44;
  const top = (title && titleVisible ? opt.titleFontSize + 12 : 10);
  const right = 14;
  const ax = {
    x: cell.x + left, y: cell.y + top,
    w: Math.max(10, cell.w - left - right),
    h: Math.max(10, cell.h - top - bottom),
  };

  if (title && titleVisible) {
    out.push(`<text x="${num(cell.x + cell.w / 2)}" y="${num(cell.y + opt.titleFontSize + 2)}" font-size="${opt.titleFontSize}" font-weight="600" fill="${theme.text}" text-anchor="middle">${esc(title)}</text>`);
  }

  if (pieOnly) {
    for (const p of plots) out.push(drawPie(p, ax, opt, theme));
    return { svg: out.join(""), ax, sx: null, sy: null };
  }

  const ext = computeExtent(plots, meta);
  const xLog = !!meta?.xLog, yLog = !!meta?.yLog;
  const lx = (v) => (xLog ? Math.log10(v) : v);
  const ly = (v) => (yLog ? Math.log10(v) : v);
  const x0 = lx(ext.xmin), x1 = lx(ext.xmax), y0 = ly(ext.ymin), y1 = ly(ext.ymax);
  const sx = (v) => ax.x + ((lx(v) - x0) / (x1 - x0 || 1)) * ax.w;
  const sy = (v) => ax.y + ax.h - ((ly(v) - y0) / (y1 - y0 || 1)) * ax.h;

  out.push(`<rect x="${num(ax.x)}" y="${num(ax.y)}" width="${num(ax.w)}" height="${num(ax.h)}" fill="${theme.axes}"/>`);

  const xt = xLog ? logTicks(ext.xmin, ext.xmax) : niceTicks(ext.xmin, ext.xmax, opt.tickCount);
  const yt = yLog ? logTicks(ext.ymin, ext.ymax) : niceTicks(ext.ymin, ext.ymax, opt.tickCount);

  if (meta?.gridEnabled !== false) {
    for (const t of xt) out.push(`<line x1="${num(sx(t))}" y1="${num(ax.y)}" x2="${num(sx(t))}" y2="${num(ax.y + ax.h)}" stroke="${theme.grid}" stroke-width="1"/>`);
    for (const t of yt) out.push(`<line x1="${num(ax.x)}" y1="${num(sy(t))}" x2="${num(ax.x + ax.w)}" y2="${num(sy(t))}" stroke="${theme.grid}" stroke-width="1"/>`);
  }

  // Series, clipped to the axes box.
  const clip = `figclip${Math.round(ax.x)}x${Math.round(ax.y)}`;
  out.push(`<clipPath id="${clip}"><rect x="${num(ax.x)}" y="${num(ax.y)}" width="${num(ax.w)}" height="${num(ax.h)}"/></clipPath>`);
  const body = [];
  for (const p of plots) {
    if (p.visible === false) continue;
    if (UNSUPPORTED_KINDS.has(p.kind)) { warnings.push(`plot kind "${p.kind}" is not rendered (3D/field plot)`); continue; }
    body.push(drawPlot(p, sx, sy, ax, opt, theme));
  }
  out.push(`<g clip-path="url(#${clip})">${body.join("")}</g>`);

  for (const a of meta?.worldTextAnnotations ?? []) {
    if (a?.style?.visible === false) continue;
    const [tx, ty] = a.position ?? [];
    if (!isFinitePair(tx, ty)) continue;
    out.push(`<text x="${num(sx(tx))}" y="${num(sy(ty))}" font-size="${opt.fontSize}" fill="${theme.text}">${esc(a.text)}</text>`);
  }

  // Frame, ticks, tick labels.
  const boxed = meta?.boxEnabled !== false;
  out.push(boxed
    ? `<rect x="${num(ax.x)}" y="${num(ax.y)}" width="${num(ax.w)}" height="${num(ax.h)}" fill="none" stroke="${theme.frame}" stroke-width="1"/>`
    : `<path d="M${num(ax.x)},${num(ax.y)}V${num(ax.y + ax.h)}H${num(ax.x + ax.w)}" fill="none" stroke="${theme.frame}" stroke-width="1"/>`);

  const xSpan = ext.xmax - ext.xmin, ySpan = ext.ymax - ext.ymin;
  const labelX = (t) => (xLog ? formatLogTick(t) : formatTick(t, xSpan));
  const labelY = (t) => (yLog ? formatLogTick(t) : formatTick(t, ySpan));
  for (const t of xt) {
    const px = sx(t);
    out.push(`<line x1="${num(px)}" y1="${num(ax.y + ax.h)}" x2="${num(px)}" y2="${num(ax.y + ax.h + 4)}" stroke="${theme.frame}" stroke-width="1"/>`);
    out.push(`<text x="${num(px)}" y="${num(ax.y + ax.h + 16)}" font-size="${opt.fontSize - 1}" fill="${theme.muted}" text-anchor="middle">${esc(labelX(t))}</text>`);
  }
  for (const t of yt) {
    const py = sy(t);
    out.push(`<line x1="${num(ax.x - 4)}" y1="${num(py)}" x2="${num(ax.x)}" y2="${num(py)}" stroke="${theme.frame}" stroke-width="1"/>`);
    out.push(`<text x="${num(ax.x - 7)}" y="${num(py + opt.fontSize * 0.35)}" font-size="${opt.fontSize - 1}" fill="${theme.muted}" text-anchor="end">${esc(labelY(t))}</text>`);
  }

  const xLabel = meta?.xLabel, yLabel = meta?.yLabel;
  if (xLabel && meta?.xLabelStyle?.visible !== false) {
    out.push(`<text x="${num(ax.x + ax.w / 2)}" y="${num(ax.y + ax.h + 36)}" font-size="${opt.fontSize}" fill="${theme.text}" text-anchor="middle">${esc(xLabel)}</text>`);
  }
  if (yLabel && meta?.yLabelStyle?.visible !== false) {
    const cy = ax.y + ax.h / 2;
    out.push(`<text x="${num(cell.x + 14)}" y="${num(cy)}" font-size="${opt.fontSize}" fill="${theme.text}" text-anchor="middle" transform="rotate(-90 ${num(cell.x + 14)} ${num(cy)})">${esc(yLabel)}</text>`);
  }

  return { svg: out.join(""), ax, sx, sy };
}

// ---------------------------------------------------------------- entry point

/**
 * Render a figure scene (the parsed JSON from `exportFigureScene`) to an SVG string.
 * Accepts either the outer `{kind: "figure-scene", figure: {...}}` envelope or a
 * bare figure object.
 *
 * @returns {string} SVG markup
 */
export function renderFigureScene(scene, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const theme = { ...(THEMES[opt.theme] ?? THEMES.light), ...(opt.palette ?? {}) };
  const fig = scene?.figure ?? scene;
  if (!fig || !Array.isArray(fig.plots)) throw new TypeError("not a RunMat figure scene");
  if (opt.cycleDefaults !== false) cycleDefaultColors(fig);

  // the `.m` language's figure position is [x y w h]; use it as the default canvas size.
  const pos = fig.metadata?.position;
  if (opt.useScenePosition && Array.isArray(pos) && pos.length === 4 && options.width === undefined && options.height === undefined) {
    if (pos[2] > 40 && pos[3] > 40) { opt.width = Math.round(pos[2]); opt.height = Math.round(pos[3]); }
  }

  const rows = Math.max(1, fig.layout?.axesRows ?? 1);
  const cols = Math.max(1, fig.layout?.axesCols ?? 1);
  // `axesIndices` lists the occupied slots, row-major, 0-based.
  const occupied = (fig.layout?.axesIndices?.length ? fig.layout.axesIndices : [0])
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);

  const warnings = [];
  const pad = opt.padding;
  const cellW = (opt.width - pad * 2) / cols;
  const cellH = (opt.height - pad * 2) / rows;

  const body = [];
  for (const slot of occupied) {
    const r = Math.floor(slot / cols), c = slot % cols;
    const cell = { x: pad + c * cellW, y: pad + r * cellH, w: cellW, h: cellH };
    const plots = fig.plots.filter((p) => (p.axes_index ?? 0) === slot);
    const meta = fig.metadata?.axesMetadata?.[slot] ?? fig.metadata;
    const { svg, ax, sx, sy } = drawAxes(cell, plots, meta, fig.metadata, opt, theme, warnings);
    body.push(svg);

    // legendEntries is figure-level, so attach an entry to an axes only when
    // that axes actually holds a series with the same label. Matching on kind
    // instead would duplicate every line entry into every subplot.
    const labels = new Set(plots.map((p) => p.label).filter((l) => l != null));
    const entries = (fig.metadata?.legendEntries ?? []).filter((e) => labels.has(e.label));
    const informative = entries.length > 1 || entries.some((e) => !AUTO_LABEL.test(String(e.label ?? "").trim()));
    const wanted = opt.legend === "always" ? entries.length > 0
      : opt.legend === "never" ? false
      : informative;
    if (wanted && meta?.legendEnabled !== false && meta?.legendStyle?.visible !== false) {
      body.push(drawLegend(entries, ax, opt, theme, plots, sx, sy));
    }
  }

  const sgTitle = fig.metadata?.sgTitle;
  const header = sgTitle
    ? `<text x="${num(opt.width / 2)}" y="${num(opt.fontSize + 6)}" font-size="${opt.titleFontSize + 1}" font-weight="600" fill="${theme.text}" text-anchor="middle">${esc(sgTitle)}</text>`
    : "";

  // The scene's own background is the `.m` language's white; honour it only when the
  // caller has not asked for a theme or palette of its own.
  const themed = opt.theme === "dark" || opt.palette;
  const bg = themed ? theme.figure : rgba(fig.metadata?.backgroundRgba, theme.figure);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${opt.width}" height="${opt.height}" viewBox="0 0 ${opt.width} ${opt.height}" font-family="${esc(opt.fontFamily)}">`,
    `<rect width="${opt.width}" height="${opt.height}" fill="${bg}"/>`,
    header,
    body.join(""),
    warnings.length ? `<!-- figrender warnings: ${esc([...new Set(warnings)].join("; "))} -->` : "",
    `</svg>`,
  ].join("");
}

/** Convenience: decode the raw bytes from `exportFigureScene` and render them. */
export function renderFigureSceneBytes(bytes, options) {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  return renderFigureScene(JSON.parse(text), options);
}

export default renderFigureScene;
