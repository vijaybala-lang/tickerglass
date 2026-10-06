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
 * header → hero price → top-gainers and top-losers rows (click launches
 * the app) → open-app button → footer. Quotes arrive from extension.js;
 * this file only renders. No chart here anymore: history lives one
 * click away, in the app. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {paintMiniSpark, paintTri} from './spark.js';
import {fmtPrice, fmtPct} from './fmt.js';
import {_, N_} from './i18n.js';

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

function spacer() {
    return new St.Widget({
        x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        reactive: false, can_focus: false,
    });
}

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
    constructor({dark, onRefresh}) {
        this._dark = dark;
        this._onRefresh = onRefresh;
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

        /* header: the card's one heading, market status, refresh.
         * The watchlist name and the hero price used to live up
         * here — both axed: this card is the movers board, and the
         * app owns the per-symbol/active-list chrome */
        const head = row();
        head.style_class = 'tg-header';
        head.add_child(label(_("Today's Top Movers"), 'tg-title'));
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

        /* symbol rows */
        this._rows = new St.BoxLayout({vertical: true, style_class: 'tg-rows'});
        m.add_child(this._rows);

        /* open the desktop app — the card is a glance; the window is
         * where the depth lives (charts, compare, news, organize) */
        this._openAppBtn = new St.Button({style_class: 'tg-open-app',
                                          can_focus: true,
                                          x_expand: true});
        const oa = new St.BoxLayout({style_class: 'tg-open-app-row',
                                     x_align: Clutter.ActorAlign.CENTER});
        oa.add_child(new St.Icon({icon_name: 'system-run-symbolic',
                                  icon_size: 16}));
        oa.add_child(new St.Label({text: _('Open TickerGlass'),
                                   style_class: 'tg-open-app-label',
                                   y_align: Clutter.ActorAlign.CENTER}));
        this._openAppBtn.set_child(oa);
        this._openAppBtn.connect('clicked', () => this.onOpenApp?.());
        m.add_child(this._openAppBtn);

        /* footer */
        const foot = row();
        foot.style_class = 'tg-foot';
        this._updLbl = new St.Label({text: '', style_class: 'tg-updated'});
        foot.add_child(this._updLbl);
        foot.add_child(spacer());
        /* one gear, not a gear + a plus: both opened the same prefs */
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

        // the headline status still rides the symbol the app has open
        // (state.hero), falling back to the first quote
        const hero = state.quotes.find(q => q.symbol === state.hero)
                  ?? state.quotes[0];
        if (hero) {
            const st = stateIcon[hero.state] ?? stateIcon.CLOSED;
            this._statusLbl.set_text(
                `${_(st.txt)} · ${hero.exchange || hero.symbol}`);
            this._statusLbl.remove_style_class_name('tg-status-open');
            this._statusLbl.remove_style_class_name('tg-status-shut');
            this._statusLbl.add_style_class_name(st.on ? 'tg-status-open'
                                                       : 'tg-status-shut');
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

    /* movers board under the "Today's Top Movers" title: the active
     * list's five biggest gainers (best on top) then five biggest
     * losers (worst on top). Every row is a jump-off — a click hands
     * the symbol to extension.js, which points the app at the
     * watchlist containing it and raises the window; the subtle
     * selected-pill marks whichever symbol the app currently has open */
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

    /* THE app's sidebar tile, ported column-for-column from
     * _rebuildSidebar's own comment: "three columns: [sym | spark]
     * with the name as its second line on the left, and price+pct as
     * an independent right column CENTERED against the full two-line
     * height — so the name hugs the sparkline instead of sitting
     * under it". The old single-top-row port broke that rhythm (name
     * floated below the price column, spark read short). Clicking the
     * tile opens the symbol in the app. */
    _mkRow(q, selected) {
        const btn = new St.Button({style_class: 'tg-row' +
                                    (selected ? ' tg-row-sel' : ''),
                                   can_focus: true, x_expand: true});
        const wrap = new St.BoxLayout({style_class: 'tg-row-wrap'});
        wrap.x_align = Clutter.ActorAlign.FILL;   // St-18 Bin centers
        const leftV = new St.BoxLayout({vertical: true,
                                        style_class: 'tg-row-left'});
        leftV.x_align = Clutter.ActorAlign.FILL;
        leftV.x_expand = true;                    // the app's hexpand
        const top = new St.BoxLayout({style_class: 'tg-row-top'});
        top.x_align = Clutter.ActorAlign.FILL;
        top.add_child(label(q.symbol.replace(/^\^/, ''), 'tg-row-sym'));
        const spark = new MiniSpark(q.spark, (q.change ?? 0) >= 0);
        spark.x_expand = true;
        top.add_child(spark);
        leftV.add_child(top);
        const nm = (q.name ?? '').replace(/[\u2018\u2019'].*/g, '')
            .replace(/(Common|Corp|Inc|Holdings|Group|Plc|Ltd|Co)\.?$/i, '')
            .trim();
        leftV.add_child(label(nm.length > 26 ? nm.slice(0, 25) + '…' : nm,
                              'tg-row-name'));
        wrap.add_child(leftV);
        // independent right column, centered against the two lines
        const praw = new St.BoxLayout({vertical: true,
                                       style_class: 'tg-row-praw',
                                       y_align: Clutter.ActorAlign.CENTER});
        praw.add_child(new St.Label({
            text: q.price != null ? fmtPrice(q.price, q.currency) : '—',
            style_class: 'tg-row-price'}));
        const up = (q.change ?? q.changePct ?? 0) >= 0;
        const pctBox = new St.BoxLayout({style_class: 'tg-row-pctbox' +
            (q.change != null ? (up ? ' tg-up' : ' tg-down') : '')});
        pctBox.add_child(new Tri(up));
        if (q.changePct != null)
            pctBox.add_child(new St.Label({text: fmtPct(q.changePct),
                                           style_class: 'tg-row-pct'}));
        praw.add_child(pctBox);
        wrap.add_child(praw);
        btn.set_child(wrap);
        btn.connect('clicked', () => this.onOpenSym?.(q.symbol));
        return btn;
    }

    setDark(dark) {
        this._dark = dark;
    }

    destroy() {
        if (this._clockId)
            GLib.source_remove(this._clockId);
        this.actor.destroy();
    }
}
