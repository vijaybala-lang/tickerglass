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
/* extension.js — panel gainers/losers counter button, timers, settings
 * glue. Conventions inherited from weatherglass/extension.js:
 * PanelMenu.Button subclass, gsettings-driven everything, monotonic timers
 * with 0 sentinels, _busy/_refetch/_dead async guards, stale data kept on
 * failure. */

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
import {paintTri} from './spark.js';
import {initI18n, _} from './i18n.js';
import {parseWatchlists} from './fmt.js';

const APP_DESKTOP_ID = 'dev.vijaybala.TickerGlass.desktop';

/* cairo ink can't read CSS — these mirror .tg-gcnt/.tg-lcnt/.tg-dim in
 * stylesheet.css by hand (same lesson as the old LED board) */
const INK_UP = [0.18, 1.00, 0.56];
const INK_DOWN = [1.00, 0.36, 0.42];

/* one instance of the app's shared triangle asset (paintTri), sized for
 * the top bar; dim is the resting state before the first quote round */
const Tri = GObject.registerClass(
class Tri extends St.DrawingArea {
    _init(up) {
        super._init({width: 11, height: 10,
                     y_align: Clutter.ActorAlign.CENTER,
                     reactive: false, can_focus: false});
        this._up = up;
        this._dim = true;
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

/* ── the indicator ──────────────────────────────────────────────────────── */
const TickerIndicator = GObject.registerClass(
class TickerIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, _('TickerGlass'), false);

        this._ext = ext;
        this._settings = ext.getSettings();
        this._client = new MarketClient(this._settings.get_string('data-source'));
        this._timer = 0; this._retryTimer = 0;
        this._busy = false; this._refetch = false; this._dead = false;
        this._quotes = [];

        this._dark = _interfaceIsDark();

        // the panel is a scoreboard: the app's own triangle asset in
        // green and red, each followed by how many of the active
        // watchlist's symbols are up / down — same quotes the dropdown
        // shows, zero extra network
        this._box = new St.BoxLayout({style_class: 'tg-panel-box',
                                      y_align: Clutter.ActorAlign.CENTER});
        this._gTri = new Tri(true);
        this._lTri = new Tri(false);
        this._gLbl = new St.Label({style_class: 'tg-gcnt tg-dim',
                                   y_align: Clutter.ActorAlign.CENTER,
                                   text: '—'});
        this._lLbl = new St.Label({style_class: 'tg-lcnt tg-dim',
                                   y_align: Clutter.ActorAlign.CENTER,
                                   text: '—'});
        this._sepLbl = new St.Label({style_class: 'tg-sep',
                                     y_align: Clutter.ActorAlign.CENTER,
                                     text: '·'});
        this._box.add_child(this._gTri);
        this._box.add_child(this._gLbl);
        this._box.add_child(this._sepLbl);
        this._box.add_child(this._lTri);
        this._box.add_child(this._lLbl);
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
        // a mover row is a jump-off: point the app at the first
        // watchlist containing that ticker, then bring its window up
        this._panel.onOpenSym = sym => this._openInApp(sym);
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
            this._renderPanel();
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
                this._renderPanel();
                this._panel.render(this._state());
                this._restartTimer();
            });
    }

    /* ── the scoreboard: watchlist breadth ───────────────────────────────
     * The quote round that feeds the dropdown IS the feed: one label
     * counts symbols up on the day, the other counts them down. Flat
     * (0.00%) names are counted by neither; before the first round the
     * counters rest as dim dashes */

    _renderPanel() {
        const qs = this._quotes.filter(q => q.changePct != null);
        const g = qs.filter(q => q.changePct > 0).length;
        const l = qs.filter(q => q.changePct < 0).length;
        const live = qs.length > 0;
        this._gLbl.set_text(live ? String(g) : '—');
        this._lLbl.set_text(live ? String(l) : '—');
        // St.Widget has add/remove/has_style_class_name — no toggle
        // (GNOME 50 typelib dump proved it; calling one throws)
        for (const w of [this._gLbl, this._lLbl, this._sepLbl]) {
            if (live)
                w.remove_style_class_name('tg-dim');
            else
                w.add_style_class_name('tg-dim');
        }
        this._gTri.setDim(!live);
        this._lTri.setDim(!live);
    }

    /* hand a symbol to the desktop app: activate the first watchlist
     * (in the user's list order) that contains it, select it, then
     * launch — GApplication forwards the activate to a running
     * instance, so this focuses the window instead of doubling it.
     * The app watches both settings keys, so a running instance
     * re-points itself without a restart */
    _openInApp(sym) {
        const lists = parseWatchlists(this._settings.get_string('watchlists'));
        const wl = lists.find(w => (w.symbols ?? []).includes(sym));
        if (wl && this._settings.get_string('active-watchlist') !== wl.id)
            this._settings.set_string('active-watchlist', wl.id);
        this._settings.set_string('selected-symbol', sym);
        try {
            const info = Gio.AppInfo.get_all().find(
                a => a.get_id() === APP_DESKTOP_ID);
            if (info) {
                info.launch(null, null);
                return;
            }
        } catch (e) {
            logError(e, 'TickerGlass');
        }
        // no desktop entry (dev checkout?): ask gjs directly — a
        // secondary GApplication instance still wakes the primary
        Gio.Subprocess.new(
            ['gjs', '-m', GLib.build_filenamev([GLib.get_home_dir(),
                '.local', 'share', 'tickerglass', 'main.js'])],
            Gio.SubprocessFlags.NONE);
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
        for (const id of [this._timer, this._retryTimer])
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
