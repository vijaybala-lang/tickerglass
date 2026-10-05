/* extension.js — part of TickerGlass
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
/* extension.js — panel LED movers-tape button, timers, settings glue.
 * Conventions inherited from weatherglass/extension.js: PanelMenu.Button
 * subclass, gsettings-driven everything, monotonic timers with 0 sentinels,
 * _busy/_refetch/_dead async guards, stale data kept on failure. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'gi://cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MarketClient} from './yahoo.js';
import {TickerPanel} from './menu.js';
import {initI18n, _} from './i18n.js';
import {parseWatchlists, fmtPrice, fmtDelta, fmtPct} from './fmt.js';

const FRAME_MS = 50;          // 20 fps, same budget as weatherglass icons
const TAPE_SPEED = 55;        // px/s — airport-board pace, right to left

/* LED-matrix palette: saturated phosphor greens/reds on a near-black
 * board; the dim color is the separator dots and the idle legend */
const LED = {
    up: [0.24, 1.00, 0.55],
    down: [1.00, 0.36, 0.42],
    dim: [0.55, 0.60, 0.58],
};

/* ── the scrolling LED tape ────────────────────────────────────────────────
 * St.DrawingArea + PangoCairo. The stream is a list of colored runs
 * (monospace bold, the LED-board face); each frame advances a byte-
 * precise offset and the strip is painted at x, x+W, x+2W… so the seam
 * where it wraps is invisible — provided every run ends padded, which
 * the caller (extension.js _renderTape) guarantees. 20 fps at 55 px/s
 * is ~3 px/frame: smoother than the real thing. */
const MoversTape = GObject.registerClass(
class MoversTape extends St.DrawingArea {
    _init() {
        super._init({style_class: 'tg-tape', reactive: false,
                     can_focus: false,
                     y_align: Clutter.ActorAlign.CENTER,
                     width: 300, height: 20});
        this._runs = [];           // [{lay, wpx, rgb}] — built lazily
        this._stripW = 0;
        this._off = 0;
        this._last = GLib.get_monotonic_time();
        this._pending = null;      // items awaiting a paint-context
        this._idleText = '';
        this._idleLay = null;
        this._dirty = false;
        this._clockId = 0;
        this.connect('destroy', () => this._stop());
        this._start();
    }

    /** items: [{text, rgb}] — painted in order, scrolling as one strip.
     *  Pango layouts cannot be conjured outside a cairo context in this
     *  GJS (new Pango.Layout(ctx) throws — fresh-login crash proved it),
     *  so the set is parked here and realized on the next repaint */
    setItems(items) {
        this._pending = (items ?? []).filter(it => it?.text);
        this._idleText = '';
        this._idleLay = null;
        this._runs = [];
        this._stripW = 0;
        this._off = 0;
        this._dirty = true;
        this.queue_repaint();
    }

    setIdle(text) {
        this._pending = null;
        this._idleText = text ?? '';
        this._idleLay = null;      // realized on paint, like the runs
        this._runs = [];
        this._stripW = 0;
        this._dirty = true;
        this.queue_repaint();
    }

    _mkLayout(cr, text, font) {
        const lay = PangoCairo.create_layout(cr);
        // NO desc.free(): GJS reclaims FontDescription — an explicit
        // free double-frees at teardown (unit-proven: 'free():
        // invalid pointer' at exit)
        const desc = Pango.FontDescription.from_string(font);
        lay.set_font_description(desc);
        lay.set_text(text, -1);
        return lay;
    }

    _realize(cr) {
        this._dirty = false;
        if (this._pending) {
            for (const it of this._pending) {
                const lay = this._mkLayout(cr, it.text, 'Monospace Bold 10');
                const [wp] = lay.get_pixel_size();
                this._runs.push({lay, wp, rgb: it.rgb ?? LED.dim});
                this._stripW += wp;
            }
            // a strip narrower than the window would smear the seam;
            // double the set (same layout objects — painting is
            // read-only) so the tiling loop always has material
            if (this._runs.length && this._stripW < 300) {
                for (const r of [...this._runs]) {
                    this._runs.push(r);
                    this._stripW += r.wp;
                }
            }
            this._pending = null;
        } else if (this._idleText) {
            this._idleLay = this._mkLayout(cr, this._idleText,
                'Monospace 10');
        }
    }

    vfunc_repaint() {
        let [w, h] = this.get_surface_size();
        if (w <= 0 || h <= 0)
            return;
        const cr = this.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        if (this._dirty)
            this._realize(cr);

        if (!this._runs.length) {
            if (this._idleLay) {
                const [lw, lh] = this._idleLay.get_pixel_size();
                cr.setSourceRGBA(...LED.dim, 0.85);
                cr.moveTo(Math.max(6, (w - lw) / 2), (h - lh) / 2);
                PangoCairo.show_layout(cr, this._idleLay);
            }
            return;
        }

        let y = (h - this._runs[0].lay.get_pixel_size()[1]) / 2;
        // draw at -off mod W, then tile rightward past the viewport
        let x = -(this._off % this._stripW);
        if (x > 0)
            x -= this._stripW;
        for (; x < w; x += this._stripW) {
            let cx = x;
            for (const r of this._runs) {
                cr.setSourceRGBA(...r.rgb, 1);
                cr.moveTo(cx, y);
                PangoCairo.show_layout(cr, r.lay);
                cr.newPath();
                cx += r.wp;
            }
        }
    }

    _start() {
        if (this._clockId)
            return;
        this._clockId = GLib.timeout_add(GLib.PRIORITY_LOW, FRAME_MS, () => {
            if (this.mapped ?? true) {
                const now = GLib.get_monotonic_time();
                const dt = Math.min(0.25, (now - this._last) / 1e6);
                this._last = now;
                if (this._stripW) {
                    this._off = (this._off + dt * TAPE_SPEED) % this._stripW;
                    this.queue_repaint();
                }
            } else {
                this._last = GLib.get_monotonic_time();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._clockId) {
            GLib.source_remove(this._clockId);
            this._clockId = 0;
        }
    }
});

/* ── the indicator ──────────────────────────────────────────────────────── */
const TickerIndicator = GObject.registerClass(
class TickerIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, _('TickerGlass'), false);

        this._ext = ext;
        this._settings = ext.getSettings();
        this._client = new MarketClient(this._settings.get_string('data-source'));
        this._timer = 0; this._retryTimer = 0; this._mvTimer = 0;
        this._busy = false; this._refetch = false; this._dead = false;
        this._mvBusy = false;
        this._quotes = [];
        this._movers = null;       // {g, l, at} — screener answers
        this._mvFailAt = 0;

        this._dark = _interfaceIsDark();

        // the panel IS the tape: a stream of the market's biggest
        // gainers then losers, LED-board styled
        this._tape = new MoversTape();
        this._tape.setIdle('TICKERGLASS · waking up');
        this.add_child(this._tape);

        // dropdown card
        this._panel = new TickerPanel({
            dark: this._dark,
            onHero: (symbol, range) => this._loadHero(symbol, range),
            onRefresh: () => this._fetch(true),
            onSettled: () => {},
        });
        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._panel.actor);
        this.menu.addMenuItem(section);
        this._panel.onRange = r =>
            this._settings.set_string('chart-range', r);
        this._panel.onSelect = sym =>
            this._settings.set_string('selected-symbol', sym);
        this.menu.actor.add_style_class_name('tg-menu');
        for (let a = this._panel.actor; a; a = a.get_parent()) {
            a.set_style('padding: 0px; margin: 0px; border-width: 0px;');
            if (a === this.menu.actor)
                break;
        }

        this._openId = this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                // snappier cadence while reading the card
                this._restartTimer();
                if (this._ageSec() > 25)
                    this._fetch(true);
                this._panel.render(this._state());
                this._panel.ensureHero();
            } else {
                this._restartTimer();
            }
        });
        this._settingsId = this._settings.connect('changed',
            (s, key) => this._onSetting(key));

        this._fetch(true);
        this._restartTimer();
    }

    /* ── data ─────────────────────────────────────────────────────────── */

    _symbols() {
        const lists = parseWatchlists(this._settings.get_string('watchlists'));
        const id = this._settings.get_string('active-watchlist');
        const wl = lists.find(w => w.id === id) ?? lists[0];
        return wl?.symbols ?? [];
    }

    _heroSymbol() {
        const sel = this._settings.get_string('selected-symbol');
        const syms = this._symbols();
        return syms.includes(sel) ? sel : (syms[0] ?? '');
    }

    _ageSec() {
        return this._at
            ? GLib.get_monotonic_time() / 1e6 - this._at : Infinity;
    }

    _state() {
        return {
            quotes: this._quotes,
            symbols: this._symbols(),
            hero: this._heroSymbol(),
            watchlists: parseWatchlists(this._settings.get_string('watchlists')),
            active: this._settings.get_string('active-watchlist'),
            range: this._settings.get_string('chart-range'),
            chartStyle: this._settings.get_string('chart-style'),
            atWall: this._atWall,
            error: this._error,
            retryIn: this._client.retryIn(),
        };
    }

    _fetch(force = false) {
        if (this._busy) {
            this._refetch = force;
            return;
        }
        const wait = this._client.retryIn();
        if (wait > 0) {
            // rate limited: schedule a single retry, keep stale data on screen
            if (!this._retryTimer)
                this._retryTimer = GLib.timeout_add_seconds(
                    GLib.PRIORITY_LOW, Math.min(wait, 120), () => {
                        this._retryTimer = 0;
                        this._fetch(true);
                        return GLib.SOURCE_REMOVE;
                    });
            this._error = 'rate';
            this._renderTape();
            this._panel.render(this._state());
            return;
        }
        const symbols = this._symbols();
        if (!symbols.length) {
            this._quotes = [];
            this._error = 'empty';
            this._renderTape();
            this._panel.render(this._state());
            return;
        }
        this._busy = true;
        const sparkRange = this._settings.get_string('panel-spark-range');
        this._client.quotes(symbols, {sparkRange})
            .then(res => {
                if (this._dead)
                    return;
                this._quotes = res.quotes;
                this._at = GLib.get_monotonic_time() / 1e6;
                this._atWall = Math.floor(GLib.get_real_time() / 1e6);
                this._error = res.quotes.some(q => q.error) &&
                              !res.quotes.some(q => q.price != null)
                    ? 'fetch' : null;
                this._busy = false;
                this._renderTape();
                this._panel.render(this._state());
                this._panel.ensureHero();
                this._restartTimer();
                this._maybeMovers();
                if (this._refetch) {
                    this._refetch = false;
                    this._fetch(true);
                }
            })
            .catch(e => {
                if (this._dead)
                    return;
                logError(e, 'TickerGlass');
                this._error = /429|rate/.test(String(e)) ? 'rate' : 'fetch';
                this._busy = false;
                this._renderTape();
                this._panel.render(this._state());
                this._restartTimer();
            });
    }

    /* ── movers for the tape ────────────────────────────────────────────
     * the SAME screener source the app's Movers page rides (Yahoo-side
     * even under the Nasdaq source — the facade routes it); 120 s TTL
     * while the market is awake, patient when it isn't, backoff on
     * failure, and a watchlist-bred fallback so the tape never dies
     * just because the screener is being stingy */

    _marketAwake() {
        return this._quotes.some(q => q.state === 'REGULAR' ||
            q.state === 'PRE' || q.state === 'POST');
    }

    _maybeMovers() {
        if (this._mvBusy || this._dead)
            return;
        const now = GLib.get_monotonic_time() / 1e6;
        const want = this._movers ? (this._marketAwake() ? 120 : 600) : 0;
        if (this._movers && now - this._movers.at < want)
            return;                       // still fresh
        if (!this._movers && this._mvFailAt &&
                now - this._mvFailAt < 180)
            return;                       // never landed: slow retry
        this._mvBusy = true;
        Promise.all([
            this._client.screener('day_gainers', 6),
            this._client.screener('day_losers', 6),
        ]).then(([g, l]) => {
            if (this._dead)
                return;
            this._mvFailAt = 0;
            this._movers = {g, l, at: GLib.get_monotonic_time() / 1e6};
            this._mvBusy = false;
            this._renderTape();
        }).catch(e => {
            if (this._dead)
                return;
            log(`TickerGlass ext: movers failed: ${e.message}`);
            this._mvFailAt = GLib.get_monotonic_time() / 1e6;
            this._mvBusy = false;
            this._renderTape();           // watchlist fallback on screen
        });
    }

    _renderTape() {
        const mv = this._movers;
        let g = mv?.g?.slice(0, 5) ?? [];
        let l = mv?.l?.slice(0, 5) ?? [];
        g = g.filter(m => m.price != null);
        l = l.filter(m => m.price != null);
        if (!g.length && !l.length) {
            // fallback: the watchlist's own best and worst five
            const qs = this._quotes.filter(q => q.price != null &&
                q.changePct != null);
            qs.sort((a, b) => b.changePct - a.changePct);
            g = qs.slice(0, 5);
            const inG = new Set(g);
            l = qs.slice(-5).filter(q => !inG.has(q)).reverse();
        }
        if (!g.length && !l.length) {
            this._tape.setIdle(this._error === 'rate'
                ? 'TICKERGLASS · feed rate-limited, retrying'
                : this._error === 'empty'
                    ? 'TICKERGLASS · no symbols — configure in ⚙'
                    : 'TICKERGLASS · waiting for the feed');
            return;
        }
        const segs = [];
        const push = (arr, up) => {
            for (const m of arr) {
                segs.push({
                    text: `${m.symbol.replace(/^\^/, '')}  ` +
                        `${fmtPrice(m.price, m.currency)}  ` +
                        `${up ? '▲' : '▼'}${fmtPct(Math.abs(m.changePct ?? 0))}   `,
                    rgb: up ? LED.up : LED.down,
                });
                segs.push({text: '·   ', rgb: LED.dim});
            }
        };
        push(g, true);
        push(l, false);
        this._tape.setItems(segs);
        // keep the strip honest even when nothing else wakes up
        if (!this._mvTimer)
            this._mvTimer = GLib.timeout_add_seconds(
                GLib.PRIORITY_LOW, 120, () => {
                    this._mvTimer = 0;
                    this._maybeMovers();
                    return GLib.SOURCE_REMOVE;
                });
    }

    async _loadHero(symbol, range) {
        if (!symbol)
            return;
        try {
            const hist = await this._client.history(
                symbol, range, this._settings.get_string('chart-interval'));
            if (this._dead || this._heroSymbol() !== symbol ||
                this._settings.get_string('chart-range') !== range)
                return;
            this._panel.setHeroSeries(hist);
        } catch (e) {
            if (this._dead)
                return;
            logError(e, 'TickerGlass');
            this._panel.setHeroSeries(null);
        }
    }

    /* ── timers & settings ────────────────────────────────────────────── */

    _restartTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        const open = this._quotes.some(q =>
            q.state === 'REGULAR' || q.state === 'PRE' || q.state === 'POST');
        let secs = this._settings.get_int('refresh-seconds');
        // menu open → 15 s floor; everything closed → 10 min floor
        if (this.menu.isOpen)
            secs = Math.min(secs, 15);
        else if (this._quotes.length && !open)
            secs = Math.max(secs, 600);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, secs, () => {
            this._timer = 0;
            this._fetch(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSetting(key) {
        switch (key) {
        case 'watchlists':
        case 'active-watchlist':
            this._fetch(true);
            this._panel.render(this._state());
            break;
        case 'selected-symbol':
            this._panel.render(this._state());
            this._panel.ensureHero();
            break;
        case 'chart-range':
        case 'chart-interval':
            this._panel.render(this._state());
            this._panel.ensureHero(true);
            break;
        case 'data-source':
            this._client.setSource(this._settings.get_string('data-source'));
            this._fetch(true);
            break;
        case 'panel-spark-range':
            this._fetch(true);       // the dropdown rows' sparks change
            break;
        case 'refresh-seconds':
            this._restartTimer();
            break;
        }
    }

    destroy() {
        this._dead = true;
        for (const id of [this._timer, this._retryTimer, this._mvTimer])
            if (id)
                GLib.source_remove(id);
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        if (this._openId)
            this.menu.disconnect(this._openId);
        this._panel?.destroy();      // plain JS: actor teardown misses its timers
        super.destroy();
    }
});

/* best-effort dark/light: theme name / color-scheme from the interface
 * schema; the panel sits on the shell bar which is dark in most themes. */
function _interfaceIsDark() {
    try {
        const s = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const scheme = s.get_string('color-scheme');
        if (scheme === 'prefer-dark')
            return true;
        if (scheme === 'prefer-light')
            return false;
        return (s.get_string('gtk-theme') || '').toLowerCase().includes('dark');
    } catch {
        return true;      // the shell popup is dark by default
    }
}

export default class TickerGlassExtension extends Extension {
    enable() {
        initI18n(this.uuid, this.dir.get_path());
        console.log(`TickerGlass v${this.metadata.version} loading ` +
                    `(${this.metadata.uuid})`);
        this._indicator = new TickerIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._sheet = this.dir.get_child('stylesheet.css');
        St.ThemeContext.get_for_stage(global.stage)
            .get_theme().load_stylesheet(this._sheet);
    }

    disable() {
        if (this._sheet) {
            St.ThemeContext.get_for_stage(global.stage)
                .get_theme().unload_stylesheet(this._sheet);
            this._sheet = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }
}
