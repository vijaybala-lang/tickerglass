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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MarketClient} from './yahoo.js';
import {TickerPanel, Tri} from './menu.js';
import {initI18n, _} from './i18n.js';
import {parseWatchlists, fmtPct} from './fmt.js';
import {makeSnapshot, snapshotJSON, saveSnapshot,
        loadSnapshot} from './cache.js';

/* ── the D-Bus data plane ─────────────────────────────────────────────────
 * The shell is the only always-running member of this family, so it
 * SERVES the data: the app consumes quotes through this service instead
 * of burning its own Yahoo quota (single fetcher, single source of
 * truth). Deliberately a different bus name than the app's own
 * GApplication id — the app owns dev.vijaybala.TickerGlass when it
 * runs, and is merely a guest here. wrapJSObject/own_name/new_for_xml
 * probed present in this shell's Gio via gjs. */
const BUS_NAME = 'dev.vijaybala.TickerGlass.Data';
const BUS_PATH = '/dev/vijaybala/TickerGlass/Data';
const BUS_IFACE = Gio.DBusNodeInfo.new_for_xml(`
<node><interface name="${BUS_NAME}">
  <method name="GetSnapshot">
    <arg name="json" type="s" direction="out"/></method>
  <method name="Refresh"/>
  <signal name="Updated"><arg name="json" type="s"/></signal>
</interface></node>`).interfaces[0];

const APP_DESKTOP_ID = 'dev.vijaybala.TickerGlass.desktop';

/* Google's quote ids need an exchange tail — a bare ticker lands on a
 * generic page (title-probed: 'Google Finance' with no name). Shapes
 * that resolve live:
 *   stocks/ETFs  CRWD:NASDAQ, SPY:NYSEARCA (tail from the quote's own
 *                                            exchange field)
 *   indices      .INX:INDEXSP family — only the four title-verified
 *   crypto       BTC-USD bare (title-verified)
 *   forex        EURUSD=X arrives as EUR-USD (title-verified)
 * Anything we cannot guarantee (^NDX, ^VIX, unknown exchanges)
 * returns '' and the caller falls back to Yahoo — the right quote on
 * Yahoo beats a generic Google page. */
const GOOGLE_INDEX = {
    '^GSPC': '.INX:INDEXSP',
    '^IXIC': '.IXIC:INDEXNASDAQ',
    '^DJI': '.DJI:INDEXDJX',
    '^RUT': 'RUT:INDEXRUSSELL',
};
/* Yahoo's fullExchangeName (chart meta), Nasdaq API exchange
 * ('NASDAQ-GS'), and screener codes — all normalized (strip
 * non-alphanumerics, upper) — to Google's exchange names */
const GOOGLE_EXCH = {
    NASDAQGS: 'NASDAQ', NASDAQGM: 'NASDAQ', NASDAQCM: 'NASDAQ',
    NASDAQ: 'NASDAQ', NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ',
    NYSE: 'NYSE', NYQ: 'NYSE', NYSEC: 'NYSE', NYSES: 'NYSE',
    NYSEARCA: 'NYSEARCA', PCX: 'NYSEARCA', ARCA: 'NYSEARCA',
    PSE: 'NYSEARCA',            // the Nasdaq API's label for Arca-listed
                                // ETFs (SPY probe) — same exchange now
    NYSEAM: 'NYSEAMERICAN', NYSEAMERICAN: 'NYSEAMERICAN',
    NYSEMK: 'NYSEAMERICAN', ASE: 'NYSEAMERICAN',
};
function googleQuote(sym, exchange) {
    const up = sym.toUpperCase();
    if (up.endsWith('=X')) {
        const pair = up.slice(0, -2);
        return /^[A-Z]{6}$/.test(pair)
            ? `${pair.slice(0, 3)}-${pair.slice(3)}` : '';
    }
    if (GOOGLE_INDEX[up])
        return GOOGLE_INDEX[up];
    if (/^[A-Z0-9.]{2,6}-[A-Z]{3}$/.test(up))
        return up;                       // crypto
    const g = GOOGLE_EXCH[(exchange || '').toUpperCase()
        .replace(/[^A-Z0-9]/g, '')];
    if (g && /^[A-Z][A-Z0-9.$-]{0,9}$/.test(up))
        return `${up}:${g}`;
    return '';
}

/* Top-bar index dials (the optional face-lift of the ▲▼ counts): the
 * three big gauges ride the same round and the same quote pool, yet
 * belong to no watchlist — _state(), the counts, and the app-facing
 * snapshot all measure _symbols() (owners only), so a dial never
 * ranks as a 'top gainer' nor leaks into the app */
const INDEX_DIALS = [
    {sym: '^GSPC', name: 'S&P'},
    {sym: '^DJI', name: 'Dow'},
    {sym: '^IXIC', name: 'Nasdaq'},
];

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
        this._atWall = 0;
        this._dbus = null; this._busNameId = 0;

        this._dark = _interfaceIsDark();

        // the panel is a scoreboard: the app's own triangle asset in
        // green and red, each followed by how many of the active
        // watchlist's symbols are up / down — same quotes the dropdown
        // shows, zero extra network
        this._box = new St.BoxLayout({style_class: 'tg-panel-box',
                                      y_align: Clutter.ActorAlign.CENTER});
        if (!this._dark)
            this._box.add_style_class_name('tg-light-bar');
        this._gTri = new Tri(true);
        this._lTri = new Tri(false);
        this._gTri.setDim(true);
        this._lTri.setDim(true);
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
        // index dials (panel-display 'indices'): three name+pct cells,
        // swapped in for the ▲▼ counts at render time; names are as
        // long-lived as the session, translated once here
        this._dialBox = new St.BoxLayout({style_class: 'tg-dialbox',
                                         visible: false,
                                         y_align: Clutter.ActorAlign.CENTER});
        this._dialCells = INDEX_DIALS.map(d => {
            const cell = new St.BoxLayout({spacing: 3,
                y_align: Clutter.ActorAlign.CENTER});
            cell.add_child(new St.Label({style_class: 'tg-dial-name',
                text: _(d.name), y_align: Clutter.ActorAlign.CENTER}));
            const val = new St.Label({style_class: 'tg-dial-val tg-dim',
                text: '—', y_align: Clutter.ActorAlign.CENTER});
            cell.add_child(val);
            this._dialBox.add_child(cell);
            return {sym: d.sym, val};
        });
        this._box.add_child(this._dialBox);
        this.add_child(this._box);

        // dropdown card
        this._panel = new TickerPanel({
            dark: this._dark,
            onRefresh: () => this._fetch(true),
            twoCol: this._settings.get_boolean('menu-two-column'),
        });
        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(this._panel.actor);
        this.menu.addMenuItem(section);
        // a mover row is a jump-off: what "jump" means is the user's
        // call (ticker-target: the app, Yahoo, Google, or auto); the
        // app path also re-points the first watchlist containing the
        // ticker; the footer button stays the explicit app launch
        this._panel.onOpenSym = sym => this._openSymbol(sym);
        this._panel.onOpenApp = () => this._launchApp();
        // prefs must open AFTER the popup releases its grab (menu.js
        // calls this before onOpenPrefs) — close now. GNOME 50 law:
        // openPreferences lives on the JS Extension instance (the one
        // enable() receives, kept as this._ext), NOT on what
        // extensionManager.lookup() returns — that's the C wrapper now
        this._panel.onCloseMenu = () => this.menu.close(true);
        this._panel.onOpenPrefs = () => this._ext.openPreferences();
        this.menu.actor.add_style_class_name('tg-menu');
        // zero the popup wrappers' chrome — but start ABOVE the panel
        // actor: .tg-content keeps its own CSS padding (4px side gut)
        for (let a = this._panel.actor.get_parent(); a; a = a.get_parent()) {
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
            } else {
                this._restartTimer();
            }
        });
        this._settingsId = this._settings.connect('changed',
            (s, key) => this._onSetting(key));

        // WeatherGlass law: ink follows the desktop's light/dark world
        // live — a theme flip mid-session repaints the card and the
        // bar scoreboard, no logout required
        this._ifaceSettings = new Gio.Settings(
            {schema_id: 'org.gnome.desktop.interface'});
        this._ifaceId = this._ifaceSettings.connect('changed',
            () => this._onIfaceChange());

        // warm boot from the disk snapshot: paint whatever the last
        // round left (the app's or ours), then let the normal schedule
        // refresh it — a fresh login never sees an empty card
        const snap = loadSnapshot();
        if (snap) {
            this._quotes = snap.quotes;
            this._atWall = snap.at;
            this._renderPanel();
            this._panel.render(this._state());
        }
        this._serveData();
        this._fetch(true);
        this._restartTimer();
    }

    /* ── data ─────────────────────────────────────────────────────────── */

    /* movers and the scoreboard span the WHOLE portfolio — every
     * watchlist deduped, the active list's symbols first so a
     * same-symbol tie keeps its home ordering. (Was: active list only,
     * which made the board read as that watchlist's rank file rather
     * than the day's movers across everything owned) */
    _symbols() {
        const lists = parseWatchlists(this._settings.get_string('watchlists'));
        const id = this._settings.get_string('active-watchlist');
        const i = lists.findIndex(w => w.id === id);
        const order = i >= 0 ? [lists[i], ...lists.filter((_, j) => j !== i)]
                             : lists;
        const seen = new Set();
        const out = [];
        for (const wl of order)
            for (const s of wl.symbols ?? [])
                if (!seen.has(s)) {
                    seen.add(s);
                    out.push(s);
                }
        return out;
    }

    /* the dials join the fetch round (no watchlist owns them), yet
     * everything that measures 'held' keeps using _symbols() — so
     * movers, counts and the app-facing snapshot never meet a dial.
     * A user who watchlists ^GSPC owns it outright: no extra, and the
     * dial shares their quote */
    _dialExtras(syms) {
        if (this._settings.get_string('panel-display') !== 'indices')
            return [];
        return INDEX_DIALS.map(d => d.sym)
                          .filter(s => !syms.includes(s));
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
        const syms = this._symbols();
        // the cache may have been written by the APP, whose rounds can
        // carry a previewed symbol the user never watchlisted — the
        // board shows owned names only
        return {
            quotes: this._quotes.filter(q => syms.includes(q.symbol)),
            symbols: syms,
            hero: this._heroSymbol(),
            watchlists: parseWatchlists(this._settings.get_string('watchlists')),
            active: this._settings.get_string('active-watchlist'),
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
        const roundSyms = symbols.concat(this._dialExtras(symbols));
        if (!roundSyms.length) {
            this._quotes = [];
            this._error = 'empty';
            this._renderPanel();
            this._panel.render(this._state());
            return;
        }
        this._busy = true;
        this._panel?.setBusy(true);   // header shows the spinner
        const sparkRange = this._settings.get_string('panel-spark-range');
        this._client.quotes(roundSyms, {sparkRange})
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
                this._panel?.setBusy(false);
                // disk for cold boots, D-Bus push for the live app —
                // one snapshot shape, two delivery paths (cache.js).
                // Owners only: the dials are this bar's business, not
                // the app's scoreboard's
                const round = makeSnapshot(
                    this._settings.get_string('data-source'),
                    res.quotes.filter(q => symbols.includes(q.symbol)),
                    this._atWall);
                saveSnapshot(round);
                const js = snapshotJSON(round);
                if (js)
                    try {
                        this._dbus?.emit_signal('Updated',
                            new GLib.Variant('(s)', [js]));
                    } catch { /* bus hiccup; disk copy stands */ }
                this._renderPanel();
                this._panel.render(this._state());
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
                this._panel?.setBusy(false);
                this._renderPanel();
                this._panel.render(this._state());
                this._restartTimer();
            });
    }

    /* ── the D-Bus provider ─────────────────────────────────────────────
     * Serve what the fetch loop already holds: GetSnapshot answers a
     * cold app, the Updated signal streams live rounds, Refresh lets
     * the app's own refresh button reuse this poller instead of
     * double-tapping Yahoo. All three ride memory + the bus: zero
     * extra network when the app is open. */
    _snapshotJSON() {
        return snapshotJSON(makeSnapshot(
            this._settings.get_string('data-source'),
            this._quotes, this._atWall)) ?? '{"v":1}';
    }

    _serveData() {
        try {
            this._dbus = Gio.DBusExportedObject.wrapJSObject(BUS_IFACE, {
                GetSnapshot: () => this._snapshotJSON(),
                Refresh: () => { this._fetch(true); },
            });
            this._dbus.export(Gio.DBus.session, BUS_PATH);
            this._busNameId = Gio.DBus.session.own_name(
                BUS_NAME, Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
                null, () => { this._busNameId = 0; });
        } catch (e) {
            // app-side detection is by bus-name presence: on failure
            // it simply keeps polling itself, exactly as before
            logError(e, 'TickerGlass provider');
        }
    }

    _stopServing() {
        try {
            // THIS build's binding takes NO arguments (introspection
            // gap — live-bus probe: 2-arg call warns and no-ops, 0-arg
            // truly detaches: calls afterwards answer UnknownObject)
            this._dbus?.unexport();
        } catch { /* already gone */ }
        try {
            // g_bus_unown_name has no introspected twin in GJS — the
            // name releases cleanly straight off the daemon interface
            if (this._busNameId)
                Gio.DBus.session.call_sync('org.freedesktop.DBus',
                    '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                    'ReleaseName', new GLib.Variant('(s)', [BUS_NAME]),
                    new GLib.VariantType('(u)'),
                    Gio.DBusCallFlags.NONE, 200, null);
        } catch { /* the bus daemon will hand it out on disconnect */ }
        this._dbus = null;
        this._busNameId = 0;
    }

    /* ── the scoreboard: watchlist breadth ───────────────────────────────
     * The quote round that feeds the dropdown IS the feed: one label
     * counts symbols up on the day, the other counts them down. Flat
     * (0.00%) names are counted by neither; before the first round the
     * counters rest as dim dashes */

    _renderPanel() {
        const dialMode =
            this._settings.get_string('panel-display') === 'indices';
        if (dialMode) {
            for (const w of [this._gTri, this._gLbl, this._sepLbl,
                             this._lTri, this._lLbl])
                w.visible = false;
            this._dialBox.visible = true;
            this._renderDials();
            return;
        }
        for (const w of [this._gTri, this._gLbl, this._sepLbl,
                         this._lTri, this._lLbl])
            w.visible = true;
        this._dialBox.visible = false;
        const syms = this._symbols();
        const qs = this._quotes.filter(q => syms.includes(q.symbol) &&
                                            q.changePct != null);
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

    /* one em-dash until the round that carries the gauges arrives */
    _renderDials() {
        for (const d of this._dialCells) {
            const q = this._quotes.find(x => x.symbol === d.sym);
            const p = q?.changePct;
            d.val.set_text(p == null ? '—' : fmtPct(p));
            for (const c of ['tg-dial-up', 'tg-dial-down', 'tg-dim'])
                d.val.remove_style_class_name(c);
            // zero (or no quote) reads neutral grey like the counts' '—'
            d.val.add_style_class_name(p > 0 ? 'tg-dial-up'
                                    : p < 0 ? 'tg-dial-down' : 'tg-dim');
        }
    }

    /* the two worlds of "open the app": plain launch, or first point
     * the window at the first watchlist (in the user's list order)
     * containing a symbol. GApplication forwards the activate to a
     * running instance, so this focuses the window instead of doubling
     * it; the app watches both settings keys, so a running instance
     * re-points itself without a restart */
    /**
     * Click-policy seam. 'auto' (the default) is the no-config path:
     * TickerGlass if its desktop entry is found, else the Yahoo quote
     * in the browser. The ticker-target pref overrides to a fixed
     * destination. Web targets hand off to the default browser via
     * gio — no shell-side window, and it survives the app being
     * uninstalled (the point of the feature).
     */
    _openSymbol(sym) {
        const t = this._settings.get_string('ticker-target');
        const app = t === 'app' || (t === 'auto' && this._appInstalled());
        if (app) {
            this._openInApp(sym);
            return;
        }
        const q = this._quotes.find(x => x.symbol === sym);
        const code = t === 'google' ? googleQuote(sym, q?.exchange) : '';
        const url = code
            ? `https://www.google.com/finance/quote/${code}`
            : `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`;
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            logError(e, 'TickerGlass');
            this._openInApp(sym);     // never dead-end a click
        }
    }

    _appInstalled() {
        try {
            return Gio.AppInfo.get_all().some(
                a => a.get_id() === APP_DESKTOP_ID);
        } catch (e) {
            logError(e, 'TickerGlass');
            return false;
        }
    }

    _openInApp(sym) {
        const lists = parseWatchlists(this._settings.get_string('watchlists'));
        const wl = lists.find(w => (w.symbols ?? []).includes(sym));
        if (wl && this._settings.get_string('active-watchlist') !== wl.id)
            this._settings.set_string('active-watchlist', wl.id);
        this._settings.set_string('selected-symbol', sym);
        this._launchApp();
    }

    _launchApp() {
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

    /* ── timers & settings ────────────────────────────────────────────── */

    _restartTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        // a quote's market is "live" if it's in any trading session.
        // crypto/FX report REGULAR 24/7, so a mixed board keeps polling
        // overnight (those prices DO move); a pure-equity board goes
        // CLOSED at 4pm and throttles hard — the point of this method
        const live = this._quotes.some(q =>
            q.state === 'REGULAR' || q.state === 'PRE' || q.state === 'POST');
        let secs = this._settings.get_int('refresh-seconds');
        if (this.menu.isOpen)
            secs = Math.min(secs, 15);          // actively reading
        else if (this._quotes.length && !live)
            secs = Math.max(secs, 1800);        // closed: check back rarely
        else if (this._quotes.length && !this._quotes.some(
                q => q.state === 'REGULAR'))
            // purely after-hours (pre/post only): the board shows the
            // extended session but nobody day-trades 5 am — 5 min floor
            secs = Math.max(secs, 300);
        // battery: stretch the background waits ×4 (capped at 1 h).
        // Menu-open keeps the 15 s beat — the user is looking. Asked
        // once per timer beat via UPower, 200 ms cap so a dead daemon
        // never blocks the shell; no UPower (desktop) → false
        else if (secs < 900 && this._onBattery())
            secs = Math.min(secs * 4, 3600);
        // else: session (incl. after-hours, which we display) → user interval
        // opening the menu always forces a fresh fetch regardless
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, secs, () => {
            this._timer = 0;
            this._fetch(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBattery() {
        try {
            const [, v] = Gio.DBus.session.call_sync(
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice',
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)',
                    ['org.freedesktop.UPower.Device', 'OnBattery']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, 200, null);
            return v.unpack() === true;
        } catch {
            return false;      // desktop, dead daemon, or bus noise
        }
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
            break;
        case 'data-source':
            this._client.setSource(this._settings.get_string('data-source'));
            this._fetch(true);
            break;
        case 'panel-spark-range':
            this._fetch(true);       // the dropdown rows' sparks change
            break;
        case 'panel-display':
            // one face swaps for the other, and the fetch roster
            // changes with it — the bar repaints now, the gauges fill
            // in on the round that arrives
            this._renderPanel();
            this._fetch(true);
            break;
        case 'menu-two-column':
            this._panel.setTwoCol(this._settings.get_boolean('menu-two-column'));
            this._panel.render(this._state());
            break;
        case 'refresh-seconds':
            this._restartTimer();
            break;
        }
    }

    /* ink follows the desktop world (WeatherGlass law): card AND the
     * bar scoreboard flip together when the world flips */
    _onIfaceChange() {
        const dark = _interfaceIsDark();
        if (dark === this._dark)
            return;
        this._dark = dark;
        this._panel.setDark(dark);
        if (dark)
            this._box.remove_style_class_name('tg-light-bar');
        else
            this._box.add_style_class_name('tg-light-bar');
    }

    destroy() {
        this._dead = true;
        this._stopServing();
        for (const id of [this._timer, this._retryTimer])
            if (id)
                GLib.source_remove(id);
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        if (this._ifaceId)
            this._ifaceSettings.disconnect(this._ifaceId);
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
