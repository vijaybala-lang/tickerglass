/* spark.js — pure cairo painters: the panel sparkline, the card/app price
 * chart, candles and pills. Zero St/Gtk imports (weatherglass module-layering
 * rule), so tools/preview.mjs renders the exact same pixels headless.
 *
 * Contract (from weatherglass chart.js): draw in LOGICAL coordinates.
 * Inside the shell, St.DrawingArea hands back an already device-scaled
 * context — pass get_surface_size() as w/h. In GTK4, cr.scale(dpr, dpr)
 * first and pass logical size. */

import Cairo from 'gi://cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import {COLORS} from './fmt.js';

/* GJS Pango bindings flip snake/camel between releases — feature-detect. */
function call(obj, camel, snake, ...args) {
    const fn = obj[camel] ?? obj[snake];
    return fn.call(obj, ...args);
}

const showLayout = PangoCairo.createLayout ?? PangoCairo.create_layout;

/** One Pango label. y is a BASELINE unless vcenter is given. */
export function drawText(cr, text, x, y, {
    size = 10, bold = false, weight = 0, rgba = [1, 1, 1, 1],
    anchor = 'middle', vcenter = null, mono = false,
} = {}) {
    const layout = showLayout(cr);
    const desc = Pango.FontDescription.new();
    desc.set_family(mono ? 'Monospace' : 'Inter');
    call(desc, 'setSize', 'set_size', Pango.SCALE * size);
    const w = weight || (bold ? Pango.Weight.BOLD : 0);
    if (w)
        call(desc, 'setWeight', 'set_weight', w);
    call(layout, 'setFontDescription', 'set_font_description', desc);
    layout.set_text(text, -1);
    // GJS 1.88 returns [w, h] in Pango units; getSize exists but is a stub
    const [szW, szH] = layout.getSize ? (layout.getSize() ?? layout.get_size())
                                      : layout.get_size();
    const lw = szW / Pango.SCALE, lh = szH / Pango.SCALE;
    const px = anchor === 'end' ? x - lw : anchor === 'start' ? x : x - lw / 2;
    const py = vcenter != null ? vcenter - lh / 2 : y - lh;
    cr.newPath();
    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
    cr.moveTo(px, py);
    (PangoCairo.showLayout ?? PangoCairo.show_layout)(cr, layout);
    // NOTE: never cr.$dispose() the caller's context — painters return
    // labels to the caller, who disposes once per frame (weatherglass rule)
    return lw;
}

/** Catmull-Rom → cubic Bézier (weatherglass tracePath): smooth but
 *  never overshoots enough to invent price spikes. */
export function tracePath(cr, pts) {
    cr.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i],
              p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        cr.curveTo(
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1]);
    }
}

function dotLine(cr, x0, y, x1, dash = 3) {
    for (let x = x0; x < x1; x += dash * 2) {
        cr.rectangle(x, y - 0.4, dash, 0.8);
    }
    cr.fill();
}

/** Nice-number axis steps (1/2/2.5/5 × 10^k). */
export function priceAxis(lo, hi, want = 3) {
    const span = hi - lo;
    if (!(span > 0))
        return {lo, hi, lines: [lo]};
    const raw = span / want;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10]
        .map(m => m * mag)
        .find(s => s >= raw) ?? mag * 10;
    const lines = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step)
        lines.push(v);
    return {lo: Math.min(lo, lines[0] ?? lo), hi: Math.max(hi, lines.at(-1) ?? hi),
            step, lines};
}

/* ── panel sparkline ──────────────────────────────────────────────────────
 * 56×18-ish widget: dotted prev-close baseline, smooth curve, gradient
 * under-fill, glowing end dot that pulses once per refresh cycle. */
export function paintSparkline(cr, {
    w, h, values, prevClose = null, color = null, progress = 1,
    glow = 0, dot = true, pad = 2,
}) {
    // no CLEAR here: frame drivers own surface clearing so painters can
    // composite onto anything (weatherglass layering rule)
    if (!values || values.length < 2)
        return;

    let lo = Math.min(...values), hi = Math.max(...values);
    if (prevClose != null) {
        lo = Math.min(lo, prevClose);
        hi = Math.max(hi, prevClose);
    }
    const mid = (lo + hi) / 2;
    const half = Math.max((hi - lo) / 2, Math.abs(mid) * 1e-6, 1e-9);
    lo = mid - half * 1.14; hi = mid + half * 1.14;

    const n = values.length;
    const up = prevClose != null ? values[n - 1] >= prevClose
                                 : values[n - 1] >= values[0];
    const rgb = color ?? (up ? COLORS.up : COLORS.down);
    const X = i => pad + i * (w - 2 * pad) / (n - 1);
    const Y = v => pad + (hi - v) * (h - 2 * pad) / (hi - lo);

    const drawn = Math.max(2, Math.ceil(n * Math.min(1, progress)));
    const pts = values.slice(0, drawn).map((v, i) => [X(i), Y(v)]);

    if (prevClose != null && prevClose >= lo && prevClose <= hi) {
        cr.setSourceRGBA(1, 1, 1, 0.30);
        dotLine(cr, pad, Y(prevClose), w - pad);
    }

    // area under the curve
    const grad = new Cairo.LinearGradient(0, 0, 0, h);
    grad.addColorStopRGBA(0, rgb[0], rgb[1], rgb[2], 0.34);
    grad.addColorStopRGBA(1, rgb[0], rgb[1], rgb[2], 0.02);
    cr.newPath();
    tracePath(cr, pts);
    cr.lineTo(pts.at(-1)[0], h - 1);
    cr.lineTo(pts[0][0], h - 1);
    cr.closePath();
    cr.setSource(grad);
    cr.fillPreserve();

    // stroke ONLY the curve (re-trace; fillPreserve above also outlined the
    // closing box — re-path before stroking, weatherglass's "box bug" note)
    cr.newPath();
    tracePath(cr, pts);
    cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 1);
    cr.setLineWidth(1.6);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.stroke();

    if (dot && progress >= 1) {
        const [ex, ey] = pts.at(-1);
        const r = 1.8 + glow * 0.9;
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 0.25 + glow * 0.35);
        cr.arc(ex, ey, r + 1.6 + glow * 1.4, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 1);
        cr.arc(ex, ey, r, 0, 2 * Math.PI);
        cr.fill();
    }
}

/* ── big chart (card hero + app main view) ────────────────────────────────
 * opts:
 *   w, h                logical px
 *   points              [{t, o, h, l, c}] chronological
 *   mode                'area' | 'line' | 'candles'
 *   prevClose           dotted baseline + day up/down tint
 *   fmtY(v)→s, fmtX(t)→s   axis formatters (caller supplies locale/range rules)
 *   showY, showX, dark     axis labels + ink choice
 *   progress 0..1       draw-in animation (series morph is caller-side lerp)
 *   cursor {x}          logical px → crosshair + value bubble (app hover)
 *   accent              force rgb triple (else auto up/down)
 */
export function paintChart(cr, opts) {
    const {
        w, h, points, mode = 'area', prevClose = null,
        fmtY = v => String(v), fmtX = () => '',
        showY = true, showX = true, dark = true,
        progress = 1, cursor = null, accent = null,
        compare = null,           // normalized 2nd series: {points:[{t,c}]}
        cursorFmt = null,         // i => tooltip text (default: price · date)
    } = opts;

    const n = points?.length ?? 0;
    if (n < 2)
        return;

    const ink     = dark ? [1, 1, 1] : [0.063, 0.094, 0.137];
    const LABEL   = 8.5;
    const GUT_L   = 2;                    // curve box: full-bleed left, price
    const GUT_R   = showY ? 56 : 6;       // labels float in the right gutter
    const GUT_T   = 8;
    const GUT_B   = showX ? 22 : 6;
    const cw = w - GUT_L - GUT_R, ch = h - GUT_T - GUT_B;

    /* y-window over every visible extreme */
    let lo = +Infinity, hi = -Infinity;
    for (const p of points) {
        const hiV = mode === 'candles' ? (p.h ?? p.c) : p.c;
        const loV = mode === 'candles' ? (p.l ?? p.c) : p.c;
        if (hiV > hi) hi = hiV;
        if (loV < lo) lo = loV;
    }
    if (prevClose != null) {
        lo = Math.min(lo, prevClose);
        hi = Math.max(hi, prevClose);
    }
    /* the compare series shares this price space, so widen the y-window
     * to its extremes too: both lines stay fully visible */
    const cmp = compare?.points?.length >= 2 ? compare.points : null;
    if (cmp) {
        for (const p of cmp) {
            if (p.c > hi) hi = p.c;
            if (p.c < lo) lo = p.c;
        }
    }
    const midp = (lo + hi) / 2 || 1e-9;
    const padY = Math.max((hi - lo) * 0.10, Math.abs(midp) * 1e-6, 1e-9);
    lo -= padY; hi += padY;

    const X = i => GUT_L + i * cw / (n - 1);
    const Y = v => GUT_T + (hi - v) * ch / (hi - lo);
    const up = prevClose != null ? points.at(-1).c >= prevClose
                                 : points.at(-1).c >= points[0].c;
    const rgb = accent ?? (up ? COLORS.up : COLORS.down);

    /* horizontal grid + price labels (skip ones the live pill will cover) */
    const lastY = Math.min(Math.max(Y(points.at(-1).c), GUT_T + 9),
                           h - GUT_B - 9);
    if (showY) {
        const ax = priceAxis(lo, hi, 3);
        cr.setSourceRGBA(ink[0], ink[1], ink[2], dark ? 0.10 : 0.12);
        for (const v of ax.lines) {
            const y = Y(v);
            cr.rectangle(GUT_L, y - 0.25, cw, 0.5);
            cr.fill();
            if (Math.abs(y - lastY) > 11)
                drawText(cr, fmtY(v), w - 6, 0, {
                    size: LABEL, anchor: 'end', vcenter: y,
                    rgba: [...ink, dark ? 0.55 : 0.62],
                });
        }
    }

    /* prev-close baseline */
    if (prevClose != null && mode !== 'candles' &&
        prevClose > lo && prevClose < hi) {
        cr.setSourceRGBA(...ink, 0.30);
        dotLine(cr, GUT_L, Y(prevClose), GUT_L + cw, 4);
    }

    const drawn = Math.max(2, Math.ceil(n * Math.min(1, progress)));

    if (mode === 'candles') {
        const bw = Math.max(1.5, Math.min(9, cw / n * 0.62));
        for (let i = 0; i < drawn; i++) {
            const p = points[i];
            const cu = (p.c ?? p.o) >= (p.o ?? p.c);
            const cc = cu ? COLORS.up : COLORS.down;
            const x = X(i);
            cr.setSourceRGBA(cc[0], cc[1], cc[2], 0.9);
            cr.rectangle(x - 0.4, Y(p.h ?? Math.max(p.c, p.o)), 0.8,
                         Math.max(0.8, Y(p.l ?? Math.min(p.c, p.o)) -
                                    Y(p.h ?? Math.max(p.c, p.o))));
            cr.fill();
            const yO = Y(p.o ?? p.c), yC = Y(p.c);
            cr.rectangle(x - bw / 2, Math.min(yO, yC) + 0.3, bw,
                         Math.max(0.9, Math.abs(yC - yO) - 0.6));
            cr.fill();
        }
    } else {
        const pts = points.slice(0, drawn)
                          .map((p, i) => [X(i), Y(p.c)]);
        if (mode === 'area') {
            const grad = new Cairo.LinearGradient(0, GUT_T, 0, h - GUT_B + 8);
            grad.addColorStopRGBA(0, rgb[0], rgb[1], rgb[2], 0.34);
            grad.addColorStopRGBA(1, rgb[0], rgb[1], rgb[2], 0);
            cr.newPath();
            tracePath(cr, pts);
            cr.lineTo(pts.at(-1)[0], h - GUT_B + 8);
            cr.lineTo(pts[0][0], h - GUT_B + 8);
            cr.closePath();
            cr.setSource(grad);
            cr.fillPreserve();
        }
        cr.newPath();
        tracePath(cr, pts);
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 1);
        cr.setLineWidth(2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.stroke();
    }

    /* compare overlay: thinner, fixed blue, own x mapping (its bar count
     * can differ from the primary), rides the same reveal animation */
    if (cmp) {
        const m = cmp.length;
        const drawnC = Math.max(2, Math.ceil(m * Math.min(1, progress)));
        cr.newPath();
        tracePath(cr, cmp.slice(0, drawnC).map(
            (p, i) => [GUT_L + i * cw / (m - 1), Y(p.c)]));
        cr.setSourceRGBA(0.384, 0.627, 0.918, 0.85);   // Adwaita blue-2
        cr.setLineWidth(1.4);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineJoin.ROUND);
        cr.stroke();
    }

    /* time axis: ~5 evenly spread ticks, first/last nudged off the edges */
    if (showX) {
        const ticks = Math.max(3, Math.min(6, Math.floor(cw / 72)));
        for (let k = 0; k < ticks; k++) {
            const i = Math.round(k * (n - 1) / (ticks - 1));
            const x = Math.min(Math.max(X(i), GUT_L + 14), GUT_L + cw - 14);
            drawText(cr, fmtX(points[i].t), x, h - 6, {
                size: LABEL, rgba: [...ink, dark ? 0.5 : 0.6],
            });
        }
    }

    /* live price pill, right gutter */
    if (progress >= 1) {
        const last = points.at(-1);
        const y = Math.min(Math.max(Y(last.c), GUT_T + 9), h - GUT_B - 9);
        const label = fmtY(last.c);
        const tw = drawText(cr, label, 0, 0, {
            size: 9, bold: true, rgba: [1, 1, 1, 1], anchor: 'start',
            vcenter: 1e6,                 // measure: draw far offscreen
        });
        const bx = w - GUT_R + 4, pw = Math.min(GUT_R - 8, tw + 10);
        roundRect(cr, bx, y - 8, pw, 16, 5);
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 0.95);
        cr.fill();
        drawText(cr, label, bx + pw / 2, 0, {
            size: 9, bold: true, rgba: [1, 1, 1, 1], vcenter: y,
        });
    }

    /* hover crosshair + bubble */
    if (cursor && mode !== 'candles') {
        const i = Math.max(0, Math.min(n - 1,
            Math.round((cursor.x - GUT_L) / cw * (n - 1))));
        const p = points[i];
        const x = X(i), y = Y(p.c);
        cr.setSourceRGBA(...ink, 0.45);
        cr.rectangle(x - 0.35, GUT_T, 0.7, ch);
        cr.fill();
        cr.arc(x, y, 4, 0, 2 * Math.PI);
        cr.setSourceRGBA(...ink, 0.22);
        cr.fill();
        cr.arc(x, y, 2.2, 0, 2 * Math.PI);
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 1);
        cr.fill();
        // the benchmark gets its own dot at the same instant (its bars
        // may differ in count from the primary, so index independently)
        if (cmp) {
            const j = Math.max(0, Math.min(cmp.length - 1,
                Math.round((x - GUT_L) / cw * (cmp.length - 1))));
            cr.arc(x, Y(cmp[j].c), 2.6, 0, 2 * Math.PI);
            cr.setSourceRGBA(0.384, 0.627, 0.918, 1);
            cr.fill();
        }
        const txt2 = cursorFmt ? cursorFmt(i) : null;
        // cursorFmt may return a plain string (old bubble) or a rich
        // {date, items:[{text}]} — items render as pills tinted with the
        // series colors: [primary] [compare] date
        const segs = (txt2 && typeof txt2 !== 'string') ? txt2 : null;
        const BLUE = [0.384, 0.627, 0.918];
        const measure = s => drawText(cr, s, 0, 0, {size: 9,
            rgba: [1, 1, 1, 1], anchor: 'start', vcenter: 1e6});
        let bxp, bw, pw = null;
        if (segs) {
            pw = (segs.items ?? []).map(it => measure(it.text) + 14);
            const dateW = segs.date ? measure(segs.date) : 0;
            bw = pw.reduce((a, b) => a + b, 0) +
                Math.max(0, pw.length - 1) * 5 +
                (dateW ? dateW + 8 : 0) + 12;
        } else {
            bw = measure(txt2 ?? `${fmtY(p.c)}   ${fmtX(p.t)}`) + 14;
        }
        bxp = Math.max(6, Math.min(w - GUT_R - bw - 16, x - bw / 2));
        roundRect(cr, bxp, 4, bw, segs ? 22 : 18, 6);
        cr.setSourceRGBA(dark ? 0.11 : 0.97, dark ? 0.12 : 0.97,
                        dark ? 0.16 : 0.99, 0.92);
        cr.fill();
        if (segs) {
            let cx = bxp + 6;
            (segs.items ?? []).forEach((it, k) => {
                const col = k === 0 ? rgb : BLUE;
                roundRect(cr, cx, 6, pw[k], 18, 9);
                cr.setSourceRGBA(col[0], col[1], col[2], 0.16);
                cr.fill();
                drawText(cr, it.text, cx + pw[k] / 2, 0, {
                    size: 9, bold: true, rgba: [...col, 0.98],
                    vcenter: 15,
                });
                cx += pw[k] + 5;
            });
            if (segs.date)
                drawText(cr, segs.date, cx + measure(segs.date) / 2 + 3,
                    0, {size: 8.5, rgba: [...ink, 0.75], vcenter: 15});
        } else {
            drawText(cr, txt2 ?? `${fmtY(p.c)}   ${fmtX(p.t)}`,
                bxp + bw / 2, 0, {
                    size: 9, rgba: dark ? [1, 1, 1, 0.95] : [...ink, 0.9],
                    vcenter: 13,
                });
        }
    }
}

function roundRect(cr, x, y, w, h, r) {
    cr.newPath();
    cr.moveTo(x + r, y);
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

/* mini row-sparkline for the card/watchlist rows: 44×14, no baseline */
export function paintMiniSpark(cr, {w, h, values, up}) {
    paintSparkline(cr, {w, h, values, pad: 1.5, dot: true,
                        color: up ? COLORS.up : COLORS.down});
}
