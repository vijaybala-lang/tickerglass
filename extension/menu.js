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

/* the refresh button's busy spinner — weatherglass's exact drawing kit
 * (St.DrawingArea + vfunc_repaint, same as Tri above) and frame-loop,
 * just 8 spokes with a fading tail at 90 ms/frame. Rotation was the
 * wrong tool here twice over: St-18 has no spinning-icon support, and
 * Clutter's z-rotation about a pivot is precisely the wobble that was
 * shipped by mistake. Frames tick only while mapped and spinning. */
const Spin16 = GObject.registerClass(
class Spin16 extends St.DrawingArea {
    _init(dark) {
        super._init({width: 16, height: 16,
                     y_align: Clutter.ActorAlign.CENTER,
                     reactive: false, can_focus: false});
        this._dark = dark;
        this._frame = 0;
        this._id = 0;
        this.connect('destroy', () => this._stop());
    }

    spinStart() {
        if (this._id)
            return;
        this._id = GLib.timeout_add(GLib.PRIORITY_LOW, 90, () => {
            this._frame = (this._frame + 1) % 8;
            if (this.mapped ?? true)
                this.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    spinStop() {
        this._stop();
    }

    _stop() {
        if (this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
    }

    vfunc_repaint() {
        const [w, h] = this.get_surface_size();
        if (w <= 0 || h <= 0)
            return;
        const cr = this.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const ink = this._dark ? [1, 1, 1]
                               : [16 / 255, 24 / 255, 35 / 255];
        const c = Math.min(w, h) / 2;
        cr.setLineWidth(c * 0.34);
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            // the freshest spoke is full ink; a fading tail trails it
            const age = (this._frame - i + 8) % 8;
            cr.setSourceRGBA(ink[0], ink[1], ink[2],
                             Math.max(0.15, 0.9 - age * 0.1));
            cr.moveTo(c + Math.cos(a) * c * 0.38, c + Math.sin(a) * c * 0.38);
            cr.lineTo(c + Math.cos(a) * c * 0.8, c + Math.sin(a) * c * 0.8);
            cr.stroke();
        }
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
        // and now the same 56×22 box, so the curve renders identically.
        // x_expand in the CONSTRUCTOR (the app's hexpand): post-init
        // expand/align claims are dead in St-18, ctor ones are proven
        super._init({style_class: 'tg-row-spark', width: 56, height: 22,
                     reactive: false, can_focus: false,
                     x_expand: true,
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
    REGULAR: {txt: N_('Market open'), on: true},
    PRE: {txt: N_('Pre-market'), on: true},
    POST: {txt: N_('After-hours'), on: true},
    CLOSED: {txt: N_('Closed'), on: false},
};

export class TickerPanel {
    constructor({dark, onRefresh, twoCol}) {
        this._dark = dark;
        this._onRefresh = onRefresh;
        this._twoCol = twoCol !== false;            // default: board wide
        this._clockId = 0;
        // extension.js sets this to close its popup before prefs open:
        // a live PopupMenu holds Clutter's input grab and the prefs
        // window can't surface over it (classic openPrefs-from-menu bug)
        this.onCloseMenu = null;
        // orientation, not vertical: St removed the 'vertical'
        // property in GNOME 51 (deprecated in 48) — passing it in a
        // constructor throws and the card never builds
        this.actor = new St.BoxLayout({style_class: 'tg-content',
                                       orientation: Clutter.Orientation.VERTICAL});
        if (this._twoCol)
            this.actor.add_style_class_name('tg-2col');
        if (!this._dark)
            this.actor.add_style_class_name('tg-light-ink');

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
        let box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                    style_class: 'tg-placeholder',
                                    visible: false});
        this._phLbl = new St.Label({text: _('Loading…'), style_class: 'tg-placeholder-text',
                                    x_align: Clutter.ActorAlign.CENTER,
                                    y_align: Clutter.ActorAlign.CENTER,
                                    y_expand: true});
        box.add_child(this._phLbl);
        return box;
    }

    _buildMain() {
        const m = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                    style_class: 'tg-main',
                                    visible: false});

        /* header: the card's one heading, market status, settings and
         * refresh. The watchlist name and the hero price used to live
         * up here — both axed: this card is the movers board, and the
         * app owns the per-symbol/active-list chrome */
        const head = row();
        head.style_class = 'tg-header';
        head.add_child(label(_("Today's Top Movers"), 'tg-title'));
        head.add_child(spacer());
        // y_align in the CONSTRUCTOR (the ctor-only law): without the
        // claim the badge FILLs the header's cross axis and the pill
        // stretches into a tall ellipse
        this._statusLbl = new St.Label({text: '',
                                        style_class: 'tg-status-badge',
                                        y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._statusLbl);
        /* settings rides the header next to refresh — the footer is
         * just the clock now; the two utility buttons live together */
        this._gearBtn = new St.Button({style_class: 'tg-icon-btn',
                                       can_focus: true});
        this._gearBtn.set_child(new St.Icon({icon_name: 'emblem-system-symbolic',
                                             icon_size: 16}));
        this._gearBtn.connect('clicked', () => this._openPrefs());
        head.add_child(this._gearBtn);
        this._refreshBtn = new St.Button({style_class: 'tg-icon-btn',
                                          can_focus: true});
        this._refreshIcon = new St.Icon({icon_name: 'view-refresh-symbolic',
                                         icon_size: 16});
        // the spinner stands in for the icon while a round is live;
        // extension.js drives setBusy() at the fetch's start/end
        this._spinner = new Spin16(this._dark);
        this._spinner.visible = false;
        const spinBox = new St.BoxLayout({reactive: false,
                                          can_focus: false});
        spinBox.add_child(this._refreshIcon);
        spinBox.add_child(this._spinner);
        this._refreshBtn.set_child(spinBox);
        this._refreshBtn.connect('clicked', () => this._onRefresh?.());
        head.add_child(this._refreshBtn);
        m.add_child(head);

        /* symbol rows */
        this._rows = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                       style_class: 'tg-rows'});
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
        m.add_child(foot);

        return m;
    }

    _openPrefs() {
        // close the popup first: its Clutter grab would otherwise keep
        // the prefs window from ever surfacing; open on the beat after
        // the close so the grab has actually released
        this.onCloseMenu?.();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                this.onOpenPrefs?.();
            } catch (e) {
                logError(e, 'TickerGlass');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /* a fetch round is in flight: the refresh glyph stands down and
     * the spinner takes its seat — driven by extension.js, so it also
     * proves the click landed without any rotation acrobatics */
    setBusy(on) {
        this._refreshIcon.visible = !on;
        this._spinner.visible = on;
        if (on)
            this._spinner.spinStart();
        else
            this._spinner.spinStop();
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
            // the badge describes the BOARD's market, not one symbol's
            // exchange: a 24/7 crypto or an overseas listing would keep
            // it glowing "open" long after NYSE shut. Take the dominant
            // session state across the watchlist's quotes.
            const tally = {};
            for (const q of state.quotes)
                tally[q.state] = (tally[q.state] || 0) + 1;
            const dom = Object.entries(tally)
                .sort((a, b) => b[1] - a[1])[0][0];
            const st = stateIcon[dom] ?? stateIcon.CLOSED;
            // just the market state — the bigger title and the gear
            // moved into this row, and '· NYSE' never informed a
            // decision on a movers board
            this._statusLbl.set_text(_(st.txt));
            this._statusLbl.remove_style_class_name('tg-badge-open');
            this._statusLbl.remove_style_class_name('tg-badge-shut');
            this._statusLbl.add_style_class_name(st.on ? 'tg-badge-open'
                                                       : 'tg-badge-shut');
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
     * losers (worst on top). Every row is a pure jump-off — a click
     * hands the symbol to extension.js, which points the app at the
     * watchlist containing it and raises the window. There's no
     * selected state: the card never mirrors which symbol the app
     * happens to have open, hover/press alone signal clickability */
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
            return lbl;
        };
        /* hairline under each header: a CSS border-bottom on the label
         * did NOT paint in St-18, so this is a real 1px widget with a
         * background-color — the one paint path proven in this world.
         * Geometry: neither CSS margin nor ctor margin_* properties
         * applied to the bare line (both tried, both measured absent
         * on-screen), so the insets ride CSS PADDING on a real wrapper
         * — the mechanism every working widget in this card uses. */
        const rule = () => {
            const line = new St.BoxLayout({style_class: 'tg-sec-rule',
                                           // ctor claims (the ctor-only
                                           // law): span the wrapper's
                                           // content box, not natural
                                           // min-width centered
                                           x_align: Clutter.ActorAlign.FILL,
                                           x_expand: true});
            const pad = new St.BoxLayout({style_class: 'tg-rule-pad',
                                          x_align: Clutter.ActorAlign.FILL,
                                          x_expand: true});
            pad.add_child(line);
            return pad;
        };
        /* two-column board (default): gainers left, losers right — the
         * scoreboard read, half the vertical stretch. When one side is
         * empty the card narrows itself back to stacked rows: a column
         * of nothing wastes half a 500px card */
        const moverCol = (qs, up) => {
            const c = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                        style_class: 'tg-col',
                                        x_align: Clutter.ActorAlign.FILL,
                                        x_expand: true});
            c.add_child(section(up ? _('▲  Top gainers')
                                   : _('▼  Top losers'),
                                up ? 'tg-sec-up' : 'tg-sec-down'));
            c.add_child(rule());
            for (const q of qs)
                c.add_child(this._mkRow(q));
            return c;
        };
        if (this._twoCol && g.length && l.length) {
            const cols = new St.BoxLayout({style_class: 'tg-cols',
                                           x_align: Clutter.ActorAlign.FILL,
                                           x_expand: true});
            cols.add_child(moverCol(g, true));
            cols.add_child(moverCol(l, false));
            this._rows.add_child(cols);
        } else {
            if (g.length) {
                this._rows.add_child(section(_('▲  Top gainers'),
                                             'tg-sec-up'));
                this._rows.add_child(rule());
                for (const q of g)
                    this._rows.add_child(this._mkRow(q));
            }
            if (l.length) {
                this._rows.add_child(section(_('▼  Top losers'),
                                             'tg-sec-down'));
                this._rows.add_child(rule());
                for (const q of l)
                    this._rows.add_child(this._mkRow(q));
            }
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
    _mkRow(q) {
        const btn = new St.Button({style_class: 'tg-row',
                                   can_focus: true, x_expand: true});
        // All align/expand claims go in the CONSTRUCTOR: post-init
        // assignment measured dead on GNOME 50 (0048194's x_align
        // assigns changed nothing; ctor-set aligns — label()'s START,
        // Tri's y_center, hero's END — demonstrably work).
        const wrap = new St.BoxLayout({style_class: 'tg-row-wrap',
                                       x_align: Clutter.ActorAlign.FILL});
        const leftV = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                        style_class: 'tg-row-left',
                                        x_align: Clutter.ActorAlign.FILL,
                                        x_expand: true});
        const top = new St.BoxLayout({style_class: 'tg-row-top',
                                      x_align: Clutter.ActorAlign.FILL});
        top.add_child(label(q.symbol.replace(/^\^/, ''), 'tg-row-sym'));
        const spark = new MiniSpark(q.spark, (q.change ?? 0) >= 0);
        top.add_child(spark);
        leftV.add_child(top);
        const nm = (q.name ?? '').replace(/[\u2018\u2019'].*/g, '')
            .replace(/(Common|Corp|Inc|Holdings|Group|Plc|Ltd|Co)\.?$/i, '')
            .trim();
        leftV.add_child(label(nm.length > 26 ? nm.slice(0, 25) + '…' : nm,
                              'tg-row-name'));
        wrap.add_child(leftV);
        // independent right column, centered against the two lines
        const praw = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
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

    /* adaptive ink (the WeatherGlass pattern, now truly wired): the
     * card hand-paints its own inks in CSS, so it must be told which
     * world the desktop lives in — whites for the dark popup, deep
     * ink for a light one. Cairo greens/reds read on both, untouched */
    setDark(dark) {
        if (this._dark === dark)
            return;
        this._dark = dark;
        if (dark)
            this.actor.remove_style_class_name('tg-light-ink');
        else
            this.actor.add_style_class_name('tg-light-ink');
        // the spinner paints its own ink (cairo, not CSS) — it has to
        // hear about the flip directly
        if (this._spinner) {
            this._spinner._dark = dark;
            this._spinner.queue_repaint();
        }
    }

    /* prefs flip it live; the caller re-renders right after */
    setTwoCol(on) {
        if (this._twoCol === on)
            return;
        this._twoCol = on;
        if (on)
            this.actor.add_style_class_name('tg-2col');
        else
            this.actor.remove_style_class_name('tg-2col');
    }

    destroy() {
        if (this._clockId)
            GLib.source_remove(this._clockId);
        this.actor.destroy();
    }
}
