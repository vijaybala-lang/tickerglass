/* menu.js — part of TickerGlass
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
/* menu.js — the dropdown card. Plain JS class with an St.Widget actor
 * embedded via a PopupMenuSection (weatherglass ForecastPanel pattern):
 * header → hero price → animated chart + range chips → top-gainers and
 * top-losers rows (click launches the app) →
 * footer. Series data arrives from extension.js; this file only renders. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {paintChart, paintMiniSpark, paintTri} from './spark.js';
import {fmtPrice, fmtDelta, fmtPct, fmtCompact, fmtTime, axisDate,
        symbolShort, RANGE_LABEL, COLORS} from './fmt.js';
import {_, N_} from './i18n.js';

const RANGES = ['1d', '7d', '1mo', '52w', 'ytd', '1y'];
const INTRADAY = new Set(['1d']);
const CHART_H = 150;

/* cairo ink can't read CSS — these mirror .tg-gcnt/.tg-lcnt/.tg-dim in
 * stylesheet.css by hand (same lesson as the old LED board) */
const INK_UP = [0.18, 1.00, 0.56];
const INK_DOWN = [1.00, 0.36, 0.42];

/* one instance of the app's shared triangle asset (paintTri), sized for
 * the top bar; dim is the resting state before the first quote round.
 * Used by the panel scoreboard (extension.js) and every movers row. */
export const Tri = GObject.registerClass(
class Tri extends St.DrawingArea {
    _init(up, size = 11) {
        super._init({width: size, height: Math.round(size * 0.9),
                     y_align: Clutter.ActorAlign.CENTER,
                     reactive: false, can_focus: false});
        this._up = up;
        this._dim = false;
    }

    setDim(dim) {
        if (this._dim === dim)
            return;
        this._dim = dim;
        this.queue_repaint();
    }

    vfunc_repaint() {
        let [w, h] = this.get_surface_size();
        if (w <= 0 || h <= 0)
            return;
        const cr = this.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        if (this._dim)
            cr.setSourceRGBA(1, 1, 1, 0.35);
        else if (this._up)
            cr.setSourceRGBA(...INK_UP, 1);
        else
            cr.setSourceRGBA(...INK_DOWN, 1);
        paintTri(cr, {w, h, up: this._up});
    }
});

const label = (text, cls) => new St.Label({
    text, style_class: cls, x_align: Clutter.ActorAlign.START,
});
const row = () => new St.BoxLayout({style_class: 'tg-rowbox'});
const col = (cls = '') => new St.BoxLayout({
    vertical: true, style_class: cls, x_align: Clutter.ActorAlign.START,
});

function spacer() {
    return new St.Widget({
        x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        reactive: false, can_focus: false,
    });
}

/* big hero chart area */
const ChartArea = GObject.registerClass(
class ChartArea extends St.DrawingArea {
    _init(panel) {
        super._init({style_class: 'tg-chart', height: CHART_H});
        this._p = panel;
        this._t0 = 0;
        this._progress = 1;
    }

    startDrawIn() {
        this._t0 = GLib.get_monotonic_time();
        this._progress = 0;
        if (this._morphId)
            GLib.source_remove(this._morphId);
        this._morphId = GLib.timeout_add(GLib.PRIORITY_LOW, 25, () => {
            const k = (GLib.get_monotonic_time() - this._t0) / 1e6 / 0.6;
            this._progress = Math.min(1, k);
            this.queue_repaint();
            if (k >= 1) {
                this._morphId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    vfunc_repaint() {
        let [width, height] = this.get_surface_size();
        if (width <= 0 || height <= 0)
            return;
        const p = this._p;
        const cr = this.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const hist = p._hist;
        if (!hist?.points?.length)
            return;
        const intraday = INTRADAY.has(hist.range);
        paintChart(cr, {
            w: width, h: height,
            points: hist.points,
            mode: p._style,
            prevClose: hist.range === '1d' ? hist.meta.prevClose : null,
            dark: p._dark,
            fmtY: v => fmtPrice(v, hist.meta.currency),
            fmtX: t => intraday ? fmtTime(t, hist.meta.tz)
                                : axisDate(t, (hist.points[hist.points.length - 1].t - hist.points[0].t) / 86400),
            progress: this._progress,
        });
    }

    destroy() {
        if (this._morphId)
            GLib.source_remove(this._morphId);
        super.destroy?.();
    }
});

/* a tiny non-animated sparkline for watchlist rows */
const MiniSpark = GObject.registerClass(
class MiniSpark extends St.DrawingArea {
    _init(values, up) {
        // same painter as the app sidebar rows (shared paintMiniSpark) —
        // and now the same 56×22 box, so the curve renders identically
        super._init({style_class: 'tg-row-spark', width: 56, height: 22,
                     reactive: false, can_focus: false,
                     y_align: Clutter.ActorAlign.CENTER});
        this._values = values ?? null;
        this._up = up;
    }

    vfunc_repaint() {
        let [width, height] = this.get_surface_size();
        if (width <= 0 || height <= 0 || !this._values?.length)
            return;
        const cr = this.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        paintMiniSpark(cr, {w: width, h: height,
                            values: this._values, up: this._up});
    }
});

const stateIcon = {
    REGULAR: {txt: N_('Open'), on: true},
    PRE: {txt: N_('Pre-market'), on: true},
    POST: {txt: N_('After-hours'), on: true},
    CLOSED: {txt: N_('Closed'), on: false},
};

export class TickerPanel {
    constructor({dark, onHero, onRefresh}) {
        this._dark = dark;
        this._onHero = onHero;
        this._onRefresh = onRefresh;
        this._hist = null;          // {symbol, range, points, meta}
        this._style = 'area';
        this._clockId = 0;
        this.actor = new St.BoxLayout({style_class: 'tg-content',
                                       vertical: true});

        this._placeholder = this._buildPlaceholder();
        this._main = this._buildMain();
        this.actor.add_child(this._placeholder);
        this.actor.add_child(this._main);
        this._showBody(false);
    }

    _showBody(have) {
        this._placeholder.visible = !have;
        this._main.visible = have;
    }

    _buildPlaceholder() {
        let box = new St.BoxLayout({vertical: true, style_class: 'tg-placeholder',
                                    visible: false});
        this._phLbl = new St.Label({text: _('Loading…'), style_class: 'tg-placeholder-text',
                                    x_align: Clutter.ActorAlign.CENTER,
                                    y_align: Clutter.ActorAlign.CENTER,
                                    y_expand: true});
        box.add_child(this._phLbl);
        return box;
    }

    _buildMain() {
        const m = new St.BoxLayout({vertical: true, style_class: 'tg-main',
                                    visible: false});

        /* header: active watchlist (read-only — the lists live in the
         * app & prefs) • market status • refresh */
        const head = row();
        head.style_class = 'tg-header';
        this._wlBox = col();
        this._wlLbl = new St.Label({text: 'Watchlist', style_class: 'tg-wl'});
        this._wlSub = new St.Label({text: '', style_class: 'tg-wl-sub'});
        this._wlBox.add_child(this._wlLbl);
        this._wlBox.add_child(this._wlSub);
        head.add_child(this._wlBox);
        head.add_child(spacer());
        this._statusLbl = new St.Label({text: '', style_class: 'tg-status'});
        head.add_child(this._statusLbl);
        this._refreshBtn = new St.Button({style_class: 'tg-icon-btn',
                                          can_focus: true});
        this._refreshIcon = new St.Icon({icon_name: 'view-refresh-symbolic',
                                         icon_size: 16});
        this._refreshBtn.set_child(this._refreshIcon);
        this._refreshBtn.connect('clicked', () => this._onRefresh?.());
        head.add_child(this._refreshBtn);
        m.add_child(head);

        /* hero: symbol + name on the left, big price + pill right */
        const hero = row();
        hero.style_class = 'tg-hero';
        const hcol = col();
        this._heroSym = new St.Label({text: '', style_class: 'tg-hero-sym'});
        this._heroName = new St.Label({text: '', style_class: 'tg-hero-name'});
        hcol.add_child(this._heroSym);
        hcol.add_child(this._heroName);
        hero.add_child(hcol);
        hero.add_child(spacer());
        const pcol = new St.BoxLayout({vertical: true,
                                       x_align: Clutter.ActorAlign.END});
        this._heroPrice = new St.Label({text: '', style_class: 'tg-hero-price',
                                        x_align: Clutter.ActorAlign.END});
        this._heroPill = new St.Label({text: '', style_class: 'tg-pill'});
        this._heroPill.set_x_align(Clutter.ActorAlign.END);
        pcol.add_child(this._heroPrice);
        pcol.add_child(this._heroPill);
        hero.add_child(pcol);
        m.add_child(hero);

        /* chart + range chips */
        this._chart = new ChartArea(this);
        m.add_child(this._chart);
        const tabs = new St.BoxLayout({style_class: 'tg-tabs'});
        this._tabBtns = {};
        for (const r of RANGES) {
            const b = new St.Button({style_class: 'tg-tab', can_focus: true});
            b.set_child(new St.Label({text: RANGE_LABEL[r],
                                       style_class: 'tg-tab-label'}));
            b.connect('clicked', () => {
                this.onRange?.(r);
            });
            tabs.add_child(b);
            this._tabBtns[r] = b;
        }
        this._tabs = tabs;
        m.add_child(tabs);

        /* symbol rows */
        this._rows = new St.BoxLayout({vertical: true, style_class: 'tg-rows'});
        m.add_child(this._rows);

        /* footer */
        const foot = row();
        foot.style_class = 'tg-foot';
        this._updLbl = new St.Label({text: '', style_class: 'tg-updated'});
        foot.add_child(this._updLbl);
        foot.add_child(spacer());
        this._addBtn = new St.Button({style_class: 'tg-icon-btn'});
        this._addBtn.set_child(new St.Icon({icon_name: 'list-add-symbolic',
                                            icon_size: 16}));
        this._addBtn.connect('clicked', () => this._openPrefs());
        foot.add_child(this._addBtn);
        this._gearBtn = new St.Button({style_class: 'tg-icon-btn'});
        this._gearBtn.set_child(new St.Icon({icon_name: 'emblem-system-symbolic',
                                             icon_size: 16}));
        this._gearBtn.connect('clicked', () => this._openPrefs());
        foot.add_child(this._gearBtn);
        m.add_child(foot);

        return m;
    }

    _openPrefs() {
        try {
            Main.extensionManager.lookup('tickerglass@vijaybala.dev')
                .openPreferences();
        } catch (e) {
            logError(e, 'TickerGlass');
        }
    }

    /* public API driven by extension.js */

    render(state) {
        this._state = state;
        this._wl = state.watchlists;
        this._active = state.active;
        this._style = state.chartStyle ?? 'area';

        if (state.error === 'rate') {
            this._showBody(false);
            this._phLbl.set_text(
                _('Yahoo is rate-limiting — retrying in %ds').format(state.retryIn || 30));
            return;
        }
        if (state.error === 'empty') {
            this._showBody(false);
            this._phLbl.set_text(_('No symbols yet — open ⚙ to add some'));
            return;
        }
        if (!state.quotes?.length) {
            this._showBody(false);
            this._phLbl.set_text(state.error === 'fetch'
                ? _('Could not reach Yahoo Finance') : _('Loading…'));
            return;
        }
        this._showBody(true);

        const wl = this._wl.find(w => w.id === this._active);
        this._wlLbl.set_text(wl?.name ?? '');
        this._wlSub.set_text(this._wl.length > 1
            ? _('%d lists · edit in app/⚙').format(this._wl.length)
            : _('edit in app/⚙'));

        const hero = state.quotes.find(q => q.symbol === state.hero)
                  ?? state.quotes[0];
        if (hero) {
            this._heroSym.set_text(symbolShort(hero.symbol));
            this._heroName.set_text([hero.name !== hero.symbol ? hero.name : '',
                                     hero.exchange].filter(Boolean).join(' · '));
            this._heroPrice.set_text(hero.price != null
                ? fmtPrice(hero.price, hero.currency) : '—');
            const up = (hero.change ?? 0) >= 0;
            this._heroPill.remove_style_class_name('tg-pill-up');
            this._heroPill.remove_style_class_name('tg-pill-down');
            this._heroPill.add_style_class_name(up ? 'tg-pill-up' : 'tg-pill-down');
            this._heroPill.set_text(hero.change != null
                ? `${up ? '▲' : '▼'} ${fmtDelta(hero.change, hero.currency)}` +
                  `  ${fmtPct(hero.changePct)}`
                : '');
            const st = stateIcon[hero.state] ?? stateIcon.CLOSED;
            this._statusLbl.set_text(
                `${_(st.txt)} · ${hero.exchange || hero.symbol}`);
            this._statusLbl.remove_style_class_name('tg-status-open');
            this._statusLbl.remove_style_class_name('tg-status-shut');
            this._statusLbl.add_style_class_name(st.on ? 'tg-status-open'
                                                       : 'tg-status-shut');
        }

        // range tab selection
        for (const [r, b] of Object.entries(this._tabBtns)) {
            b.remove_style_class_name('tg-tab-active');
            if (r === state.range)
                b.add_style_class_name('tg-tab-active');
        }

        this._buildRows(state);
        this._tickClock();
    }

    _tickClock() {
        if (!this._state?.atWall)
            return;
        const t = new Date(this._state.atWall * 1000);
        this._updLbl.set_text(_('updated %02d:%02d')
            .format(t.getHours(), t.getMinutes()));
    }

    /* movers-first card: the active list's five biggest gainers (best
     * on top) then five biggest losers (worst on top). Every row is a
     * jump-off — a click hands the symbol to extension.js, which
     * points the app at the watchlist containing it and raises the
     * window; the hero/chart above stays the extension's own preview */
    _buildRows(state) {
        this._rows.destroy_all_children();
        const qs = state.quotes.filter(q => q.price != null &&
            q.changePct != null);
        const g = qs.filter(q => q.changePct > 0)
            .sort((a, b) => b.changePct - a.changePct).slice(0, 5);
        const l = qs.filter(q => q.changePct < 0)
            .sort((a, b) => a.changePct - b.changePct).slice(0, 5);
        if (!g.length && !l.length) {
            this._rows.add_child(label(
                qs.length ? _('Nothing moved today — every symbol flat')
                         : _('Waiting for the first quote round…'),
                'tg-nomove'));
            return;
        }
        const section = (text, cls) => {
            const lbl = label(text, 'tg-sec-h');
            lbl.add_style_class_name(cls);
            this._rows.add_child(lbl);
        };
        if (g.length) {
            section(_('▲  Top gainers'), 'tg-sec-up');
            for (const q of g)
                this._rows.add_child(this._mkRow(q, q.symbol === state.hero));
        }
        if (l.length) {
            section(_('▼  Top losers'), 'tg-sec-down');
            for (const q of l)
                this._rows.add_child(this._mkRow(q, q.symbol === state.hero));
        }
    }

    /* THE app's sidebar tile, rebuilt in St: symbol at the head of the
     * top line, the sparkline filling the middle, the price right with
     * triangle + percent beneath it (direction carried by the shared
     * paintTri asset and the tg-up/tg-down colour, exactly as the app
     * composes it), company name dim on a second line. Clicking the
     * tile opens the symbol in the app. */
    _mkRow(q, selected) {
        const btn = new St.Button({style_class: 'tg-row' +
                                    (selected ? ' tg-row-sel' : ''),
                                   can_focus: true});
        const tile = col('tg-row-tile');
        const top = row();
        top.add_child(label(q.symbol.replace(/^\^/, ''), 'tg-row-sym'));
        const spark = new MiniSpark(q.spark, (q.change ?? 0) >= 0);
        spark.x_expand = true;      // the app's hexpand: it fills
        top.add_child(spark);
        const praw = col('tg-row-praw');
        praw.add_child(new St.Label({
            text: q.price != null ? fmtPrice(q.price, q.currency) : '—',
            style_class: 'tg-row-price',
            x_align: Clutter.ActorAlign.END}));
        const up = (q.change ?? q.changePct ?? 0) >= 0;
        const pctBox = new St.BoxLayout({style_class: 'tg-row-pctbox' +
            (q.change != null ? (up ? ' tg-up' : ' tg-down') : ''),
                                         y_align: Clutter.ActorAlign.END});
        pctBox.add_child(new Tri(up));
        if (q.changePct != null) {
            pctBox.add_child(new St.Label({
                text: fmtPct(q.changePct),
                style_class: 'tg-row-pct',
                x_align: Clutter.ActorAlign.END}));
        }
        praw.add_child(pctBox);
        top.add_child(praw);
        tile.add_child(top);
        const nm = (q.name ?? '').replace(/[\u2018\u2019'].*/g, '')
            .replace(/(Common|Corp|Inc|Holdings|Group|Plc|Ltd|Co)\.?$/i, '')
            .trim();
        tile.add_child(label(nm.length > 26 ? nm.slice(0, 25) + '…' : nm,
                             'tg-row-name'));
        btn.set_child(tile);
        btn.connect('clicked', () => this.onOpenSym?.(q.symbol));
        return btn;
    }

    /** extension.js hands over history for hero+range (or null on failure) */
    setHeroSeries(hist) {
        this._hist = hist;
        this._chart.startDrawIn();
    }

    /** called after render/settings change: fetch if the current hero+range
     *  isn't loaded yet */
    ensureHero(reload = false) {
        const s = this._state;
        if (!s?.hero)
            return;
        if (!reload && this._hist?.symbol === s.hero &&
            this._hist?.range === s.range)
            return;
        this._onHero?.(s.hero, s.range);
    }

    setDark(dark) {
        this._dark = dark;
        this._chart?.queue_repaint();
    }

    destroy() {
        if (this._clockId)
            GLib.source_remove(this._clockId);
        this._chart?.destroy?.();
        this.actor.destroy();
    }
}
