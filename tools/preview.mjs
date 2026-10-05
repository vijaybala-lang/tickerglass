/* preview.mjs — part of TickerGlass
 * Copyright (C) 2026 Vijay Bala
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* preview.mjs — renders every painter to PNG outside the shell:
 * gjs -m tools/preview.mjs   → /tmp/tickerglass-preview/*.png            */

import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';
import {paintSparkline, paintChart} from '../shared/spark.js';
import {DemoClient} from '../shared/mock.js';
import {fmtPrice, fmtCompact, fmtTime, monthDay} from '../shared/fmt.js';

const OUT = GLib.build_filenamev([GLib.get_tmp_dir(), 'tickerglass-preview']);
GLib.mkdir_with_parents(OUT, 0o755);

function sheet(name, w, h, draw) {
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
    const cr = new Cairo.Context(surf);
    // panel-dark / card-dark backdrop, rounded like the real widgets
    cr.setSourceRGBA(0.09, 0.10, 0.14, 1);
    cr.paint();
    draw(cr);
    cr.$dispose();
    surf.flush();
    const p = GLib.build_filenamev([OUT, name]);
    surf.writeToPNG(p);
    console.log(p);
}

const client = new DemoClient();
const quotes = (await client.quotes(['AAPL', 'TSLA'])).quotes;
const histDay = await client.history('AAPL', '1d', 'auto');
const histMon = await client.history('AAPL', '1mo', 'auto');
const histYr = await client.history('NVDA', '1y', 'auto');

/* ── panel sparkline: dark chip, up & down, glow phases ────────────────── */
for (const [tag, q] of [['up', quotes[0]], ['down', quotes[1]]])
    sheet(`panel-${tag}.png`, 64, 26, cr => {
        cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.rectangle(0, 0, 64, 26);
        cr.fill();
        cr.translate(4, 4);
        paintSparkline(cr, {w: 56, h: 18, values: q.spark,
                            prevClose: q.prevClose, glow: 0.7});
    });

/* ── card chart: 1D area (up), candles, 1M area, 1Y, hover crosshair ───── */
const CHW = 320, CHH = 190;
sheet('chart-1d.png', CHW, CHH, cr =>
    paintChart(cr, {
        w: CHW, h: CHH, points: histDay.points, mode: 'area',
        prevClose: histDay.meta.prevClose, dark: true,
        fmtY: v => fmtPrice(v), fmtX: t => fmtTime(t, 'America/New_York'),
    }));

sheet('chart-candles.png', CHW, CHH, cr =>
    paintChart(cr, {
        w: CHW, h: CHH, points: histMon.points.slice(-80), mode: 'candles',
        dark: true, fmtY: v => fmtPrice(v),
        fmtX: t => monthDay(t),
    }));

sheet('chart-1m.png', CHW, CHH, cr =>
    paintChart(cr, {
        w: CHW, h: CHH, points: histMon.points, mode: 'area',
        dark: true, fmtY: v => fmtPrice(v), fmtX: t => monthDay(t),
    }));

sheet('chart-1y-hover.png', CHW, CHH, cr =>
    paintChart(cr, {
        w: CHW, h: CHH, points: histYr.points, mode: 'area', dark: true,
        fmtY: v => fmtCompact(v), fmtX: t => monthDay(t),
        cursor: {x: CHW * 0.62},
    }));

/* contact strip of the two panel chips side by side */
sheet('panel-strip.png', 150, 26, cr => {
    cr.setSourceRGBA(0, 0, 0, 0.35);
    cr.rectangle(0, 0, 150, 26);
    cr.fill();
    cr.translate(4, 4);
    paintSparkline(cr, {w: 56, h: 18, values: quotes[0].spark,
                        prevClose: quotes[0].prevClose, glow: 0.4});
    cr.translate(82, 0);
    paintSparkline(cr, {w: 56, h: 18, values: quotes[1].spark,
                        prevClose: quotes[1].prevClose, glow: 0});
});
