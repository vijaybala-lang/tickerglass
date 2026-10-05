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
/* extension.js — panel sparkline button, timers, settings glue.
 * Conventions inherited from weatherglass/extension.js: PanelMenu.Button
 * subclass, gsettings-driven everything, monotonic timers with 0 sentinels,
 * _busy/_refetch/_dead async guards, stale data kept on failure. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MarketClient} from './yahoo.js';
import {TickerPanel} from './menu.js';
import {initI18n, _} from './i18n.js';
import {paintSparkline} from './spark.js';
import {parseWatchlists, fmtPrice, fmtDelta, fmtPct, COLORS} from './fmt.js';

const FRAME_MS = 50;          // 20 fps, same budget as weatherglass icons

/* ── the animated panel sparkline ────────────────────────────────────────
 * St.DrawingArea + vfunc_repaint; the clock self-idles on .mapped (GNOME 50
 * has no map signals) and clamps frame deltas, weatherglass rules. */
const SparkIcon = GObject.registerClass(
class SparkIcon extends St.DrawingArea {
    _init() {
        super._init({style_class: 'tg-panel-spark', reactive: false,
                     can_focus: false,
                     x_align: Clutter.ActorAlign.CENTER,
                     y_align: Clutter.ActorAlign.CENTER,
                     width: 56, height: 18});
        this._values = null;
        this._prevClose = null;
        this._progress = 1;       // draw-in sweep after each update
        this._up = true;
        this._t0 = GLib.get_monotonic_time();
        this._clockId = 0;
        this.connect('destroy', () => this._stop());
        this._start();
    }

    setSeries(values, prevClose, animate = true) {
        this._values = values;
        this._prevClose = prevClose;
        if (values?.length)
            this._up = prevClose != null
                ? values.at(-1) >= prevClose : values.at(-1) >= values[0];
        this._progress = animate ? 0 : 1;
        this._t0 = GLib.get_monotonic_time();
    }

    vfunc_repaint() {
        // repaint rule: touch only get_surface_size + get_context here
        let [width, height] = this.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const cr = this.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        paintSparkline(cr, {
            w: width, h: height, values: this._values ?? [],
            prevClose: this._prevClose, progress: this._progress,
            glow: this._values?.length && this._progress >= 1
                ? (1 + Math.sin((GLib.get_monotonic_time() - this._t0)
                                / 1e6 * Math.PI / 1.25)) / 2 : 0,
        });
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        if (this._progress < 1) {
            this._progress =
                Math.min(1, (now - this._t0) / 1e6 / 0.55);   // 550 ms draw-in
        }
        return Clutter.SOURCE_CONTINUE ?? GLib.SOURCE_CONTINUE;
    }

    _start() {
        if (this._clockId)
            return;
        this._clockId = GLib.timeout_add(GLib.PRIORITY_LOW, FRAME_MS, () => {
            if (this.mapped ?? true) {
                this._tick();
                this.queue_repaint();
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

/* cairo.CLEAR without importing cairo in this module (painters own cairo):
 * Operator.CLEAR == 0, and St repaints need a real clear each frame. */
function CairoClear() {
    return 0;   // CAIRO_OPERATOR_CLEAR
}

/* ── the indicator ──────────────────────────────────────────────────────── */
const TickerIndicator = GObject.registerClass(
class TickerIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, _('TickerGlass'), false);

        this._ext = ext;
        this._settings = ext.getSettings();
        this._client = new MarketClient(this._settings.get_string('data-source'));
        this._timer = 0; this._retryTimer = 0; this._tickerId = 0;
        this._busy = false; this._refetch = false; this._dead = false;
        this._quotes = [];
        this._tickerIdx = 0;

        this._dark = _interfaceIsDark();

        // panel contents
        this._box = new St.BoxLayout({style_class: 'tg-panel-box',
                                      y_align: Clutter.ActorAlign.CENTER});
        this._spark = new SparkIcon();
        this._symLbl = new St.Label({style_class: 'tg-panel-sym'});
        this._priceLbl = new St.Label({style_class: 'tg-panel-price',
                                       y_align: Clutter.ActorAlign.CENTER});
        this._chgLbl = new St.Label({style_class: 'tg-panel-chg',
                                     y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._spark);
        this._box.add_child(this._symLbl);
        this._box.add_child(this._priceLbl);
        this._box.add_child(this._chgLbl);
        this.add_child(this._box);

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
        this._panel.onSwitchWl = id =>
            this._settings.set_string('active-watchlist', id);
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

        this._applyPanelMode();
        this._renderPanel();
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

    _lead() {
        const lead = this._settings.get_string('panel-lead-symbol');
        const syms = this._symbols();
        if (lead && syms.includes(lead))
            return lead;
        const sel = this._settings.get_string('selected-symbol');
        return syms.includes(sel) ? sel : (syms[0] ?? '');
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
            this._panel.render(this._state());
            return;
        }
        const symbols = this._symbols();
        if (!symbols.length) {
            this._quotes = [];
            this._error = 'empty';
            this._renderPanel();
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
                this._renderPanel();
                this._panel.render(this._state());
                this._panel.ensureHero();
                this._restartTimer();
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
                this._panel.render(this._state());
                this._restartTimer();
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

    /* ── panel rendering ──────────────────────────────────────────────── */

    _renderPanel() {
        const lead = this._lead();
        const q = this._quotes.find(x => x.symbol === lead);
        const mode = this._settings.get_string('panel-mode');
        const showChg = this._settings.get_boolean('panel-show-change');
        const darkCls = this._dark ? 'tg-dark' : 'tg-light';
        this._box.remove_style_class_name(this._dark ? 'tg-light' : 'tg-dark');
        this._box.add_style_class_name(darkCls);

        const up = q?.change != null ? q.change >= 0 : true;
        const dirCls = up ? 'tg-up' : 'tg-down';
        for (const lbl of [this._priceLbl, this._chgLbl, this._symLbl]) {
            lbl.remove_style_class_name('tg-up');
            lbl.remove_style_class_name('tg-down');
        }

        if (mode === 'ticker') {
            this._spark.hide();
            this._symLbl.show();
            this._startTicker();
        } else {
            this._symLbl.hide();
            this._spark.visible = mode === 'sparkline';
            this._stopTicker();
            this._spark.remove_style_class_name('tg-up');
            this._spark.remove_style_class_name('tg-down');
            const spark = q?.spark?.length
                ? q.spark : this._quotes.find(x => x.spark?.length)?.spark;
            this._spark.setSeries(spark ?? null, q?.prevClose ?? null);
            if (spark)
                this._spark.add_style_class_name(dirCls);
        }

        this._priceLbl.add_style_class_name(dirCls);
        this._priceLbl.set_text(q?.price != null
            ? fmtPrice(q.price, q.currency) : '—');
        this._chgLbl.visible = showChg && q?.change != null;
        this._chgLbl.add_style_class_name(dirCls);
        if (q?.change != null)
            this._chgLbl.set_text(
                `${q.changePct >= 0 ? '▲' : '▼'} ${fmtPct(q.changePct)}`);
    }

    _startTicker() {
        this._stopTicker();
        const spin = () => {
            const qs = this._quotes.filter(q => q.price != null);
            if (!qs.length)
                return GLib.SOURCE_CONTINUE;
            this._tickerIdx = (this._tickerIdx + 1) % qs.length;
            const q = qs[this._tickerIdx];
            this._symLbl.remove_style_class_name('tg-up');
            this._symLbl.remove_style_class_name('tg-down');
            this._symLbl.add_style_class_name(q.change >= 0 ? 'tg-up' : 'tg-down');
            this._symLbl.set_text(`${q.symbol.replace(/^\^/, '')} ` +
                                  fmtPrice(q.price, q.currency));
            return GLib.SOURCE_CONTINUE;
        };
        spin();
        this._tickerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 4, spin);
    }

    _stopTicker() {
        if (this._tickerId) {
            GLib.source_remove(this._tickerId);
            this._tickerId = 0;
        }
    }

    _applyPanelMode() {
        // symbol label only exists in ticker mode
        if (this._settings.get_string('panel-mode') !== 'ticker')
            this._stopTicker();
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
            this._renderPanel();
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
        case 'refresh-seconds':
        case 'panel-mode':
        case 'panel-lead-symbol':
        case 'panel-show-change':
        case 'panel-spark-range':
            this._applyPanelMode();
            this._renderPanel();
            if (key === 'panel-spark-range')
                this._fetch(true);
            else if (key === 'refresh-seconds')
                this._restartTimer();
            break;
        }
    }

    destroy() {
        this._dead = true;
        for (const id of [this._timer, this._retryTimer, this._tickerId])
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
