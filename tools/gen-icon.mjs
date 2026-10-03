#!/usr/bin/gjs
/* TickerGlass app-icon generator — cairo → PNG (all hicolor sizes) + SVG.
 * Run:  gjs -m tools/gen-icon.mjs [outdir]
 * Default outdir: ~/.local/share/icons. Design: dark rounded tile (the
 * app's night surface), brand-green sparkline with a soft glow and an
 * end dot, a diagonal "glass" sheen, subtle top-light gradient. */
import Cairo from 'gi://cairo';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const APP_ID = 'dev.vijaybala.TickerGlass';
const OUT = GLib.getenv('TG_ICON_OUT')
    ?? GLib.getenv('HOME') + '/.local/share/icons';

// line vertices in tile fractions (x, y-down), y=0 top
const PTS_FULL = [
    [0.10, 0.74], [0.24, 0.60], [0.33, 0.66], [0.46, 0.44],
    [0.55, 0.50], [0.68, 0.30], [0.78, 0.36], [0.90, 0.18],
];
const PTS_SMALL = [[0.13, 0.70], [0.38, 0.52], [0.58, 0.60], [0.87, 0.22]];

const GREEN = [0.0, 0.77, 0.42];        // #00c46a, night surface green

function drawTile(cr, size) {
    const small = size <= 48;
    const pts = small ? PTS_SMALL : PTS_FULL;
    const r = size * 0.22;                // squircle-ish corner
    // tile with vertical top-light gradient
    rrectPath(cr, 0, 0, size, size, r);
    const bg = new Cairo.LinearGradient(0, 0, 0, size);
    bg.addColorStopRGBA(0, 0.20, 0.22, 0.25, 1);
    bg.addColorStopRGBA(1, 0.09, 0.10, 0.12, 1);
    cr.setSource(bg);
    cr.fillPreserve();
    cr.save();
    cr.clip();
    cr.newPath();   // fillPreserve left the tile path current; without
                    // this the sheen rectangle unions into it and
                    // double-fills the tile (visible band artifact)

    // diagonal glass sheen across the upper half
    if (!small) {
        const sh = new Cairo.LinearGradient(0, 0, size, size);
        sh.addColorStopRGBA(0, 1, 1, 1, 0.06);
        sh.addColorStopRGBA(0.45, 1, 1, 1, 0.01);
        sh.addColorStopRGBA(0.70, 1, 1, 1, 0.0);
        cr.rectangle(0, 0, size, size * 0.62);
        cr.setSource(sh);
        cr.fill();
    }

    // chart geometry
    const pad = size * 0.16;
    const px = pts.map(p => pad + (p[0] - 0.10) / 0.80 * (size - 2 * pad));
    const py = pts.map(p => pad + p[1] * (size - 2 * pad) * 0.8);
    const P = i => [px[i], py[i]];

    // area fill under the line
    if (!small) {
        cr.moveTo(px[0], size - pad * 0.4);
        for (let i = 0; i < pts.length; i++)
            cr.lineTo(...P(i));
        cr.lineTo(px[pts.length - 1], size - pad * 0.4);
        cr.closePath();
        const af = new Cairo.LinearGradient(0, pad, 0, size);
        af.addColorStopRGBA(0, ...GREEN, 0.28);
        af.addColorStopRGBA(1, ...GREEN, 0.0);
        cr.setSource(af);
        cr.fill();
    }

    // glow pass then crisp line
    const line = () => {
        cr.moveTo(...P(0));
        for (let i = 1; i < pts.length; i++)
            cr.lineTo(...P(i));
    };
    if (!small) {
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(size * 0.11);
        cr.setSourceRGBA(...GREEN, 0.30);
        line();
        cr.stroke();
    }
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineWidth(size * (small ? 0.14 : 0.065));
    cr.setSourceRGBA(...GREEN, 1);
    line();
    cr.stroke();

    // end dot with a white core (the "last price" bead)
    const [ex, ey] = P(pts.length - 1);
    cr.arc(ex, ey, size * (small ? 0.10 : 0.075), 0, 2 * Math.PI);
    cr.setSourceRGBA(...GREEN, 1);
    cr.fill();
    cr.arc(ex, ey, size * (small ? 0.045 : 0.032), 0, 2 * Math.PI);
    cr.setSourceRGBA(1, 1, 1, 0.95);
    cr.fill();
    cr.restore();

    // hairline rim so the tile lifts off dark docks
    rrectPath(cr, 0.5, 0.5, size - 1, size - 1, r);
    cr.setLineWidth(1);
    cr.setSourceRGBA(1, 1, 1, 0.07);
    cr.stroke();
}

function rrectPath(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.moveTo(x + r, y);
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

function rgba(r, g, b, a) { return [r, g, b, a]; }

// --- ensure a valid hicolor theme dir (fresh users lack index.theme) ------
const HICOLOR = `${OUT}/hicolor`;
const INDEX = `${HICOLOR}/index.theme`;
if (!GLib.file_test(INDEX, GLib.FileTest.EXISTS)) {
    const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
    let ini = '[Icon Theme]\nName=hicolor\nComment=user app icons\n'
        + `Directories=${sizes.map(s => `${s}x${s}/apps`).join(',')}\n`
        + sizes.map(s =>
            `\n[${s}x${s}/apps]\nSize=${s}\nContext=Applications\n`).join('');
    GLib.mkdir_with_parents(HICOLOR, 0o755);
    GLib.file_set_contents(INDEX, ini);
    print(`wrote ${INDEX}`);
}

// --- emit PNGs ------------------------------------------------------------
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, size, size);
    const cr = new Cairo.Context(surf);
    drawTile(cr, size);
    const dir = `${OUT}/hicolor/${size}x${size}/apps`;
    GLib.mkdir_with_parents(dir, 0o755);
    surf.writeToPNG(`${dir}/${APP_ID}.png`);
    print(`wrote ${dir}/${APP_ID}.png`);
}

// --- emit SVG (vector master) ---------------------------------------------
const svgSvg = () => {
    const S = 512, pts = PTS_FULL;
    const pad = S * 0.16;
    const px = pts.map(p => pad + (p[0] - 0.10) / 0.80 * (S - 2 * pad));
    const py = pts.map(p => pad + p[1] * (S - 2 * pad) * 0.8);
    const line = pts.map((_, i) =>
        `${i ? 'L' : 'M'}${px[i].toFixed(1)} ${py[i].toFixed(1)}`).join(' ');
    const area = `${line} L${px[7].toFixed(1)} ${(S - pad * 0.4).toFixed(1)} `
        + `L${px[0].toFixed(1)} ${(S - pad * 0.4).toFixed(1)} Z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#333840"/><stop offset="1" stop-color="#17191d"/>
    </linearGradient>
    <linearGradient id="af" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#00c46a" stop-opacity=".28"/>
      <stop offset="1" stop-color="#00c46a" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="113" fill="url(#bg)"/>
  <path d="${area}" fill="url(#af)"/>
  <path d="${line}" fill="none" stroke="#00c46a" stroke-opacity=".3"
        stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${line}" fill="none" stroke="#00c46a" stroke-width="33"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${px[7].toFixed(1)}" cy="${py[7].toFixed(1)}" r="38" fill="#00c46a"/>
  <circle cx="${px[7].toFixed(1)}" cy="${py[7].toFixed(1)}" r="16"
          fill="#ffffff" fill-opacity=".95"/>
</svg>
`;
};
const sdir = `${OUT}/hicolor/scalable/apps`;
GLib.mkdir_with_parents(sdir, 0o755);
GLib.file_set_contents(`${sdir}/${APP_ID}.svg`, svgSvg());
print(`wrote ${sdir}/${APP_ID}.svg`);

// refresh the icon cache so the shell/launchers see the new icon now
try {
    GLib.spawn_command_line_sync(`gtk-update-icon-cache -q -t -f ${HICOLOR}`);
} catch (e) { /* cache tool absent; lookups still work uncached */ }
