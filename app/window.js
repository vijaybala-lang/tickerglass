/* window.js — the whole TickerGlass app UI.
 * Layout: OverlaySplitView(sidebar(watchlist dropdown + sparkline rows) |
 * toast overlay(headerbar + ViewStack(chart page: hero + cairo chart +
 * ranges + news | table page: sortable list table))).
 * Everything is driven by the shared gsettings schema; Yahoo/demo comes
 * through the shared MarketClient. */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw';
import Cairo from 'gi://cairo';

import {MarketClient} from './yahoo.js';
import {paintChart, paintMiniSpark} from './spark.js';
import {textPrompt} from './prompt.js';
import {DataFetcher} from './fetch.js';

/* width (px) of the swipe-revealed delete button */
const TG_DEL_W = 44;
import {parseWatchlists, stringifyWatchlists, fmtPrice, fmtDelta, fmtPct,
        fmtCompact, fmtTime, axisDate, symbolShort, RANGES, RANGE_LABEL,
        INTERVALS, INTERVAL_LABEL, intervalFor} from './fmt.js';

/* ── news source icons: fetch /favicon.ico once per host (Soup lives in
 *    yahoo.js's world, so a dynamic import keeps it off the UI's cold
 *    path). A cairo letter-avatar paints instantly and survives fetch
 *    failure; every row of the host redraws when the real icon lands ─── */
const FAV = new Map();        // host -> GdkPixbuf.Pixbuf | null
const FAV_WAIT = new Map();   // host -> [waiting DrawingAreas]

function hostOf(url) {
    try {
        return GLib.Uri.parse(url ?? '', GLib.UriFlags.NONE)?.get_host()
            ?? '';
    } catch {
        return '';
    }
}

function favFetch(host) {
    if (!host || FAV.has(host) || FAV_WAIT.has(host))
        return;
    FAV_WAIT.set(host, []);
    (async () => {
        try {
            const { default: Soup } = await import('gi://Soup?version=3.0');
            const sess = new Soup.Session({ timeout: 8 });
            const msg = Soup.Message.new('GET', `https://${host}/favicon.ico`);
            const bytes = await new Promise((res, rej) =>
                sess.send_and_read_async(
                    msg, GLib.PRIORITY_LOW, null, (s, r) => {
                        try {
                            res(s.send_and_read_finish(r));
                        } catch (e) {
                            rej(e);
                        }
                    }));
            const st = new Gio.MemoryInputStream.new_from_bytes(bytes);
            const pb = await new Promise((res, rej) =>
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                    st, 36, 36, true, null, (s, r) => {
                        try {
                            res(GdkPixbuf.Pixbuf.new_from_stream_finish(r));
                        } catch (e) {
                            rej(e);
                        }
                    }));
            FAV.set(host, pb);
        } catch {
            FAV.set(host, null);   // letter avatar stays for good
        }
        for (const w of FAV_WAIT.get(host) ?? [])
            w.queue_draw();
        FAV_WAIT.delete(host);
    })();
}

function favAttach(w) {
    if (!w._host)
        return;
    if (!FAV.has(w._host) && !FAV_WAIT.has(w._host))
        favFetch(w._host);          // registers the waiter list synchronously
    FAV_WAIT.get(w._host)?.push(w);
}

function hsl2rgb(h, s, l) {
    const f = n => {
        const k = (n + h * 12) % 12;
        return l - s * Math.min(l, 1 - l) *
            Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
}

function paintFav(w, cr, ww, hh) {
    const pb = w._host ? FAV.get(w._host) : null;
    if (pb) {
        Gdk.cairo_set_source_pixbuf(
            cr, pb, (ww - pb.width) / 2, (hh - pb.height) / 2);
        cr.paint();
        return;
    }
    // letter avatar: hue stable per host (same site = same color)
    let h = 0;
    for (const c of (w._host || w._letter || '?'))
        h = (h * 31 + c.charCodeAt(0)) % 360;
    const [R, G, B] = hsl2rgb(h / 360, 0.5, 0.45);
    cr.arc(ww / 2, hh / 2, Math.min(ww, hh) / 2 - 1, 0, 2 * Math.PI);
    cr.setSourceRGB(R, G, B);
    cr.fill();
    cr.selectFontFace('Sans', Cairo.FontWeight.BOLD, Cairo.FontSlant.NORMAL);
    cr.setFontSize(hh * 0.55);
    // gi://cairo exposes neither the textExtents callback form nor a
    // TextExtents boxed constructor — approximate metrics from the font
    // size (advance ≈ 0.65em, cap ≈ 0.7em); centering one letter is
    // forgiving and the whole avatar is 20px anyway
    cr.moveTo(ww / 2 - hh * 0.18, hh / 2 + hh * 0.19);
    cr.setSourceRGB(1, 1, 1);
    cr.showText(w._letter);
}

/* ── table row model: one plain JS object per quote, camelCase fields —
 *    display strings for the cells + raw numbers for JS-side sorting ──── */
export class QuoteItem {
    constructor(q) {
        const num = v => Number.isFinite(v) ? v : 0;
        Object.assign(this, {
            sym: q.symbol,
            name: q.name ?? '',
            priceS: q.price != null ? fmtPrice(q.price, q.currency) : '—',
            priceN: num(q.price),
            changeS: q.change != null ? fmtDelta(q.change, q.currency) : '—',
            changeN: num(q.change),
            pctS: q.changePct != null ? fmtPct(q.changePct) : '—',
            pctN: num(q.changePct),
            dayS: q.dayLow != null && q.dayHigh != null
                ? `${fmtPrice(q.dayLow, q.currency)} – ${fmtPrice(q.dayHigh, q.currency)}`
                : '—',
            weekS: q.wk52Low != null && q.wk52High != null
                ? `${fmtCompact(q.wk52Low)} – ${fmtCompact(q.wk52High)}`
                : '—',
            volS: q.volume != null ? fmtCompact(q.volume) : '—',
            volN: num(q.volume),
            exchS: q.exchange ?? '',
            curS: q.currency ?? '',
            updS: q.marketTime ? fmtTime(q.marketTime, q.tz ?? 'UTC') : '',
            up: (q.change ?? 0) >= 0,
            stateS: q.state ?? '',
        });
    }
}

/* content-area box that whispers every snapshot. GtkWidget::snapshot
 * is a vfunc (no signal), and it is the ONLY post-allocation callback
 * that survives in GTK 4.22: notify::width never fires, map runs
 * BEFORE the first allocation, resize is gone. Draws imply an
 * allocation, so this covers boot and every window resize — the
 * sidebar's px->fraction translation hangs on it */
const SnapshotBox = GObject.registerClass(
class SnapshotBox extends Gtk.Box {
    vfunc_snapshot(snapshot) {
        this._onSnapshot?.();
        super.vfunc_snapshot(snapshot);
    }
});

/* ── column registry ────────────────────────────────────────────────────── */
const COLS = [
    {key: 'symbol',  title: 'Symbol',  prop: 'sym',      numeric: false},
    {key: 'name',    title: 'Name',    prop: 'name',     numeric: false, min: 140},
    {key: 'price',   title: 'Price',   prop: 'price-s',  sort: 'price-n',  numeric: true},
    {key: 'change',  title: 'Change',  prop: 'change-s', sort: 'change-n', numeric: true, color: true},
    {key: 'pct',     title: 'Change %',prop: 'pct-s',    sort: 'pct-n',    numeric: true, color: true},
    {key: 'day-range', title: 'Day Range', prop: 'day-s', sort: 'price-n', numeric: true, min: 130},
    {key: 'week52',  title: '52 Weeks',prop: 'week-s',   numeric: true, min: 130},
    {key: 'volume',  title: 'Volume',  prop: 'vol-s',    sort: 'vol-n',    numeric: true},
    {key: 'exchange',title: 'Exchange',prop: 'exch-s',   numeric: false, min: 110},
    {key: 'currency',title: 'Currency',prop: 'cur-s',    numeric: false},
    {key: 'updated', title: 'At',      prop: 'upd-s',    numeric: true},
];

const INTRADAY = new Set(['1d', '5d']);

/* status-line display name per data-source setting value */
const SOURCE_LABEL = {
    yahoo: 'Yahoo Finance', 'yahoo-relay': 'Yahoo Finance',
    nasdaq: 'Nasdaq', demo: 'Demo feed',
};
function sourceLabel(id) {
    return SOURCE_LABEL[id] ?? 'Yahoo Finance';
}

/* gjs exposes hyphenated GObject props camelCased: 'price-n' → .priceN */
const camel = p => p.replace(/-(\w)/g, (m, c) => c.toUpperCase());

/* settings column key → QuoteItem property used for JS-side sorting */
const SORT_PROP = {
    'symbol': 'sym', 'name': 'name', price: 'price-n', change: 'change-n',
    pct: 'pct-n', 'day-range': 'day-s', week52: 'week-s', volume: 'vol-n',
    'exchange': 'exch-s', 'currency': 'cur-s', updated: 'upd-s',
};

export const TickerWindow = GObject.registerClass(
class TickerWindow extends Adw.ApplicationWindow {
    constructor(app) {
        super({application: app, default_width: 1180, default_height: 760});

        this._settings = new Gio.Settings(
            {schema_id: 'org.gnome.shell.extensions.tickerglass'});
        this._client = new MarketClient(this._settings.get_string('data-source'));
        // one data-fetch layer for every surface: quote rounds, chart
        // history, movers screener — in-flight dedup + TTL cache live
        // here, not in per-call-site fields
        this._fetcher = new DataFetcher();
        this._hist = null;
        this._quotes = [];
        this._launcher = new Gtk.UriLauncher();
        this._progress = 1;
        this._cursor = null;
        this._busy = false;
        this._dead = false;

        this._buildActions();
        const root = this._buildUi();
        this.set_content(root);

        this._styleManager = Adw.StyleManager.get_default();
        this._applyTheme(this._settings.get_string('app-theme'));
        this._settings.connect('changed', (s, k) => this._onSetting(k));
        this._settings.connect('changed::app-theme',
            s => this._applyTheme(s.get_string('app-theme')));

        this._rebuildTable();
        this._rebuildSidebar();
        this._t0 = GLib.get_monotonic_time() / 1e6;   // TG_TIMING anchor
        this._refresh();
        // chart and news don't need the quote round: fire them in
        // parallel so the hero paints while the slowest quote leg is
        // still in flight (_histKey dedups against the quotes hook)
        if (this._hero()) {
            this._loadHistory();
            this._newsFor = this._hero();
            this._loadNews(this._hero());
        }
        this._restartTimer();
        // TG_VIEW=table|chart|movers forces the initial view (dev/testing hook)
        const view0 = GLib.getenv('TG_VIEW');
        if (['table', 'chart', 'movers'].includes(view0))
            this._stack.set_visible_child_name(view0);
        // TG_READER_URL opens the news reader at startup (dev/testing hook)
        const reader0 = GLib.getenv('TG_READER_URL');
        if (reader0)
            this._openReader(reader0, 'Reader smoke test');
        // TG_SEARCH=aapl types into the inline search box and picks the
        // top result — via a synthesized row click when TG_CLICK is set,
        // else via Enter — exercising the full preview paths without a
        // physical keyboard (dev/testing hook)
        const search0 = GLib.getenv('TG_SEARCH');
        const useClick = GLib.getenv('TG_CLICK');
        if (search0)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                log(`TickerGlass: TG_SEARCH typing (${search0}, ` +
                    `click-mode=${useClick ? 'y' : 'n'})`);
                const e = this._searchEntry;
                e.grab_focus();
                e.set_text(search0);
                e.emit('search-changed');   // set_text doesn't fire it
                const t0 = GLib.get_monotonic_time();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    if (e._hasResults() ||
                        GLib.get_monotonic_time() - t0 > 25e6) {
                        if (useClick)
                            e._clickFirst();
                        else
                            e._submit();
                        return GLib.SOURCE_REMOVE;   // pick once
                    }
                    return GLib.SOURCE_CONTINUE;
                });
                return GLib.SOURCE_REMOVE;
            });
        // TG_ADD: follow the TG_SEARCH pick with a watchlist add and
        // sample the hero labels over time — objective blank-detection
        if (search0 && GLib.getenv('TG_ADD'))
            GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                             Number(GLib.getenv('TG_ADD')) || 5200,
                             () => {
                const hero = () => `${this._heroName.get_label()}|` +
                    `${this._heroSym.get_label()}|` +
                    `${this._heroPrice.get_label()}`;
                log(`TG_ADD before=<<${hero()}>>`);
                this._addSymbol(this._hero());
                for (const ms of [50, 300, 1000, 2000, 3500, 5500])
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                        if (this._dead)
                            return GLib.SOURCE_REMOVE;
                        log(`TG_ADD +${ms}ms hero=<<${hero()}>> ` +
                            `pq=${!!this._previewQ} ` +
                            `quotes=${this._quotes.length}`);
                        return GLib.SOURCE_REMOVE;
                    });
                return GLib.SOURCE_REMOVE;
            });
        // TG_KEYTEST: types through REAL key events (Gtk.Test), which
        // traverses the full input pipeline including window
        // accelerators — set_text() cannot catch swallowed characters
        if (GLib.getenv('TG_KEYTEST'))
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                const e = this._searchEntry;
                e.grab_focus();
                try {
                    Gtk.Test.enter_text(e, 'zbra');
                } catch (err) {
                    log(`TG_KEYTEST enter failed: ${err}`);
                }
                log(`TG_KEYTEST typed=zbra result=<<${e.get_text()}>>`);
                this.get_application().quit();
                return GLib.SOURCE_REMOVE;
            });
    }

    /* ── UI construction ──────────────────────────────────────────────── */

    _buildUi() {
        const hbar = new Adw.HeaderBar();
        // Adw.HeaderBar paints the window title centered when its title
        // slot is untouched — feed it an empty box to evict the app name
        hbar.title_widget = new Gtk.Box();
        this.set_title('TickerGlass');
        const sideBtn = new Gtk.ToggleButton({icon_name: 'sidebar-show-symbolic',
                                              tooltip_text: 'Watchlists (F9)'});
        hbar.pack_start(sideBtn);
        this._readTitle = new Gtk.Label({
            label: '', ellipsize: 3, max_width_chars: 45,
            valign: Gtk.Align.CENTER, css_classes: ['tg-read-title'],
        });
        this._readTitle.set_visible(false);
        const menuBtn = this._menuBtn();
        hbar.pack_end(menuBtn);
        // inline header search with an autocomplete popover: type, see
        // candidates drop down, click to preview — never leaves the page
        const search = new Gtk.SearchEntry({
            placeholder_text: 'Search symbol or company  ( / )',
            width_chars: 22, max_width_chars: 30, valign: Gtk.Align.CENTER,
        });
        hbar.pack_end(search);
        this._searchEntry = search;
        this._buildSearchPopover(search);
        // page navigation right beside the search: Watchlist ↔ Movers.
        // Icon + label nav (.tg-tab): the movers glyph is the app's
        // own up/down triangle pair, shipped as a symbolic next to
        // the code so it recolors like stock icons — the adwaita set
        // has no up+down arrow (probe-verified). Label to the RIGHT:
        // the header is a fixed-height horizontal bar; labels under
        // icons would force a taller bar or microscopic text.
        try {
            // GTK4 on this build resolves a search path that points AT
            // the context dir (…/hicolor/scalable/actions) — probe-
            // verified: the hicolor and scalable parents come up false
            const idir = Gio.File.new_for_uri(import.meta.url)
                .get_parent().get_child('icons')
                .get_child('hicolor').get_child('scalable')
                .get_child('actions').get_path();
            Gtk.IconTheme.get_for_display(this.get_display())
                .add_search_path(idir, -1);
        } catch (e) {
            log(`icon path unavailable: ${e.message}`);
        }
        // one linked cluster, the same widget recipe as the sidebar's
        // [+ ☰ 🗑] bar: a .linked box of theme-default buttons — the
        // joined segmented look, not floating pills
        const navBox = new Gtk.Box({spacing: 0, valign: Gtk.Align.CENTER,
                                    css_classes: ['linked']});
        this._navChips = {};
        for (const [key, icon, name, tip, view] of [
                ['watch', 'starred-symbolic', 'Watchlist',
                 'Your symbols  ( Alt+1 )', 'chart'],
                ['movers', 'tg-movers-symbolic', 'Movers',
                 'Top movers — gainers & losers  ( Alt+2 )',
                 'movers']]) {
            const b = new Gtk.Button({css_classes: ['tg-tab'],
                                      tooltip_text: tip});
            const inner = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
            inner.append(new Gtk.Image({icon_name: icon}));
            inner.append(new Gtk.Label({label: name}));
            b.set_child(inner);
            b.connect('clicked', () =>
                this.activate_action('view', new GLib.Variant('s', view)));
            navBox.append(b);
            this._navChips[key] = b;
        }
        hbar.pack_end(navBox);
        this._navBox = navBox;
        if (GLib.getenv('TG_DEBUGKEYS')) {
            const mk = (name, wid) => {
                const kc = new Gtk.EventControllerKey();
                kc.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
                kc.connect('key-pressed', (c, kv, code, st) => {
                    log(`TGKEY ${name} kv=${Gtk.keyval_name(kv)}`);
                    return false;
                });
                wid.add_controller(kc);
            };
            mk('win', this);
            mk('entry', search);
            search.connect('search-changed',
                () => log(`TGKEY text=<<${search.get_text()}>>`));
        }

        // reading mode replaces the ticker chrome entirely (back pill,
        // article title, open-externally) — toggled per visible page below
        this._readBack = new Gtk.Button({label: '← Back',
                                         valign: Gtk.Align.CENTER});
        this._readBack.add_css_class('tg-chip');
        this._readBack.connect('clicked', () => this._leaveReader());
        this._readBack.set_visible(false);
        hbar.pack_start(this._readBack);
        hbar.pack_start(this._readTitle);
        this._readExt = new Gtk.Button({icon_name: 'web-browser-symbolic',
                                        tooltip_text: 'Open in browser'});
        this._readExt.add_css_class('flat');
        this._readExt.connect('clicked', () =>
            this._openUrl(this._readerWeb?.get_uri()));
        this._readExt.set_visible(false);
        hbar.pack_end(this._readExt);

        /* —— content column —— */
        const content = new SnapshotBox({orientation: Gtk.Orientation.VERTICAL});
        content.append(hbar);

        // the window body stacks Chart (hero + chart + news), Table (the
        // sortable grid — now reached from the hamburger's View section)
        // and the full-bleed reader page

        // chart page
        const chartPage = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});

        // hero block
        this._heroBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                     margin_top: 10, margin_bottom: 2,
                                     margin_start: 18, margin_end: 18,
                                     spacing: 2});
        const heroTop = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                     spacing: 12});
        // ONE row holds the big text: name (40px) left, price + pct (34px)
        // right — same row means the shorter labels sit optically centered
        // against the NAME alone; the symbol badge gets its own line below
        this._heroName = new Gtk.Label({
            label: '', css_classes: ['tg-hero-name'],
            ellipsize: 3, max_width_chars: 20,
            hexpand: true, xalign: 0,
        });
        // price is the anchor, always shown; the pill beside it flips
        // between the dollar move and the percentage move on click
        // (persisted in gsettings as change-style)
        this._heroMode = this._settings.get_string('change-style')
            || 'dollars';
        this._heroPrice = new Gtk.Label({
            label: '', css_classes: ['tg-hero-price'],
        });
        // pill = shared chunky-triangle factory + text; hero gets the
        // big size, rows and table the compact one
        this._heroPill = new Gtk.Box({
            css_classes: ['tg-pill', 'tg-hero-pct'],
            spacing: 8,
            tooltip_text: 'Click to switch between $ and %',
        });
        this._heroTri = this._makeTri(20);
        this._heroPillLbl = new Gtk.Label({label: ''});
        this._heroPill.append(this._heroTri);
        this._heroPill.append(this._heroPillLbl);
        {
            const gc = new Gtk.GestureClick();
            gc.connect('pressed', () => this._flipHeroValue());
            this._heroPill.add_controller(gc);
            try {
                this._heroPill.set_cursor(
                    Gdk.Cursor.new_from_name('pointer', null));
            } catch (e) { /* cursor is polish */ }
        }
        this._heroSym = new Gtk.Label({
            label: '', css_classes: ['tg-win-sym'],
            halign: Gtk.Align.START,
        });
        heroTop.append(this._heroName);
        heroTop.append(this._heroPrice);
        heroTop.append(this._heroPill);
        // shown only while the hero is a search-preview not yet in the
        // list — rides the badge (chips) line, sized to sit beside the
        // range chips rather than shout over the price
        // THE SAME COMPONENT as the sidebar's bar: a .linked box of
        // plain theme-default buttons (+ a MenuButton for the caret)
        // — no custom css classes at all, same 24px metrics the
        // probe measured for sidebar/titlebar clusters
        this._addBtn = new Gtk.Box({css_classes: ['linked'],
                                    valign: Gtk.Align.CENTER});
        {
            const addMain = new Gtk.Button({valign: Gtk.Align.CENTER});
            {
                const inner = new Gtk.Box({spacing: 8});
                const addImg = new Gtk.Image(
                    {icon_name: 'list-add-symbolic'});
                addImg.set_pixel_size(14);
                inner.append(addImg);
                inner.append(new Gtk.Label({label: 'Add to List'}));
                addMain.set_child(inner);
            }
            addMain.set_focus_on_click(false);
            addMain.connect('clicked', () =>
                this._addSymbol(this._hero()));
            this._addMenuPop = new Gtk.Popover({autohide: true});
            this._addMenuPop.connect('show', () =>
                this._populateAddMenu());
            const addCaret = new Gtk.MenuButton({
                icon_name: 'pan-down-symbolic',
                popover: this._addMenuPop,
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Choose which list',
            });
            this._addBtn.append(addMain);
            this._addBtn.append(addCaret);
        }
        this._addBtn.set_visible(false);
        this._heroBox.append(heroTop);
        // badge line: directly under the name, left-flush; the add
        // button rides here beside the symbol badge — the commit button
        // for the very symbol it names
        {
            const symRow = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 10,
            });
            this._heroSym.set_valign(Gtk.Align.CENTER);
            symRow.append(this._heroSym);
            symRow.append(this._addBtn);
            // the row keeps the button's height even after the button
            // vanishes post-add, so the badges below never jump
            const nat = this._addBtn.measure(
                Gtk.Orientation.VERTICAL, -1)[1];
            if (nat > 12)
                symRow.set_size_request(-1, nat);
            this._heroBox.append(symRow);
        }
        this._chips = new Adw.WrapBox({line_spacing: 8, child_spacing: 8,
                                       hexpand: true,
                                       valign: Gtk.Align.CENTER});
        this._chips.set_margin_top(8);   // air between badge line + chips
        // the WrapBox rebuilds its children on every hero change
        // (renderChips), so nothing else may be parented inside it
        this._heroBox.append(this._chips);
        chartPage.append(this._heroBox);

        // chart
        this._chart = new Gtk.DrawingArea();
        this._chart.set_vexpand(true);
        this._chart.set_content_height(220);
        this._chart.set_margin_top(8);
        this._chart.add_css_class('tg-chart-area');
        this._chart.set_draw_func((area, cr, w, h) => {
            // During a sidebar resize the content shrinks every frame
            // and the chart would otherwise re-render (~4ms, spiking to
            // 23ms) ~40x/sec — the stutter. Paint a cheap background
            // while the drag is live and do ONE real render on release.
            if (this._resizing) {
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                return;
            }
            const t = GLib.getenv('TG_TIMING')
                ? GLib.get_monotonic_time() : 0;
            this._drawChart(cr, w, h);
            if (t)
                log(`TG chart paint: ${((GLib.get_monotonic_time()
                                      - t) / 1e3).toFixed(1)}ms`);
        });
        const hover = new Gtk.EventControllerMotion();
        hover.connect('motion', (c, x) => {
            this._cursor = {x};
            this._chart.queue_draw();
        });
        hover.connect('leave', () => {
            this._cursor = null;
            this._chart.queue_draw();
        });
        this._chart.add_controller(hover);
        chartPage.append(this._chart);

        // controls row: range chips + interval + style
        const controls = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                      margin_top: 4, margin_bottom: 4,
                                      margin_start: 18, margin_end: 18,
                                      spacing: 8});
        this._rangeChips = {};
        const chipBox = new Adw.WrapBox({line_spacing: 4, child_spacing: 4});
        for (const r of RANGES) {
            const b = new Gtk.Button({label: RANGE_LABEL[r],
                                      css_classes: ['tg-chip']});
            b.set_action_name('win.range');
            b.set_action_target_value(new GLib.Variant('s', r));
            b.set_tooltip_text(`Range ${r}`);
            chipBox.append(b);
            this._rangeChips[r] = b;
        }
        controls.append(chipBox);
        const ctlSpacer = new Gtk.Box();
        ctlSpacer.set_hexpand(true);
        controls.append(ctlSpacer);

        this._ivBtn = new Gtk.MenuButton();
        this._ivBtn.set_tooltip_text('Bar interval');
        this._ivBtn.set_menu_model(this._intervalMenu());
        this._ivBtn.set_label('Auto');
        this._ivBtn.add_css_class('flat');
        controls.append(this._ivBtn);

        // benchmark overlay picker: Off / SPY / QQQ / DIA / IWM / custom
        this._cmpBtn = new Gtk.MenuButton({label: 'vs Off',
                                           tooltip_text: 'Compare against'});
        this._cmpBtn.add_css_class('flat');
        {
            const m = new Gio.Menu();
            const sec = new Gio.Menu();
            sec.append('No comparison', 'win.cmp::off');
            sec.append('Custom symbol…', 'win.cmp::__custom');
            m.append_section(null, sec);
            const bench = new Gio.Menu();
            for (const s of ['SPY', 'QQQ', 'DIA', 'IWM', 'VIX'])
                bench.append(s === 'VIX' ? 'VIX (^VIX)' : s,
                             `win.cmp::${s === 'VIX' ? '^VIX' : s}`);
            m.append_section(null, bench);
            this._cmpBtn.set_menu_model(m);
        }
        controls.append(this._cmpBtn);

        this._styleBtn = new Gtk.MenuButton({label: 'Area',
                                             tooltip_text: 'Chart style'});
        this._styleBtn.add_css_class('flat');
        {
            const m = new Gio.Menu();
            const sec = new Gio.Menu();
            for (const [id, lbl] of [['area', 'Area'], ['line', 'Line'],
                                     ['candles', 'Candles']])
                sec.append(lbl, `win.style::${id}`);
            m.append_section(null, sec);
            this._styleBtn.set_menu_model(m);
        }
        controls.append(this._styleBtn);
        chartPage.append(controls);

        // news feed for the hero symbol
        const newsHead = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                      margin_start: 18, margin_top: 6,
                                      spacing: 8});
        newsHead.append(new Gtk.Label({label: 'News', css_classes: ['heading'],
                                       halign: Gtk.Align.START}));
        this._newsCount = new Gtk.Label({label: '', css_classes: ['dim-label', 'caption']});
        newsHead.append(this._newsCount);
        chartPage.append(newsHead);
        const newsScroll = new Gtk.ScrolledWindow({
            max_content_height: 230, propagate_natural_height: true,
            margin_start: 12, margin_end: 12, margin_top: 4, margin_bottom: 6,
        });
        newsScroll.add_css_class('card');
        this._newsList = new Gtk.ListBox({css_classes: ['tg-news-list']});
        this._newsList.add_css_class('flat');
        // no separators: the rows are pills now, the gaps between them
        // are the divider
        this._newsList.connect('row-activated', (l, row) => {
            if (row?._url)
                this._openReader(row._url, row._title);
        });
        newsScroll.set_child(this._newsList);
        this._newsEmpty = new Gtk.Label({label: '', css_classes: ['dim-label'],
                                         margin_top: 12, margin_bottom: 12});
        this._newsList.set_placeholder(this._newsEmpty);
        chartPage.append(newsScroll);

        /* table — a hand-rolled ListBox + header row. GtkColumnView's
         * introspection is unreliable across distros (its constructor even
         * aborts on some builds); the ListBox keeps sorting, column toggles
         * and the same gsettings contract running on every GTK 4. */
        const wrap = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                  margin_start: 12, margin_end: 12});
        this._thead = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                   css_classes: ['tg-thead'],
                                   margin_start: 10, margin_end: 10,
                                   margin_top: 4});
        wrap.append(this._thead);
        const scroller = new Gtk.ScrolledWindow({
            vexpand: true, min_content_height: 140,
        });
        scroller.add_css_class('card');
        this._scroller = scroller;
        this._tableList = new Gtk.ListBox();
        this._tableList.add_css_class('flat');
        this._tableList.set_selection_mode(Gtk.SelectionMode.SINGLE);
        this._tableList.connect('row-activated', (l, row) => {
            if (row?._sym)
                this._selectSymbol(row._sym);
        });
        const rightClick = new Gtk.GestureClick();
        rightClick.set_button(3);
        rightClick.connect('pressed', (g, nPress, x, y) => {
            const row = this._tableList.get_row_at_y(y);
            this._showRowMenu(row?._sym);
        });
        this._tableList.add_controller(rightClick);
        scroller.set_child(this._tableList);
        wrap.append(scroller);

        /* —— view stack + header toggles —— */
        const tablePage = wrap;

        /* —— movers: gains/losses dashboard off the SAME quotes map —
         * zero extra network; rebuilt on every table flush, and a row
         * click hands the symbol back to the chart view */
        const movWrap = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                     margin_start: 12, margin_end: 12,
                                     margin_top: 8, spacing: 2});
        // row 1: page title (+ the window picker riding at its right).
        // The picker lives HERE, not with the scope chips, so hiding or
        // disabling it can never slide the chips around: the title is
        // left-aligned and the spacer eats whatever space is vacated.
        const movTitleRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                         spacing: 8});
        // page title names the window the ranking actually used — and
        // speaks in the hero name's voice (40px, .tg-page-title)
        this._movTitle = new Gtk.Label({label: '', xalign: 0,
                                        css_classes: ['tg-page-title'],
                                        // 10 grid margin + 14 card padding
                                        // = aligned with tile text
                                        margin_start: 24,
                                        // row height is driven by this
                                        // 40px label; the picker centers
                                        // itself in it
                                        margin_bottom: 4});
        movTitleRow.append(this._movTitle);
        const tSpacer = new Gtk.Box();
        tSpacer.set_hexpand(true);
        movTitleRow.append(tSpacer);
        // sparkline window for the tiles + the table's spark column
        this._mvSparkBtn = new Gtk.MenuButton({label: 'Spark 1M',
            tooltip_text: 'Window for the movers ranking and mini-charts '
                        + '(Market scope is always today)',
            valign: Gtk.Align.CENTER});
        this._mvSparkBtn.add_css_class('flat');
        {
            const m = new Gio.Menu();
            const sec = new Gio.Menu();
            for (const [id, lbl] of [['1d', '1D'], ['5d', '1W'],
                                     ['1mo', '1M'], ['6mo', '6M']])
                sec.append(lbl, `win.spark::${id}`);
            m.append_section(null, sec);
            this._mvSparkBtn.set_menu_model(m);
        }
        movTitleRow.append(this._mvSparkBtn);
        movWrap.append(movTitleRow);
        // row 2: summary + scope chips — a constant geometry
        const movHeadRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                        spacing: 8});
        this._movSummary = new Gtk.Label({label: 'Waiting for quotes…',
                                          xalign: 0, hexpand: true,
                                          ellipsize: 3, margin_start: 24,
                                          css_classes: ['dim-label',
                                                        'caption']});
        movHeadRow.append(this._movSummary);
        // scope chips: rank my watchlist vs the whole US market
        this._mvScopeChips = {};
        for (const [val, lbl, tip] of [
                ['list', 'My list', 'Rank the active watchlist'],
                ['market', 'Market',
                 'Biggest movers across US equities']]) {
            const b = new Gtk.Button({label: lbl, tooltip_text: tip});
            b.add_css_class('tg-chip');
            b.connect('clicked', () =>
                this._settings.set_string('movers-scope', val));
            movHeadRow.append(b);
            this._mvScopeChips[val] = b;
        }
        movWrap.append(movHeadRow);
        this._updateSparkBtn();
        const movScroll = new Gtk.ScrolledWindow({
            vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER,
            margin_top: 4,
        });
        const movCol = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        movScroll.set_child(movCol);
        movWrap.append(movScroll);
        this._movHeads = {};
        this._movLists = {};
        this._movEmpties = {};
        for (const key of ['gain', 'lose']) {
            const head = new Gtk.Label({label: '', xalign: 0,
                                        css_classes: ['heading'],
                                        margin_start: 24, margin_top: 10,
                                        margin_bottom: 2});
            movCol.append(head);
            this._movHeads[key] = head;
            // responsive tile grid: wraps by width, no scrolling tricks
            const fb = new Gtk.FlowBox({
                homogeneous: true, column_spacing: 10, row_spacing: 10,
                margin_start: 10, margin_end: 10, margin_top: 4,
                css_classes: ['tg-tilegrid'],
            });
            // explicit call, not just the construct property: a stray
            // selection is exactly the CSCO-only halo in the screenshot
            fb.set_selection_mode(Gtk.SelectionMode.NONE);
            fb.connect('child-activated', (box, child) => {
                const tile = child.get_child();
                if (!tile?._sym)
                    return;
                // market movers are outsiders: _showSymbol previews
                // them like a search pick; watchlist tiles pass through
                this._showSymbol(tile._sym, {name: tile._name ?? ''});
            });
            movCol.append(fb);
            this._movLists[key] = fb;
            const empty = new Gtk.Label({label: '', css_classes: ['dim-label'],
                                         margin_start: 24,
                                         margin_top: 8, margin_bottom: 8});
            empty.set_visible(false);
            movCol.append(empty);
            this._movEmpties[key] = empty;
        }
        const moversPage = movWrap;

        this._stack = new Gtk.Stack({
            vexpand: true, transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
            transition_duration: 180,
        });
        this._stack.add_titled(chartPage, 'chart', 'Chart');
        this._stack.add_titled(tablePage, 'table', 'Table');
        this._stack.add_titled(moversPage, 'movers', 'Movers');
        this._updateNavChips();   // boot with Watchlist wearing the pill
        content.append(this._stack);
        this._stack.connect('notify::visible-child-name', () => {
            const p = this._stack.get_visible_child_name();
            if (p === 'chart' || p === 'table' || p === 'movers')
                this._viewAction?.set_state(new GLib.Variant('s', p));
            this._updateNavChips();
            // The watchlist lives IN the sidebar, so Movers — a
            // dashboard that wants every column it can get — collapses
            // it on entry and restores the user's watchlist preference
            // on the way back. A manual Alt+S stays honored for as
            // long as you stay on the page; only toggles outside
            // Movers rewrite the remembered preference.
            if (p === 'movers')
                this._split.set_show_sidebar(false);
            else if (p === 'chart' || p === 'table')
                this._split.set_show_sidebar(
                    this._settings.get_boolean('sidebar-visible'));
            // the reader owns the whole pane: swap the ticker chrome out
            const reading = p === 'reader';
            for (const w of [sideBtn, menuBtn, search, navBox])
                w.set_visible(!reading);
            if (reading)
                this._searchPop?.popdown();
            this._readBack.set_visible(reading);
            this._readExt.set_visible(reading);
            // hero identity lives on the chart page now — the stack swap
            // already hides it while reading; nothing to toggle here
            this._readTitle.set_visible(reading);
        });

        // status line
        this._statusLbl = new Gtk.Label({label: '', css_classes: ['dim-label', 'caption'],
                                         halign: Gtk.Align.START,
                                         margin_start: 18, margin_bottom: 6});
        this._spinner = new Adw.Spinner({visible: false, margin_end: 6});
        const statusRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                       margin_start: 18});
        statusRow.append(this._spinner);
        statusRow.append(this._statusLbl);
        content.append(statusRow);

        /* —— sidebar: watchlist chooser + sparkline symbol rows —— */
        const sidebar = new Adw.Bin({css_classes: ['sidebar']});
        const sideBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const sideHead = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                      margin_start: 12, margin_end: 6,
                                      margin_top: 8, spacing: 6});
        const sideLbl = new Gtk.Label({label: 'Watchlists',
                                       css_classes: ['heading']});
        sideLbl.set_valign(Gtk.Align.CENTER);
        sideHead.append(sideLbl);
        // ALL list-level actions live here as one linked cluster:
        // new / edit-menu / delete. The edit button opens a small
        // menu (Rename · Remove tickers) — its one click used to
        // toggle a mode invisibly; now it reveals labelled choices.
        const listBtns = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                      css_classes: ['linked'],
                                      halign: Gtk.Align.END,
                                      hexpand: true,
                                      valign: Gtk.Align.CENTER});
        const newBtn = new Gtk.Button({icon_name: 'list-add-symbolic',
                                       tooltip_text: 'New list (Ctrl+N)'});
        newBtn.set_action_name('win.newlist');
        listBtns.append(newBtn);
        this._wlMenu = new Gtk.Popover({autohide: true});
        this._wlMenu.connect('show', () => this._populateWlMenu());
        // three-dash hamburger: the button CONTAINS choices (rename,
        // remove-tickers), and a disclosure glyph promises precisely
        // that — the pencil promised “edit”, then revealed a menu
        const editBtn = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'Watchlist actions · rename, organize tickers',
            popover: this._wlMenu,
        });
        this._manageBtn = editBtn;
        listBtns.append(editBtn);
        const delBtn = new Gtk.Button({icon_name: 'user-trash-symbolic',
                                       tooltip_text: 'Delete current list'});
        delBtn.connect('clicked', () =>
            this._deleteList(this._settings.get_string('active-watchlist')));
        listBtns.append(delBtn);
        sideHead.append(listBtns);
        sideBox.append(sideHead);

        // dropdown picking the active watchlist (the extension follows live)
        const chooser = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                     margin_start: 10, margin_end: 10,
                                     margin_top: 8, spacing: 4});
        this._wlStrings = new Gtk.StringList();
        this._wlDrop = new Gtk.DropDown({model: this._wlStrings,
                                         hexpand: true});
        // ellipsizing label factory: the default DropDown renders the
        // name in a label that refuses to shrink (min = natural = the
        // longest list name, measured live at 220px), which pinned the
        // whole sidebar's minimum width. With max-width-chars +
        // ellipsize the min collapses and narrow widths just truncate.
        {
            const f = new Gtk.SignalListItemFactory();
            f.connect('setup', (fac, item) =>
                item.set_child(new Gtk.Label({ellipsize: 3, xalign: 0,
                                              max_width_chars: 14})));
            f.connect('bind', (fac, item) => {
                // StringList items arrive as Gtk.StringObject wrappers
                // in this GJS, NOT JS strings: String(v) gives
                // "[object instance wrapper GIName:Gtk.StringObject]"
                // (live-probed). The real text is v.string.
                const v = item.get_item();
                const text = typeof v === 'string' ? v
                           : (v?.string ?? '');
                item.get_child().set_text(text);
            });
            this._wlDrop.set_factory(f);
        }
        this._wlDrop.connect('notify::selected', () => {
            if (this._suppressWl)
                return;
            const lists = this._lists();
            const wl = lists[this._wlDrop.get_selected()];
            if (wl && wl.id !== this._settings.get_string('active-watchlist'))
                this._settings.set_string('active-watchlist', wl.id);
        });
        chooser.append(this._wlDrop);
        sideBox.append(chooser);
        this._installEscLeavesEdit();

        // the watchlist itself: symbol + sparkline + price per row
        this._symList = new Gtk.ListBox({vexpand: true});
        this._symList.add_css_class('navigation-sidebar');
        this._symList.set_selection_mode(Gtk.SelectionMode.SINGLE);
        this._symList.connect('row-activated', (l, row) => {
            if (this._swipeOpen)
                this._setSwipe(row, false);
            if (row?._sym)
                this._selectSymbol(row._sym);
        });
        const symClick = new Gtk.GestureClick();
        symClick.set_button(3);
        symClick.connect('pressed', (g, nPress, x, y) => {
            const row = this._symList.get_row_at_y(y);
            if (GLib.getenv('TG_GESTURE'))
                log(`ROWMENU pressed sym=${row?._sym ?? 'hero'}`);
            this._showRowMenu(row?._sym, this._symList, x, y);
        });
        this._symList.add_controller(symClick);
        const symScroll = new Gtk.ScrolledWindow({vexpand: true});
        this._symScroll = symScroll;   // the sling stretches its top margin
        // overlay over the list hosts the drag ghost chip: it is a NEW
        // widget riding an overlay — it never reparents the row under
        // the pointer grab (which is what killed the paint before)
        {
            const symOv = new Gtk.Overlay({vexpand: true});
            // overlay OUTSIDE the scroller (scroller is the overlay's
            // main child): pill / drop-bar / ghost float over the
            // VIEWPORT and hold position while the list scrolls —
            // nested inside, they rode the content away. (The chain
            // stays complete: LIST -> scroll -> overlay.)
            symScroll.set_child(this._symList);
            symOv.set_child(symScroll);
            this._symOv = symOv;
            this._symAdj = symScroll.get_vadjustment();
            // the drop-position bar: a real overlay widget, not a box-
            // shadow on the row — adwaita sidebar rows are rounded
            // cards, so an inset line on them renders curved and
            // margin-offset ("the line doesn't render correctly").
            // translate_coordinates places it exactly on a boundary,
            // scroll offset included.
            this._dropBar = new Gtk.Box({
                css_classes: ['tg-dropbar'],
                halign: Gtk.Align.FILL, valign: Gtk.Align.START,
                height_request: 2,
            });
            this._dropBar.set_visible(false);
            symOv.add_overlay(this._dropBar);
            // “Updating quotes…” pill: floats at the top of the list
            // (overlay child — the rows never jump when it appears),
            // driven by _setSpinner with a 350ms grace so fast
            // rounds never flash it
            this._loadPill = new Gtk.Box({
                css_classes: ['tg-loadpill'], spacing: 6,
                halign: Gtk.Align.CENTER, valign: Gtk.Align.START,
            });
            this._loadSpin = new Gtk.Spinner();
            this._loadPill.append(this._loadSpin);
            this._loadLbl = new Gtk.Label({label: 'Updating quotes…',
                                           css_classes: ['caption']});
            this._loadPill.append(this._loadLbl);
            this._loadPill.set_visible(false);
            // code-side margin: CSS margin would outrank
            // set_margin_top; the pill rests here through the whole
            // sling — the tiles stretch beneath it, not around it
            this._loadPill.set_margin_top(8);
            symOv.add_overlay(this._loadPill);
            // sling-to-refresh: wheel/pad scroll UP while already at
            // the top drags the pill down like a rubber band; past
            // the threshold the refresh fires itself (the "release"
            // on a wheel is implicit — events just stop). Captured
            // so we see the deltas before the list consumes them;
            // scroll events never fight the row GestureDrag (that's
            // reorder's territory).
            {
                const sling = new Gtk.EventControllerScroll({
                    propagation_phase: Gtk.PropagationPhase.CAPTURE,
                    flags: Gtk.EventControllerScrollFlags.VERTICAL,
                });
                sling.connect('scroll', (c, dx, dy) =>
                    this._onSlingScroll(dy));
                symScroll.add_controller(sling);
            }
            this._ghost = new Gtk.Box({
                css_classes: ['tg-ghost'],
                halign: Gtk.Align.START, valign: Gtk.Align.START,
            });
            this._ghostLbl = new Gtk.Label({label: ''});
            this._ghost.append(this._ghostLbl);
            this._ghost.set_visible(false);
            symOv.add_overlay(this._ghost);
            sideBox.append(symOv);
        }
        /* resize grip: a thin strip riding the sidebar's right edge.
         * OverlaySplitView sizes the sidebar from a WIDTH FACTOR, so
         * the drag converts pixels -> factor over the live split
         * width; pixels are what the user perceives and what we
         * persist, and the factor is recomputed on every window
         * resize so the sidebar keeps its pixel width */
        const sideWrap = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL});
        sideBox.set_hexpand(true);
        sideWrap.append(sideBox);
        const grip = new Gtk.Box({css_classes: ['tg-sidegrip']});
        grip.set_size_request(7, -1);
        sideWrap.append(grip);
        sidebar.set_child(sideWrap);

        this._split = new Adw.OverlaySplitView({
            sidebar: sidebar, show_sidebar: this._settings.get_boolean('sidebar-visible'),
            min_sidebar_width: 180, max_sidebar_width: 480,
        });
        this._sidePx = this._settings.get_int('sidebar-width');
        this._applySidebarWidth();
        const gripDrag = new Gtk.GestureDrag();
        gripDrag.set_button(1);
        gripDrag.connect('drag-begin', () => {
            this._gripStart = this._sidePx;
            // where the grip sits in WINDOW coords at press time
            this._gripOriginX = grip.translate_coordinates(
                this, 0, 0)[1];
            this._resizing = true;
        });
        gripDrag.connect('drag-update', (g, x) => {
            // GestureDrag reports its offset in the GRIP's local space.
            // But the grip itself slides as the sidebar resizes, so a
            // still pointer's reported offset shrinks/grows by exactly
            // that slide — a feedback loop that oscillates (live-
            // probed: target 241<->229 in perfect lockstep with alloc
            // 221<->233, "jumping between two sizes"). Adding the
            // grip's true window-space displacement back recovers the
            // pointer's actual travel and breaks the loop.
            const slide = grip.translate_coordinates(
                this, 0, 0)[1] - this._gripOriginX;
            // no GLib.clamp in this GLib — plain Math
            const px = Math.min(480, Math.max(180,
                                   Math.round(this._gripStart + x + slide)));
            if (px === this._sidePx)
                return;
            this._sidePx = px;
            // Coalesce to ONE relayout per main-loop cycle. A high-
            // polling mouse fires drag-update far faster than frames;
            // each set_property forces a full split relayout + chart
            // repaint, and only the newest value ever reaches the
            // screen. A high-idle one-shot drains all queued motion
            // events first, then applies once — not on the frame
            // clock's pre-render 'update', which would queue a second
            // frame per step (that double-buffering is what stuttered).
            if (this._sideIdle)
                return;
            this._sideIdle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                this._sideIdle = 0;
                this._applySidebarWidth();
                return GLib.SOURCE_REMOVE;
            });
        });
        gripDrag.connect('drag-end', () => {
            if (this._sideIdle) {
                GLib.source_remove(this._sideIdle);
                this._sideIdle = 0;
            }
            this._applySidebarWidth();   // land exactly on the final px
            this._resizing = false;
            this._chart?.queue_draw();   // the one real paint, at rest
            this._settings.set_int('sidebar-width', this._sidePx);
        });
        grip.add_controller(gripDrag);
        // GTK CSS has no `cursor`; the col-resize pointer lives on the
        // widget so it appears on hover over the 7px strip
        grip.connect('realize', w => {
            // GJS constructor form is new_from_name(name, flags) — the
            // display is implicit (the default one, which is ours)
            w.set_cursor(Gdk.Cursor.new_from_name('col-resize', null));
        });
        // double-click the divider: back to the default width
        const gripTap = new Gtk.GestureClick();
        gripTap.set_button(1);
        gripTap.connect('pressed', (g, nPress) => {
            if (nPress !== 2)
                return;
            this._settings.set_int('sidebar-width', 280);
        });
        grip.add_controller(gripTap);
        grip.set_tooltip_text('Drag to resize · double-click to reset');
        // pixels -> factor needs the live split width. notify::width
        // and map are useless (map fires BEFORE the first allocation,
        // and the width notifies never fire on 4.22), so apply from
        // the content's snapshot: a draw can only happen after
        // allocation, so it covers boot AND every window resize. The
        // unchanged-guard inside keeps it free on subsequent frames
        content._onSnapshot = () => this._applySidebarWidth();
        sideBtn.bind_property('active', this._split, 'show_sidebar',
                              GObject.BindingFlags.BIDIRECTIONAL);
        // The preference tracks watchlist-page state only: Movers'
        // auto-collapse (and any manual override there) is transient
        // and must never overwrite what the user wants on Chart/Table.
        this._split.connect('notify::show-sidebar', sp => {
            if (this._stack?.get_visible_child_name() !== 'movers')
                this._settings.set_boolean('sidebar-visible',
                                           sp.get_show_sidebar());
        });
        this._split.set_content(this._toastOverlay(content));

        return this._split;
    }

    _toastOverlay(child) {
        this._toasts = new Adw.ToastOverlay();
        this._toasts.set_child(child);
        return this._toasts;
    }

    _menuBtn() {
        const menu = new Gio.Menu();
        menu.append('Refresh', 'win.refresh');
        menu.append('Preferences…', 'win.prefs');

        const viewM = new Gio.Menu();
        viewM.append('Chart', 'win.view::chart');
        viewM.append('Table', 'win.view::table');
        viewM.append('Movers', 'win.view::movers');
        menu.append_section('View', viewM);

        const src = new Gio.Menu();
        src.append('Yahoo Finance', 'win.source::yahoo');
        src.append('Yahoo via relay', 'win.source::yahoo-relay');
        src.append('Nasdaq (US stocks)', 'win.source::nasdaq');
        src.append('Demo (offline)', 'win.source::demo');
        menu.append_section('Data source', src);

        const theme = new Gio.Menu();
        theme.append('Follow system', 'win.theme::default');
        theme.append('Light', 'win.theme::light');
        theme.append('Dark', 'win.theme::dark');
        menu.append_section('Appearance', theme);

        const cols = new Gio.Menu();
        for (const def of COLS)
            cols.append(def.title, `win.col.${def.key}`);
        menu.append_section('Table columns', cols);

        const sort = new Gio.Menu();
        for (const def of COLS)
            sort.append(def.title, `win.sortKey::${def.key}`);
        menu.append_section('Sort by', sort);

        menu.append('About TickerGlass', 'win.about');

        const btn = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic', tooltip_text: 'Menu',
        });
        btn.set_menu_model(menu);
        return btn;
    }

    _intervalMenu() {
        const m = new Gio.Menu();
        m.append('Auto', 'win.interval::auto');
        const sec = new Gio.Menu();
        for (const iv of INTERVALS)
            sec.append(INTERVAL_LABEL[iv], `win.interval::${iv}`);
        m.append_section(null, sec);
        return m;
    }

    /* ── actions ──────────────────────────────────────────────────────── */

    _buildActions() {
        const act = (name, param, cb) => {
            const a = new Gio.SimpleAction({
                name,
                parameter_type: param ? new GLib.VariantType(param) : null,
            });
            a.connect('activate', cb);
            this.add_action(a);
            return a;
        };

        act('refresh', null, () => {
            // an explicit refresh means “answers must be new”: purge
            // every TTL cache (movers, history), then round quotes
            this._fetcher.invalidate();
            this._refresh(true);
        });
        act('readerback', null, () => this._leaveReader());
        act('search', null, () => {
            this.present();
            this._searchEntry.grab_focus();
        });
        const view = new Gio.SimpleAction({name: 'view',
            parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s', 'chart')});
        view.connect('change-state', (a, v) => {
            this._stack.set_visible_child_name(v.get_string()[0]);
            a.set_state(v);
        });
        this.add_action(view);
        this._viewAction = view;
        // Alt+digits are safe accelerators (unlike bare keys, they can
        // never be typed into the search entry). Accels live on the app.
        const app = this.get_application();
        if (app) {
            app.set_accels_for_action('win.view::chart', ['<alt>1']);
            app.set_accels_for_action('win.view::movers', ['<alt>2']);
            app.set_accels_for_action('win.view::table', ['<alt>3']);
        }
        act('sidebar', null, () =>
            this._split.set_show_sidebar(!this._split.show_sidebar));
        act('newlist', null, () => this._newListDialog());
        act('prefs', null, () => this._openPrefsDialog());
        act('about', null, () => this._openAbout());
        act('range', 's', (a, v) =>
            this._settings.set_string('chart-range', v.get_string()[0]));
        act('interval', 's', (a, v) =>
            this._settings.set_string('chart-interval', v.get_string()[0]));
        act('select', 's', (a, v) => this._selectSymbol(v.get_string()[0]));
        act('removeSymbol', 's', (a, v) => this._removeSymbol(v.get_string()[0]));
        act('moveSymbol', 's', (a, v) => this._moveSymbol(v.get_string()[0]));
        act('details', 's', (a, v) => this._openDetails(v.get_string()[0]));
        act('copy', 's', (a, v) => {
            const [s] = v.get_string();
            this.clipboard.set_text(s, -1);
            this._toast(`${s} copied`);
        });

        const src = new Gio.SimpleAction({
            name: 'source', parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s',
                this._settings.get_string('data-source')),
        });
        src.set_state(new GLib.Variant('s',
            this._settings.get_string('data-source')));
        src.connect('change-state', (a, v) => {
            a.set_state(v);
            this._settings.set_string('data-source', v.get_string()[0]);
        });
        this.add_action(src);

        const theme = new Gio.SimpleAction({
            name: 'theme', parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s', this._settings.get_string('app-theme')),
        });
        theme.set_state(new GLib.Variant('s',
            this._settings.get_string('app-theme')));
        theme.connect('change-state', (a, v) => {
            a.set_state(v);
            this._settings.set_string('app-theme', v.get_string()[0]);
        });
        this.add_action(theme);

        const style = new Gio.SimpleAction({
            name: 'style', parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s',
                this._settings.get_string('chart-style')),
        });
        style.connect('change-state', (a, v) => {
            a.set_state(v);
            this._settings.set_string('chart-style', v.get_string()[0]);
        });
        this.add_action(style);

        // chart comparison: state mirrors compare-symbol ('off' when
        // unset); '__custom' is a command item — opens the prompt and
        // deliberately does NOT take state
        const cmpA = new Gio.SimpleAction({
            name: 'cmp', parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s',
                this._settings.get_string('compare-symbol') || 'off'),
        });
        cmpA.connect('change-state', (a, v) => {
            // GJS: get_string() returns [str, len] — take [0]
            const s = v.get_string()[0];
            if (s === '__custom') {
                textPrompt({
                    parent: this, title: 'Compare against',
                    initial: '', acceptLabel: 'Compare',
                    onAccept: t => {
                        const sym = t.trim().toUpperCase();
                        if (sym)
                            this._settings.set_string('compare-symbol',
                                                      sym);
                    },
                });
                return;
            }
            a.set_state(v);
            this._settings.set_string('compare-symbol',
                s === 'off' ? '' : s);
        });
        this.add_action(cmpA);
        this._cmpAction = cmpA;

        // sparkline window: state mirrors the spark-range key; the
        // watcher re-kicks the quote round, which is what re-shapes
        // every sparkline
        const sparkA = new Gio.SimpleAction({name: 'spark',
            parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s',
                this._settings.get_string('spark-range'))});
        sparkA.connect('change-state', (a, v) => {
            a.set_state(v);
            this._settings.set_string('spark-range', v.get_string()[0]);
        });
        this.add_action(sparkA);
        this._sparkAction = sparkA;

        // per-column visibility toggles: win.col.<key>, boolean stateful so
        // the menu renders checkmarks
        this._colActions = {};
        for (const def of COLS) {
            const a = new Gio.SimpleAction({
                name: `col.${def.key}`,
                state: new GLib.Variant('b', true),
            });
            a.connect('change-state', (act, v) => {
                act.set_state(v);
                this._setColumnVisible(def.key, v.get_boolean());
            });
            this.add_action(a);
            this._colActions[def.key] = a;
        }
        // sort key (radio): win.sortKey::<key>; header clicks keep working too
        const sortKey = new Gio.SimpleAction({
            name: 'sortKey', parameter_type: new GLib.VariantType('s'),
            state: new GLib.Variant('s', 'symbol'),
        });
        sortKey.set_state(new GLib.Variant('s', 'symbol'));
        sortKey.connect('change-state', (a, v) => {
            a.set_state(v);
            this._sortKey(v.get_string()[0]);
        });
        this.add_action(sortKey);
        this._sortKeyAction = sortKey;
    }

    /* ── watchlists (sidebar) ─────────────────────────────────────────── */

    _lists() {
        return parseWatchlists(this._settings.get_string('watchlists'));
    }

    // lists may be passed in so caller and helper share ONE parsed copy —
    // pushing into a second parse and writing the first silently lost adds
    _activeList(lists = this._lists()) {
        const id = this._settings.get_string('active-watchlist');
        return lists.find(w => w.id === id) ?? lists[0];
    }

    _writeLists(lists) {
        this._settings.set_string('watchlists', stringifyWatchlists(lists));
    }

    _rebuildSidebar() {
        const lists = this._lists();
        const active = this._settings.get_string('active-watchlist');

        // dropdown: "Name · N" per list
        this._suppressWl = true;
        while (this._wlStrings.get_n_items())
            this._wlStrings.remove(this._wlStrings.get_n_items() - 1);
        let activeIx = 0;
        lists.forEach((wl, i) => {
            this._wlStrings.append(`${wl.name}  ·  ${wl.symbols.length}`);
            if (wl.id === active)
                activeIx = i;
        });
        this._wlDrop.set_selected(activeIx);
        this._suppressWl = false;

        // symbol rows: sym · sparkline · price/%
        for (let r = this._symList.get_first_child(); r;) {
            const next = r.get_next_sibling();
            this._symList.remove(r);
            r = next;
        }
        this._symRows = {};
        const wl = this._activeList();
        for (const sym of wl?.symbols ?? []) {
            const row = new Gtk.ListBoxRow();
            row._sym = sym;
            const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                     spacing: 8, margin_top: 5,
                                     margin_bottom: 2});
            // NO ellipsize here, deliberately: GTK auto-marks ellipsized
            // labels selectable when truncation happens during layout —
            // after any explicit set_selectable(false) — and a selectable
            // label carries its own text DragSource that hijacks the
            // long-press, so dragging moved the symbol TEXT, not the row
            const symL = new Gtk.Label({label: sym, xalign: 0});
            symL.add_css_class('tg-row-sym');
            symL.set_max_width_chars(10);
            symL.set_selectable(false);
            box.append(symL);
            // company name rides BELOW the whole top line (symbol +
            // sparkline + price), so the sparkline keeps an identical
            // baseline in every row. Ellipsized for long names — but
            // can_target(false): GTK auto-marks ellipsized labels
            // selectable at layout, and a selectable label's text
            // DragSource hijacks the row reorder drag (the historical
            // symL bug). Dead to the pointer, the ellipsis is safe.
            const nameL = new Gtk.Label({label: '', xalign: 0,
                                         ellipsize: 3,
                                         max_width_chars: 22,
                                         css_classes: ['dim-label'],
                                         can_target: false,
                                         halign: Gtk.Align.START,
                                         margin_bottom: 5});
            nameL.add_css_class('tg-row-name');
            row._nameL = nameL;
            // faint side handle, organize mode only: two soft bars
            // that say "grippable" right where the grip lives
            const handleL = new Gtk.Label({label: '‖', can_target: false,
                                           valign: Gtk.Align.CENTER});
            handleL.add_css_class('tg-handle');
            handleL.set_visible(false);
            row._handleL = handleL;
            const spark = new Gtk.DrawingArea({content_width: 56,
                                               content_height: 22});
            spark.set_hexpand(true);
            spark.set_valign(Gtk.Align.CENTER);
            spark.set_draw_func((area, cr, w, h) => {
                const q = this._quoteOf(row._sym);
                if (!q?.spark || q.spark.length < 2)
                    return;
                paintMiniSpark(cr, {w, h, values: q.spark,
                                    up: (q.change ?? 0) >= 0});
            });
            box.append(spark);
            const priceL = new Gtk.Label({label: '—', css_classes: ['numeric']});
            const pctL = new Gtk.Label({label: '', css_classes: ['caption', 'numeric']});
            // triangle + pct as one unit: the up/down class rides the
            // container so the drawn triangle inherits the same color
            const pctTri = this._makeTri(11);
            const pctBox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                        spacing: 5,
                                        halign: Gtk.Align.END});
            pctBox.append(pctTri);
            pctBox.append(pctL);
            const praw = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                      spacing: 0});
            praw.append(priceL);
            praw.append(pctBox);
            // swipe-to-delete: the red ✕ rides the row's flow layout at
            // zero width until a horizontal GestureDrag pushes it in.
            // Vertical hold-drag is the DragSource's (long-press-to-move):
            // early pointer motion cancels DragSource's activation, so
            // the two never fight over the same press.
            // trash pill: icon (not ✕ glyph), capsule via .pill +
            // radius-999 CSS, floating on row margins — edit mode
            // pins these on every row, swipe reveals one
            const trashImg = new Gtk.Image({icon_name: 'user-trash-symbolic'});
            trashImg.set_pixel_size(16);
            const delBtn = new Gtk.Button({child: trashImg,
                                           valign: Gtk.Align.CENTER});
            delBtn.set_visible(false);
            delBtn.add_css_class('tg-del-reveal');
            delBtn.add_css_class('pill');
            // the row paints an all-scroll grab cursor over itself
            // (it IS drag-reorderable); the pill is a button, not a
            // handle — hand it the pointer hand so hover says
            // “click”, matching every other button in the app
            try {
                delBtn.set_cursor(
                    Gdk.Cursor.new_from_name('pointer', null));
            } catch (e) { /* themed cursors are polish */ }
            delBtn.connect('clicked', () => {
                this._setSwipe(row, false);
                this._removeSymbol(sym);
            });
            row._delBtn = delBtn;
            // ONE gesture per row serves both interactions, decided by
            // the axis of the initial motion: horizontal reveals delete,
            // vertical drags the row up/down the list. No GtkDragSource:
            // GTK's DnD protocol cancelled every drag within a
            // millisecond of starting, identically on X11 and Wayland
            // (the sequence grab fails somewhere under OverlaySplitView's
            // own swipe controllers) — while plain gestures, which never
            // leave the client, work fine.
            row.add_controller(this._rowGesture(row, delBtn));
        // grab cursor: only while ORGANIZE mode makes rows actually
        // draggable — outside it rows shouldn't advertise a grip they
        // don't honor (try/catch: Gdk cursor construction is the kind
        // of thing this GJS drops on the floor)
        const hov = new Gtk.EventControllerMotion();
        hov.connect('enter', () => {
            try {
                if (this._editMode)
                    row.set_cursor(Gdk.Cursor.new_from_name('all-scroll',
                        null));
            } catch (e) { /* cursor is polish, not function */ }
        });
        hov.connect('leave', () => {
            try {
                row.set_cursor(null);
            } catch (e) { /* ditto */ }
        });
        row.add_controller(hov);
            // three columns: [sym | spark] with the name as its second
            // line on the left, and price+pct as an independent right
            // column CENTERED against the full two-line height — so
            // the name hugs the sparkline instead of sitting under it
            const leftV = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL, spacing: 0,
                hexpand: true});
            leftV.append(box);
            leftV.append(nameL);
            praw.set_valign(Gtk.Align.CENTER);
            const rowWrap = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
                margin_start: 10, margin_end: 10});
            rowWrap.append(handleL);
            rowWrap.append(leftV);
            rowWrap.append(praw);
            rowWrap.append(delBtn);
            row.set_child(rowWrap);
            row._priceL = priceL;
            row._pctL = pctL;
            row._pctBox = pctBox;
            row._pctTri = pctTri;
            row._spark = spark;
            this._symList.append(row);
            this._symRows[sym] = row;
        }
        this._updateWatchRows();
        this._swipeOpen = null;               // rows are new objects now
        if (this._editMode)                   // rebuild must not unmask
            for (const r of Object.values(this._symRows)) {
                r._delBtn?.set_visible(true);
                r._delBtn?.set_size_request(TG_DEL_W, -1);
                r._handleL?.set_visible(true);
            }
        if (this._ghost)
            this._ghost.set_visible(false);   // stale during a rebuild
        this._clearDropLine();
        this._repaintTitle();
        // what the UI now reflects: the watchlists watcher diffs against
        // this to tell add/remove from rename/reorder
        this._uiSymbols = [...(wl?.symbols ?? [])];
    }

    /* swipe-to-delete state: at most one row is open. The button takes
     * real width in the row's hbox (content compresses) — cheap and
     * flicker-free against overlays on transparent rows. */
    /* ── sling-to-refresh ───────────────────────────────────────────
     * Desktop translation of the mobile pull gesture: the wheel is
     * the sling. Each UP delta felt at the very top of the list
     * drags the loading pill down (rubber-band, saturating near the
     * threshold); committed enough, it fires a manual refresh and
     * the pill switches to its spinner role. Scroll down, or just
     * stop pulling, and the band snaps back. */
    _onSlingScroll(dy) {
        const TH = 120;                      // px of accumulated pull
        if (dy > 0 || this._symAdj?.get_value() > 1) {
            this._slingCancel();             // heading down: band off
            return false;                    // never consume
        }
        if (this._busy || this._slingFired)
            return false;
        this._sling = Math.min(TH, (this._sling || 0) +
                               Math.abs(dy) * 30);
        // the rubber band itself: with nothing below the list in the
        // sidebar column, a live margin-top on the SCROLLER slides
        // the whole tile stack down over the sidebar background —
        // iOS-style stretch, pills riding along. Wheel events are
        // discrete (~10/s), so the relayout per notch is free.
        const px = Math.round(44 * this._sling / TH);
        this._symScroll?.set_margin_top(px);
        if (this._loadPill) {
            this._loadLbl?.set_text('Pull to refresh');
            this._loadPill.set_visible(true);
            this._loadSpin?.stop();          // progress, not waiting
            // the pill stays PUT at its resting spot (margin set at
            // build) while the tiles stretch beneath it — following
            // the tile edge read like drift
        }
        // events are discrete — “released” means nothing arrived for
        // a moment; at that instant a full band fires, a partial
        // one snaps back
        if (this._slingTimeout)
            GLib.source_remove(this._slingTimeout);
        this._slingTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            180, () => {
                this._slingTimeout = 0;
                if (this._sling >= TH) {
                    this._slingFired = true;
                    this._loadLbl?.set_text('Updating quotes…');
                    this._refresh(true);     // spinner path takes over
                } else {
                    this._slingCancel();
                }
                return GLib.SOURCE_REMOVE;
            });
        return false;
    }

    _slingCancel() {
        this._sling = 0;
        if (this._slingTimeout) {
            GLib.source_remove(this._slingTimeout);
            this._slingTimeout = 0;
        }
        // recoil, not a teleport: shrink the stretch by a third every
        // 30ms — the band visibly snaps the tiles back into place
        const recoil = () => {
            const m = (this._symScroll?.get_margin_top?.() ?? 0);
            if (m <= 2) {
                this._symScroll?.set_margin_top(0);
                if (!this._busy && !this._loadPend)
                    this._loadPill?.set_visible(false);
                this._slingAnim = 0;
                return GLib.SOURCE_REMOVE;
            }
            const next = Math.max(0, Math.round(m * 0.35));
            this._symScroll?.set_margin_top(next);
            return GLib.SOURCE_CONTINUE;
        };
        if (this._slingAnim)
            return;   // one recoil at a time; it will pick up new state
        this._slingAnim = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            30, recoil);
    }

    /* round-trip busy switch: header spinner (immediate) + the
     * sidebar's pill. The pill is DELAYED 350ms: quick rounds — most
     * polls land in well under that — never flash it, so it only
     * announces rounds the user is genuinely waiting on, and
     * vanishes the instant the data lands. */
    _setSpinner(on) {
        this._spinner.set_visible(on);
        if (on) {
            if (this._loadPill?.get_visible())
                this._loadSpin?.start();   // sling already showed it —
                                           // spinner starts straight away
            else if (!this._loadPend)
                this._loadPend = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    350, () => {
                        this._loadPend = 0;
                        this._loadPill?.set_visible(true);
                        this._loadSpin?.start();
                        return GLib.SOURCE_REMOVE;
                    });
        } else {
            if (this._loadPend) {
                GLib.source_remove(this._loadPend);
                this._loadPend = 0;
            }
            this._loadPill?.set_visible(false);
            this._loadSpin?.stop();
            // sling bookkeeping: the stretch is HELD while the round
            // runs (iOS keeps the spinner area open) and released
            // the moment data lands
            this._sling = 0;
            this._slingFired = false;
            this._loadPill?.set_margin_top(8);
            this._symScroll?.set_margin_top(0);
        }
    }

    _setSwipe(row, open) {
        if (this._editMode) {
            // chips are already pinned on every row — a stray swipe
            // must not play hide-and-seek with them
            for (const r of Object.values(this._symRows ?? {})) {
                r._delBtn?.set_visible(true);
                r._delBtn?.set_size_request(TG_DEL_W, -1);
            }
            return;
        }
        for (const r of Object.values(this._symRows ?? {})) {
            if (r !== row) {
                r._delBtn?.set_visible(false);
                r._delBtn?.set_size_request(-1, -1);
            }
        }
        row._delBtn?.set_visible(open);
        row._delBtn?.set_size_request(open ? TG_DEL_W : -1, -1);
        this._swipeOpen = open ? row : null;
    }

    /* organize mode (menu): every row pins its trash pill AND becomes
     * reorder-draggable, with the ‖ handle appearing at the grip
     * column. Outside the mode, rows do not drag at all — the gesture
     * stays unclaimed and the grab cursor stays away. Transient on
     * purpose — always starts off with the app. */
    _setEditMode(on) {
        this._editMode = on;
        if (this._manageBtn) {
            if (on)
                this._manageBtn.add_css_class('tg-manage-on');
            else
                this._manageBtn.remove_css_class('tg-manage-on');
        }
        for (const r of Object.values(this._symRows ?? {})) {
            r._delBtn?.set_visible(on);
            r._delBtn?.set_size_request(on ? TG_DEL_W : -1, -1);
            r._handleL?.set_visible(on);
            // re-cursor rows under/awaiting the pointer immediately
            try {
                r.set_cursor(on
                    ? Gdk.Cursor.new_from_name('all-scroll', null)
                    : null);
            } catch (e) { /* cursor is polish */ }
        }
        this._swipeOpen = null;
    }

    /* THE app's up/down indicator: chunky filled triangle, rounded
     * corners, weight scaled to size — used by the hero pill, every
     * sidebar row and the table's pct cell so one shape reads
     * everywhere. Colour is inherited CSS (place tg-up/tg-down on an
     * ancestor); direction is the _up JS property + queue_draw. */
    _makeTri(size) {
        const da = new Gtk.DrawingArea({valign: Gtk.Align.CENTER,
                                        halign: Gtk.Align.CENTER});
        da.set_content_width(Math.round(size * 1.0));
        da.set_content_height(size);
        da._up = true;
        da.set_draw_func((w, cr, ww, hh) => {
            let r = 0.15, g = 0.63, b = 0.41, a = 1;      // green fallback
            if (!w._up)
                [r, g, b] = [0.75, 0.11, 0.16];           // red fallback
            try {
                // GTK 4.20: get_color() takes no flags anymore (it reads
                // the widget's current state); passing one spams warnings
                const c = w.get_style_context().get_color();
                if (c)
                    [r, g, b, a] = [c.red, c.green, c.blue, c.alpha];
            } catch (e) { /* fallback colors keep direction honest */ }
            cr.setSourceRGBA(r, g, b, a);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineCap(Cairo.LineCap.ROUND);
            // experiment switch: TG_TRI=arrow|outline|tri|disc|block
            const shape = GLib.getenv('TG_TRI') || 'tri';
            // outline mode needs a visible line weight of its own
            const lw = shape === 'outline' ? Math.max(1.8, size / 8)
                                           : Math.max(1.2, size / 14);
            cr.setLineWidth(lw);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineCap(Cairo.LineCap.ROUND);
            const p = lw / 2 + 1;
            if (shape === 'block') {
                // bold block arrow (user reference): deep chevron head
                // with squared outer wings, wide stem, hard miter
                // corners — drawn pointing down, flipped for gainers
                cr.setLineJoin(Cairo.LineJoin.MITER);
                if (w._up) {
                    cr.translate(ww / 2, hh / 2);
                    cr.rotate(Math.PI);
                    cr.translate(-ww / 2, -hh / 2);
                }
                const bp = 1.2, sw = ww * 0.12;
                // proportions measured off the reference: stem junction
                // high (27%), long vertical wing walls (~31%), narrow stem
                const jy = p + (hh - 2 * p) * 0.27;
                const wd = (hh - 2 * p) * 0.31;
                cr.moveTo(ww / 2 - sw, p);
                cr.lineTo(ww / 2 + sw, p);
                cr.lineTo(ww / 2 + sw, jy);
                cr.lineTo(ww - bp, jy);
                cr.lineTo(ww - bp, jy + wd);
                cr.lineTo(ww / 2, hh - bp);
                cr.lineTo(bp, jy + wd);
                cr.lineTo(bp, jy);
                cr.lineTo(ww / 2 - sw, jy);
                cr.closePath();
                cr.fill();
                return;
            }
            if (!w._up) {
                // mirror about the centre: draw the up form, flipped
                cr.translate(ww / 2, hh / 2);
                cr.rotate(Math.PI);
                cr.translate(-ww / 2, -hh / 2);
            }
            if (shape === 'disc') {
                // badge style (user reference): filled colour disc with
                // a solid white arrow punched into it — reads at any size
                const rad = Math.min(ww, hh) / 2 - 1;
                cr.arc(ww / 2, hh / 2, rad, 0, 2 * Math.PI);
                cr.fill();
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.save();
                cr.translate(ww / 2, hh / 2);
                const ah = rad * 0.62;          // arrow tip above centre
                const aw = ah * 0.92;           // head half width
                const sw = aw * 0.38;           // stem half width
                cr.setLineWidth(1);
                cr.moveTo(0, -ah);
                cr.lineTo(aw, ah * 0.12);
                cr.lineTo(sw, ah * 0.12);
                cr.lineTo(sw, ah * 0.95);
                cr.lineTo(-sw, ah * 0.95);
                cr.lineTo(-sw, ah * 0.12);
                cr.lineTo(-aw, ah * 0.12);
                cr.closePath();
                cr.fillPreserve();
                cr.stroke();                    // white bloom: round corners
                cr.restore();
            } else if (shape === 'tri') {
                // Flat ROUNDED triangle, one colour, no rim (user
                // reference: Robinhood's clip-path chip). Stroke +
                // fill of the SAME path: the round line-join puffs
                // each of the three corners outward by exactly rad,
                // so the rounding holds at hero size and at 10px.
                // (The old design strode a wide dark rim behind the
                // fill; the reference asks the colour alone to carry
                // direction.)
                const rad = Math.max(1.1, size * 0.18);
                const inset = rad + 0.5;
                cr.setLineWidth(rad * 2);
                cr.moveTo(ww / 2, inset);
                cr.lineTo(ww - inset, hh - inset);
                cr.lineTo(inset, hh - inset);
                cr.closePath();
                cr.strokePreserve();
                cr.fill();
                return;
            } else {
                // solid arrow: head + stem, rounded by the fat stroke
                const cx = ww / 2;
                const shoulder = p + (hh - 2 * p) * 0.45;
                const stem = (ww / 2 - p) * 0.27;
                cr.moveTo(cx, p);
                cr.lineTo(ww - p, shoulder);
                cr.lineTo(cx + stem, shoulder);
                cr.lineTo(cx + stem, hh - p);
                cr.lineTo(cx - stem, hh - p);
                cr.lineTo(cx - stem, shoulder);
                cr.lineTo(p, shoulder);
            }
            cr.closePath();
            if (shape === 'outline')
                cr.stroke();     // hollow — the pill gradient shows through
            else {
                cr.fillPreserve();
                cr.stroke();
            }
        });
        return da;
    }

    /* The row's one GestureDrag, claimed outright at begin. The axis of
     * the first motion picks the interaction: horizontal reveals the red
     * ✕; vertical drags the row live through the list (swapping at
     * half-row steps) and persists the new order on release. */
    _rowGesture(row, btn) {
        const g = new Gtk.GestureDrag();
        const gdb = !!GLib.getenv('TG_GESTURE');
        let axis = null, startOff = 0, off = 0, upd = 0;
        let rowH = 1, moved = false, lastY = 0;
        let inert = false;
        // GestureDrag::drag-begin passes (x, y, sequence) — sequence is
        // LAST, and the axis must be decided here (a gesture left
        // participating without claim/release poisons other handlers)
        g.connect('drag-begin', (self, bx, by, seq) => {
            if (!seq)
                seq = g.get_last_updated_sequence();
            startOff = off = this._swipeOpen === row ? TG_DEL_W : 0;
            upd = 0;
            moved = false;
            axis = 'y';
            const [okS, sx, sy] = g.get_start_point();
            const [okP, px, py] = seq ? g.get_point(seq, g.get_widget())
                                      : [false, 0, 0];
            if (okS && okP && Math.abs(px - sx) > Math.abs(py - sy))
                axis = 'x';
            inert = false;
            // reordering is an ORGANIZE-mode action: outside it, a
            // vertical hold-drag stays inert — the gesture never
            // claims the sequence, so GTK's own affordances (text
            // selection, scrolling) are undisturbed and the list
            // physically cannot be dragged
            if (axis === 'y' && !this._editMode) {
                inert = true;
                this._dragging = false;
                return;
            }
            // get_height() survives in this GJS; get_alloc and
            // set_translation do NOT exist here (probed), so there is no
            // transform API to lift the row — feedback is opacity only,
            // and the reorder lands on release via a data-level shift
            rowH = row.get_height() >= 24 ? row.get_height() : 44;
            if (gdb)
                log(`GESTURE row-begin ${row._sym} axis=${axis}`);
            // freeze the settings fan-out mid-drag: a rebuild would
            // destroy the row under the pointer and corrupt the list
            // (insert_after assertion storm, rows vanishing)
            this._dragging = true;
            if (axis === 'y' && this._ghost) {
                const q = this._quoteOf ? this._quoteOf(row._sym) : null;
                this._ghostLbl.set_text(row._sym + (q && q.price != null
                    ? '  ' + fmtPrice(q.price, q.currency) : ''));
                const wl0 = this._activeList();
                const from0 = wl0 ? wl0.symbols.indexOf(row._sym) : 0;
                this._ghost.set_size_request(-1,
                    Math.max(rowH - 6, 24));
                this._ghost.set_margin_top(Math.max(0, from0 * rowH -
                    (this._symAdj?.get_value() ?? 0)));
                this._ghost.set_visible(true);
            }
            if (seq)
                g.set_sequence_state(seq, Gtk.EventSequenceState.CLAIMED);
        });
        g.connect('drag-update', (self, x, y) => {
            if (inert)
                return;
            if (axis === 'x') {
                if (gdb && ++upd > 3)
                    return;
                off = Math.max(0, Math.min(TG_DEL_W, startOff - x));
                if (off > 1 && this._swipeOpen && this._swipeOpen !== row)
                    this._setSwipe(this._swipeOpen, false);
                btn.set_visible(off > 1);
                btn.set_size_request(Math.round(off), -1);
                return;
            }
            // vertical: no transform API in this GJS (set_translation
            // missing), so the row itself cannot lift — the ghost chip
            // and the insertion line carry the motion instead, and the
            // reorder commits as a data shift on release. The widget
            // tree is never touched under the live grab: that's what
            // killed the listbox paint before.
            lastY = y;
            row.set_opacity(0.35);
            const wl = this._activeList();
            const from = wl ? wl.symbols.indexOf(row._sym) : -1;
            if (from < 0)
                return;
            const to = Math.max(0, Math.min(wl.symbols.length - 1,
                from + (Math.sign(y) * Math.floor(Math.abs(y) / rowH))));
            moved = to !== from;
            if (this._ghost)
                this._ghost.set_margin_top(Math.max(0,
                    from * rowH + y - rowH / 3 -
                    (this._symAdj?.get_value() ?? 0)));
            // where the bar sits: `to` is the row's FINAL index, so
            // the boundary depends on direction — rows ABOVE the
            // source don't shift (dragging up), but the source's own
            // slot collapsing shifts everything below it up by one
            // (dragging down). Drawing kids[to] "above" for both was
            // the off-by-one: a down-drag landed one slot under its
            // own line. Down: bar BELOW original row `to`. Up: above.
            const kids = [];
            for (let c = this._symList.get_first_child(); c;
                 c = c.get_next_sibling())
                kids.push(c);
            const tgt = kids[to];
            const below = to > from;
            if (this._dropBar) {
                if (tgt) {
                    // exact boundary in overlay coords: translate runs
                    // through the real transform, so a scrolled list
                    // lands the bar where it VISUALLY belongs
                    const tr = tgt.translate_coordinates(
                        this._symOv, 0, 0);
                    if (tr[0])
                        this._dropBar.set_margin_top(Math.round(
                            tr[2] + (below ? tgt.get_height() : 0)));
                    this._dropBar.set_visible(true);
                } else {
                    this._dropBar.set_visible(false);
                }
            }
            if (gdb && ++upd < 4)
                log(`GESTURE row-drag ${row._sym} dy=${Math.round(y)} `
                    + `to=${to}`);
        });
        g.connect('drag-end', () => {
            this._dragging = false;
            if (inert)
                return;      // never engaged; nothing to settle
            // GestureDrag folds cancel into end — settle covers both
            if (gdb)
                log(`GESTURE row-end ${row._sym} axis=${axis} off=${off}`
                    + ` lastY=${Math.round(lastY)} moved=${moved}`);
            if (axis === 'x') {
                this._setSwipe(row, off > TG_DEL_W / 2);
            } else {
                if (this._ghost)
                    this._ghost.set_visible(false);
                this._clearDropLine();
                row.set_opacity(1);
                const wl = this._activeList();
                const from = wl ? wl.symbols.indexOf(row._sym) : -1;
                if (moved && from >= 0) {
                    // same full-row-height steps as the live line
                    const steps = Math.sign(lastY) *
                        Math.floor(Math.abs(lastY) / rowH);
                    const to = Math.max(0, Math.min(
                        wl.symbols.length - 1, from + steps));
                    if (to !== from)
                        this._applyDragShift(row._sym, from, to);
                }
            }
            if (this._dragPending) {
                this._dragPending = false;
                this._rebuildSidebar();
                this._refresh(true);
            }
        });
        return g;
    }

    /* drop the accent line off whichever row carries it (a rebuild may
     * have replaced that widget under us — remove_css_class on a dead
     * row is harmless, but we drop the stale ref here) */
    _clearDropLine() {
        if (this._dropBar) {          // overlay bar era: one hide
            this._dropBar.set_visible(false);
            return;
        }
        if (this._dropLineRow) {
            this._dropLineRow.remove_css_class(this._dropLineCls ||
                'tg-drop-line');
            this._dropLineRow = null;
            this._dropLineCls = null;
        }
    }

    /* Esc leaves Remove-tickers mode — the universal 'never mind'
     * key. Window-level controller: dialogs are separate surfaces
     * that eat their own Escape, and Popovers close on Escape
     * before the window ever sees it, so this only fires when a
     * mode is the topmost thing to dismiss. */
    _installEscLeavesEdit() {
        const kc = new Gtk.EventControllerKey();
        // CAPTURE, not the default NONE: the key must be judged
        // before the focused widget (search entry, menu button…)
        // gets its own crack at Escape — at bubble phase this
        // controller never fired at all
        kc.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        kc.connect('key-pressed', (c, keyval) => {
            if (GLib.getenv('TG_ESC'))
                log(`ESCEVT key=${keyval} esc=${Gdk.KEY_Escape} ` +
                    `mode=${this._editMode}`);
            if (keyval === Gdk.KEY_Escape && this._editMode) {
                this._setEditMode(false);
                return true;   // consumed
            }
            return false;
        });
        this.add_controller(kc);
    }

    /* commit a live-drag displacement to the SYMBOL ARRAY — the widget
     * order is never trusted as source (a desynced tree is what turned
     * 15 symbols into 0 the first go). The gsettings watcher rebuilds
     * the sidebar from data with fresh widgets: the paint always
     * starts clean, nothing is reparented under a live grab. */
    _applyDragShift(symbol, from, to) {
        const lists = this._lists();
        const wl = this._activeList(lists);
        if (!wl || wl.symbols[from] !== symbol)
            return;
        const syms = wl.symbols.slice();
        syms.splice(from, 1);
        syms.splice(to, 0, symbol);
        wl.symbols = syms;
        this._writeLists(lists);
    }

    _quoteOf(sym) {
        return this._quotes.find(x => x.symbol === sym);
    }

    /* push fresh quote data into the sidebar rows (labels + sparklines) */
    _updateWatchRows(onlySym = null) {
        if (!this._symRows)
            return;
        for (const [sym, row] of Object.entries(this._symRows)) {
            if (onlySym && sym !== onlySym)
                continue;
            const q = this._quoteOf(sym);
            row._priceL.set_text(q?.price != null
                ? fmtPrice(q.price, q.currency) : '—');
            if (row._nameL && q?.name)
                row._nameL.set_text(q.name);
            row._pctL.set_text(q?.changePct != null
                ? fmtPct(q.changePct) : '');
            const pUp = (q?.change ?? q?.changePct ?? 0) >= 0;
            row._pctTri._up = pUp;
            row._pctTri.queue_draw();
            row._pctBox.remove_css_class('tg-up');
            row._pctBox.remove_css_class('tg-down');
            if (q?.change != null)
                row._pctBox.add_css_class(pUp ? 'tg-up' : 'tg-down');
            row._spark.queue_draw();
        }
        const heroRow = this._symRows[this._hero()];
        if (heroRow)
            this._symList.select_row(heroRow);
    }

    _newListDialog() {
        textPrompt({
            parent: this,
            title: 'New watchlist',
            acceptLabel: 'Create',
            onAccept: name => {
                const lists = this._lists();
                const id = `wl${Date.now()}`;
                lists.push({id, name, symbols: []});
                this._writeLists(lists);
                this._settings.set_string('active-watchlist', id);
            },
        });
    }

    _renameList(id) {
        const lists = this._lists();
        const wl = lists.find(w => w.id === id);
        if (!wl)
            return;
        textPrompt({
            parent: this,
            title: 'Rename list',
            initial: wl.name,
            onAccept: name => {
                wl.name = name;
                this._writeLists(lists);
            },
        });
    }

    _deleteList(id) {
        const all = this._lists();
        const wl = all.find(w => w.id === id);
        if (!wl)
            return;
        if (all.length < 2) {
            this._toast('Keep at least one list');
            return;
        }
        // native confirm: the old click-to-annihilate-a-watchlist was
        // one fat finger from losing a curated list (rows swipe-delete
        // behind a reveal gesture — the list itself had no gate at all)
        const n = wl.symbols.length;
        const alert = new Adw.AlertDialog({
            heading: `Delete “${wl.name}”?`,
            body: n === 1
                ? 'Its 1 ticker will be gone. This cannot be undone.'
                : `Its ${n} tickers will be gone. This cannot be undone.`,
            close_response: 'cancel',
        });
        alert.add_response('cancel', 'Cancel');
        alert.set_response_appearance('cancel',
            Adw.ResponseAppearance.DEFAULT);
        alert.add_response('delete', 'Delete');
        alert.set_response_appearance('delete',
            Adw.ResponseAppearance.DESTRUCTIVE);
        alert.set_default_response('cancel');
        alert.connect('response', (a, r) => {
            if (r !== 'delete')
                return;
            const lists = all.filter(w => w.id !== id);
            this._writeLists(lists);
            if (this._settings.get_string('active-watchlist') === id)
                this._settings.set_string('active-watchlist',
                    lists[0].id);
            this._toast('List deleted');
        });
        alert.present(this);
    }

    /* commit a previewed symbol to a specific list (split-button menu) */
    _addSymbolTo(symbol, listId) {
        const lists = this._lists();
        const wl = lists.find(w => w.id === listId);
        if (!wl || wl.symbols.includes(symbol))
            return;
        wl.symbols.push(symbol);
        this._writeLists(lists);
        this._toast(`${symbol} → ${wl.name || 'list'}`);
    }

    /* rebuild the split-button popover: fresh symbol + list membership */
    /* the edit button's menu: the two actions that button stands for
     * — rename (a one-shot) and remove-tickers (a MODE, checkmarked
     * while on). New/Delete have their own buttons in the cluster.
     * Rebuilt on open so the name and mode check are current. */
    _populateWlMenu() {
        const lists = this._lists();
        const wl = this._activeList(lists);
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 2,
            margin_top: 6, margin_bottom: 6,
            margin_start: 6, margin_end: 6,
        });
        box.set_size_request(212, -1);
        const item = (icon, label, fn, checked = null) => {
            const b = new Gtk.Button({css_classes: ['flat'],
                                      hexpand: true});
            b.set_halign(Gtk.Align.FILL);
            const row = new Gtk.Box({spacing: 10});
            if (icon) {
                const im = new Gtk.Image({icon_name: icon});
                im.set_pixel_size(16);
                row.append(im);
            }
            const lb = new Gtk.Label({label});
            lb.set_xalign(0);
            lb.set_hexpand(true);
            row.append(lb);
            if (checked !== null) {
                // mode rows carry a checkmark, iOS settings style
                row.append(new Gtk.Image({icon_name: 'object-select-symbolic',
                                          visible: !!checked}));
            }
            b.set_child(row);
            b.connect('clicked', () => {
                this._wlMenu.popdown();
                fn();
            });
            box.append(b);
        };
        if (wl)
            item('document-edit-symbolic',
                `Rename “${wl.name || wl.id}”`, () => this._renameList(wl.id));
        box.append(new Gtk.Separator({margin_top: 4, margin_bottom: 4}));
        // the MODE, spelled out as its own item with a live checkmark
        item('edit-delete-symbolic', 'Organize tickers',
            () => this._setEditMode(!this._editMode), this._editMode);
        // — sparkline window, its own section: the sidebar rows'
        // sparklines re-shape the moment the key lands (existing
        // watcher re-kicks the quote round). No 7d in the spark
        // dialect — 5d IS the trading week (~7 calendar days).
        box.append(new Gtk.Separator({margin_top: 4, margin_bottom: 4}));
        box.append(new Gtk.Label({label: 'Sparkline window',
                                  css_classes: ['caption', 'dim-label'],
                                  xalign: 0, margin_start: 4,
                                  halign: Gtk.Align.START}));
        const cur = this._settings.get_string('spark-range');
        const sparkSec = (id, label) => item(null, label,
            // activate(), NOT set_state(): set_state on a stateful
            // action is the quiet display-update — it never emits
            // change-state, so the handler that writes the setting
            // (and re-kicks the quote round) never ran. activate
            // with a target is exactly what a menu radio does.
            () => this._sparkAction?.activate(
                new GLib.Variant('s', id)),
            cur === id);
        sparkSec('1d', '1 day');
        sparkSec('5d', '5 days');
        sparkSec('1mo', '1 month');
        sparkSec('6mo', '6 months');
        this._wlMenu.set_child(box);
    }

    _populateAddMenu() {
        const sym = this._hero();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 2,
        });
        box.set_margin_top(6);
        box.set_margin_bottom(6);
        box.set_margin_start(6);
        box.set_margin_end(6);
        const item = (label, fn) => {
            const b = new Gtk.Button({
                label, css_classes: ['flat'], hexpand: true,
            });
            try {
                b.set_halign(Gtk.Align.FILL);
                const l = b.get_child();
                if (l && l.set_xalign)
                    l.set_xalign(0);
            } catch (e) { /* alignment is polish */ }
            b.connect('clicked', () => {
                this._addMenuPop.popdown();
                fn();
            });
            box.append(b);
        };
        if (sym) {
            for (const w of this._lists()) {
                if (!w.symbols.includes(sym))
                    item(`Add to ${w.name || w.id}`,
                        () => this._addSymbolTo(sym, w.id));
            }
            item('Copy symbol', () => {
                this.clipboard.set_text(sym, -1);
                this._toast(`${sym} copied`);
            });
        }
        this._addMenuPop.set_child(box);
    }

    _addSymbol(symbol) {
        // the hero's “+ Watchlist” button (and nothing else) commits a
        // previewed symbol to the active list
        const lists = this._lists();
        const wl = this._activeList(lists);
        log(`TickerGlass: _addSymbol ${symbol} wl=${wl?.id} ` +
            `have=${wl?.symbols?.includes(symbol)}`);
        if (!wl)
            return;
        if (!wl.symbols.includes(symbol)) {
            wl.symbols.push(symbol);
            this._writeLists(lists);
            this._toast(`${symbol} added to ${wl.name}`);
        }
        if (this._preview?.sym === symbol) {
            const p = this._preview;
            this._preview = null;     // real now; the button hides itself
            // The bridge must exist even when add lands before the
            // preview's history fetch filled _previewQ (fast clicks):
            // without it, name/symbol blank for seconds — synthesize a
            // name-only stand-in; real data supersedes it on arrival.
            if (this._previewQ?.symbol !== symbol)
                this._previewQ = {
                    symbol, name: p.name || symbol,
                    price: null, prevClose: null, currency: 'USD',
                    state: '', exchange: p.exchange ?? '',
                    volume: null, change: null, changePct: null,
                    spark: null, error: null,
                };
        }
        const was = this._settings.get_string('selected-symbol');
        this._selectSymbol(symbol);
        if (was === symbol)
            this._updateHero();
    }

    _removeSymbol(symbol) {
        const lists = this._lists();
        const wl = this._activeList(lists);
        if (!wl)
            return;
        wl.symbols = wl.symbols.filter(s => s !== symbol);
        this._writeLists(lists);
        this._toast(`${symbol} removed`);
    }

    /* right-click "move to list": param encodes SYMBOL\tLIST_ID (a tab
     * can appear in neither a ticker nor a generated list id). Source is
     * whichever list actually holds the symbol — the menu may open from
     * the table for a symbol the sidebar already dropped. */
    _moveSymbol(enc) {
        const [symbol, targetId] = String(enc).split('\t');
        const lists = this._lists();
        const to = lists.find(w => w.id === targetId);
        if (!to || symbol === undefined)
            return;
        let moved = false;
        for (const w of lists) {
            if (w === to)
                continue;
            if (w.symbols.includes(symbol)) {
                w.symbols = w.symbols.filter(s => s !== symbol);
                moved = true;
            }
        }
        if (!to.symbols.includes(symbol)) {
            to.symbols.push(symbol);
            moved = true;
        }
        if (!moved)
            return;
        this._writeLists(lists);
        this._toast(`${symbol} → ${to.name || 'list'}`);
    }

    /* ── search dialog ────────────────────────────────────────────────── */

    /* autocomplete lives in a popover anchored to the header SearchEntry;
     * the search machinery (debounce, placeholder row, raw-text fallback)
     * is the same that served the old modal dialog */
    _buildSearchPopover(entry) {
        const pop = new Gtk.Popover({autohide: true});
        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 120, max_content_height: 340,
            propagate_natural_height: true,
        });
        const results = new Gtk.ListBox();
        results.add_css_class('boxed-list');
        results.set_activate_on_single_click(true);
        scroller.set_child(results);
        pop.set_child(scroller);
        pop.set_size_request(380, -1);
        // (no Gtk.SearchEntry.set_popover on this GTK build: parent it by
        // hand and drop it under the entry)
        pop.set_parent(entry);
        pop.set_position(Gtk.PositionType.BOTTOM);
        this._searchPop = pop;
        entry.connect('notify::has-focus', () => {
            if (!entry.is_focus())
                pop.popdown();
        });

        let seq = 0;
        let pending = 0;
        let lastRes = [];        // latest results, for Enter
        const finish = () => {
            pop.popdown();
            entry.set_text('');
        };
        const populate = (items) => {
            lastRes = items;
            for (let r = results.get_first_child(); r;) {
                const next = r.get_next_sibling();
                results.remove(r);
                r = next;
            }
            for (const it of items) {
                const row = new Adw.ActionRow({
                    title: it.symbol, subtitle: it.name,
                });
                if (it.pending) {          // 'Searching…' placeholder
                    row.set_activatable(false);
                    results.append(row);
                    continue;
                }
                row.add_suffix(new Gtk.Label({
                    label: it.exchange || it.type || '',
                    css_classes: ['dim-label', 'caption'],
                    valign: Gtk.Align.CENTER,
                }));
                row._add = () => {
                    log(`TickerGlass: search row picked ${it.symbol}`);
                    // look first, persist only via the hero's + Watchlist
                    this._showSymbol(it.symbol, it);
                    finish();
                };
                row.connect('activated', row._add);
                // GtkGestureClick has pressed/released/cancelled — there
                // is no 'clicked' signal; see commit 9744c51
                const click = new Gtk.GestureClick();
                click.connect('released', () => {
                    if (row.contains_pointer ?? true)
                        row._add();
                });
                row.add_controller(click);
                results.append(row);
            }
            if (items.some(it => !it.pending))
                pop.popup();
        };
        const runSearch = (text) => {
            const mySeq = ++seq;
            const sym = text.trim().toUpperCase();
            if (!sym) { populate([]); return; }
            populate([{symbol: '…',
                       name: `Searching “${text}” …`,
                       exchange: '', type: '', pending: true}]);
            this._client.search(sym).then(res => {
                log(`TG search ok: ${res?.length} for ${sym}`);
                if (mySeq !== seq || this._dead)
                    return;
                const extra = {symbol: sym,
                               name: 'Add this symbol directly',
                               exchange: '', type: ''};
                populate([...(res ?? []), extra]);
            }).catch(e => {
                log(`TG search fail: ${sym} ${e.message}`);
                if (!this._dead)
                    populate([{symbol: sym,
                               name: 'Add this symbol directly'}]);
            });
        };
        entry.connect('search-changed', () => {
            if (pending)
                GLib.source_remove(pending);
            pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                pending = 0;
                runSearch(entry.get_text());
                return GLib.SOURCE_REMOVE;
            });
        });
        // the real pickable candidates, as opposed to the 'Searching…'
        // placeholder and the raw-text fallback row
        const isPickable = it =>
            !it.pending && it.name !== 'Add this symbol directly';
        const pickTop = () => {
            const typed = entry.get_text().trim().toUpperCase();
            // Enter accepts the top search result (typing "netflix" should
            // pick NFLX, not register a NETFLIX ticker); raw text is the
            // fallback for symbols the catalog didn't return
            const pick = lastRes.find(isPickable)?.symbol ?? typed;
            if (!pick)
                return false;
            this._showSymbol(pick, lastRes.find(isPickable) ?? {});
            finish();
            return true;
        };
        entry.connect('activate', () => pickTop());
        entry.connect('stop-search', () => {   // Escape in the entry
            pop.popdown();
            entry.set_text('');
        });

        // hooks for the TG_SEARCH smoke test (see constructor)
        entry._submit = pickTop;
        entry._hasResults = () => lastRes.some(isPickable);
        entry._clickFirst = () => {
            const r = results.get_row_at_index(0);
            log(`TickerGlass: TG_CLICK top row title=${r?.title}`);
            if (r)
                results.emit('row-activated', r);
        };
    }

    /* ── table ─────────────────────────────────────────────────────────── */

    _columnsSetting() {
        try {
            const c = JSON.parse(this._settings.get_string('columns'));
            if (Array.isArray(c?.visible))
                return c;
        } catch { /* redefault */ }
        return {visible: ['symbol', 'name', 'price', 'change', 'pct',
                          'day-range', 'volume'],
                sort: 'symbol', asc: true};
    }

    _setColumnVisible(key, on) {
        const cfg = this._columnsSetting();
        const set = new Set(cfg.visible);
        if (on)
            set.add(key);
        else
            set.delete(key);
        // canonical order, never empty
        cfg.visible = COLS.filter(c => set.has(c.key)).map(c => c.key);
        if (!cfg.visible.length)
            cfg.visible = ['symbol'];
        this._settings.set_string('columns', JSON.stringify(cfg));
    }

    _sortKey(key) {
        const c = this._columnsSetting();
        c.asc = c.sort === key ? !c.asc : true;
        c.sort = key;
        this._settings.set_string('columns', JSON.stringify(c));
    }

    _rebuildTable() {
        const cfg = this._columnsSetting();
        this._tableColumns = COLS.filter(d => cfg.visible.includes(d.key));

        // header: one clickable button per visible column → sorts
        for (let c = this._thead.get_first_child(); c;) {
            const next = c.get_next_sibling();
            this._thead.remove(c);
            c = next;
        }
        for (const def of this._tableColumns) {
            const b = new Gtk.Button({label: def.title});
            b.add_css_class('flat');
            b.add_css_class('tg-th');
            if (def.numeric)
                b.add_css_class('tg-th-num');
            if (def.key === cfg.sort)
                b.add_css_class('tg-th-active');
            if (def.key === 'name' || def.key === 'symbol')
                b.set_hexpand(true);
            b.connect('clicked', () => this._sortKey(def.key));
            this._thead.append(b);
        }
        this._syncColumnMenuState();
    }

    _showRowMenu(sym, parent, x, y) {
        const gdb = !!GLib.getenv('TG_GESTURE');
        const symbol = sym ?? this._hero();
        if (!symbol) {
            if (gdb)
                log('ROWMENU no symbol — ignored');
            return;
        }
        const lists = this._lists();
        const homes = lists.filter(w => w.symbols.includes(symbol));
        // Gtk.PopoverMenu refuses to paint in this GJS (present() ran,
        // zero pixels — same introspection gremlin family as
        // FileCreateFlags/set_translation): plain Popover + flat
        // buttons instead, the very mechanism the search autocomplete
        // uses, which has never failed to show.
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
        });
        box.set_margin_top(6);
        box.set_margin_bottom(6);
        box.set_margin_start(6);
        box.set_margin_end(6);
        // 'margin' is not a GTK4 property at all and Popover has no
        // 'child' construct property — both threw here before popup()
        // ever ran (the invisible-menu bug of this round)
        const pop = new Gtk.Popover({autohide: true});
        pop.set_child(box);
        pop.set_parent(parent ?? this._tableList);
        if (x !== undefined && y !== undefined) {
            const r = new Gdk.Rectangle();
            r.x = Math.round(x);
            r.y = Math.round(y);
            r.width = 1;
            r.height = 1;
            pop.set_pointing_to(r);
        }
        const item = (label, fn) => {
            const b = new Gtk.Button({
                label,
                css_classes: ['flat'],
                hexpand: true,
            });
            // buttons center their label; menus read left-aligned —
            // xalign is the knob that survives on the internal GtkLabel
            try {
                b.set_halign(Gtk.Align.FILL);
                const l = b.get_child();
                if (l && l.set_xalign)
                    l.set_xalign(0);
            } catch (e) { /* alignment is polish, not function */ }
            b.connect('clicked', () => {
                pop.popdown();
                fn();
            });
            box.append(b);
        };
        item('Details…', () => this._openDetails(symbol));
        item('Copy symbol', () => {
            this.clipboard.set_text(symbol, -1);
            this._toast(`${symbol} copied`);
        });
        for (const w of lists) {
            if (homes.includes(w))
                continue;
            item(`Move to ${w.name || w.id}`,
                () => this._moveSymbol(`${symbol}\t${w.id}`));
        }
        if (homes.length)
            item('Remove from watchlist', () => this._removeSymbol(symbol));
        this._menuHold = pop;
        pop.popup();
        if (gdb)
            log(`ROWMENU popped up for ${symbol}`);
    }

    _refreshTable() {
        if (!this._tableList)
            return;
        const _t = GLib.getenv('TG_TIMING')
            ? GLib.get_monotonic_time() : 0;
        const cfg = this._columnsSetting();
        const prop = SORT_PROP[cfg.sort] ?? 'sym';
        const numeric = prop.endsWith('-n');
        const active = this._activeList()?.symbols ?? [];
        const sorted = [...this._quotes]
            .filter(q => active.includes(q.symbol) &&
                (q.price != null || q.error))
            .map(q => ({q, item: new QuoteItem(q)}))
            .sort((a, b) => {
                const va = a.item[camel(prop)];
                const vb = b.item[camel(prop)];
                const r = numeric
                    ? (va < vb ? -1 : va > vb ? 1 : 0)
                    : String(va ?? '').localeCompare(String(vb ?? ''));
                return cfg.asc ? r : -r;
            });

        for (let r = this._tableList.get_first_child(); r;) {
            const next = r.get_next_sibling();
            this._tableList.remove(r);
            r = next;
        }
        const hero = this._hero();
        for (const {q, item} of sorted) {
            const row = new Gtk.ListBoxRow();
            row._sym = q.symbol;
            const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                     spacing: 12, margin_start: 10,
                                     margin_end: 10, margin_top: 4,
                                     margin_bottom: 4});
            for (const def of this._tableColumns ?? COLS) {
                const lbl = new Gtk.Label({
                    label: String(item[camel(def.prop)] ?? ''),
                    xalign: def.numeric ? 1 : 0,
                    ellipsize: def.numeric ? 0 : 3,     // Pango: NONE / END
                });
                if (def.key === 'name' || def.key === 'symbol')
                    lbl.set_hexpand(true);
                if (def.numeric)
                    lbl.add_css_class('numeric');
                if (def.color)
                    lbl.add_css_class(item.up ? 'tg-up' : 'tg-down');
                if (def.key === 'pct') {
                    // same chunky triangle as hero + sidebar; colour
                    // rides the container so the triangle inherits it
                    const tri = this._makeTri(11);
                    tri._up = !!item.up;
                    const cbox = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 5,
                        halign: def.numeric ? Gtk.Align.END
                                            : Gtk.Align.START,
                    });
                    cbox.add_css_class(item.up ? 'tg-up' : 'tg-down');
                    lbl.remove_css_class('tg-up');
                    lbl.remove_css_class('tg-down');
                    cbox.append(tri);
                    cbox.append(lbl);
                    box.append(cbox);
                    continue;
                }
                box.append(lbl);
            }
            row.set_child(box);
            this._tableList.append(row);
            if (q.symbol === hero)
                this._tableList.select_row(row);
        }
        if (_t)
            log(`TG table rebuild: ${sorted.length} rows in ` +
                `${((GLib.get_monotonic_time() - _t) / 1e3).toFixed(1)}ms`);
        this._refreshMovers();
    }

    /* keep the header chips honest: whichever page is up wears the
     * active pill (reader hides the whole row, so it never shows) */
    _updateNavChips() {
        if (!this._navChips)
            return;
        const movers = this._stack?.get_visible_child_name() === 'movers';
        this._navChips.watch.set_css_classes(
            movers ? ['tg-tab'] : ['tg-tab', 'tg-tab-active']);
        this._navChips.movers.set_css_classes(
            movers ? ['tg-tab', 'tg-tab-active'] : ['tg-tab']);
    }

    /* rebuild the movers dashboard from the in-memory quote map: the
     * watchlist round already fetched everything, so this view costs
     * zero extra network — only when it's actually on screen or a
     * round just landed (cheap at ≤ a few dozen symbols either way) */
    _refreshMovers() {
        if (!this._movLists)
            return;
        const scope = this._settings.get_string('movers-scope');
        for (const [v, b] of Object.entries(this._mvScopeChips))
            b.set_css_classes(['tg-chip'].concat(
                scope === v ? ['tg-chip-active'] : []));
        // market movers have one fixed window (the trading day) and no
        // sparklines at all — the window picker would be a lie there
        this._mvSparkBtn.set_visible(scope !== 'market');
        if (scope === 'market') {
            // fetch once, restale never: keep the last answer on screen
            // while the next one is in flight; refetch only while the
            // page is actually open, every 2 min at most
            const mv = this._mvMarket;
            const age = mv ? GLib.get_monotonic_time() / 1e6 - mv.stamp : 1e9;
            if (!mv || (age > 120 && !this._mvBusy &&
                        this._stack?.get_visible_child_name() === 'movers'))
                this._loadMarketMovers();
            this._movTitle.set_text("Today's Top Movers");
            this._movHeads.gain.set_text('Gainers');
            this._movHeads.lose.set_text('Losers');
            this._movSummary.set_text(
                mv?.gainers?.length
                    ? `US equities, all exchanges · ranked by today's ` +
                      `move · screened ${mv.at}`
                    : mv ? 'Screener unreachable — try the Yahoo data source'
                         : 'Fetching market movers…');
            this._fillMovers('gain',
                (mv?.gainers ?? []).filter(q => q.changePct != null)
                    .map(q => ({q, pct: q.changePct})),
                mv ? 'The screener came back quiet' : 'Fetching…');
            this._fillMovers('lose',
                (mv?.losers ?? []).filter(q => q.changePct != null)
                    .map(q => ({q, pct: q.changePct})),
                mv ? '' : 'Fetching…');
            return;
        }
        // My list: rank over the selected spark window. The quote round
        // fetches each spark AT that window, so the window's % is just
        // the spark's own endpoints — same-day move when the window is
        // 1D (the canonical changePct), no extra network otherwise.
        const win = this._settings.get_string('spark-range');
        const TITLE = {'1d': "Today's Top Movers",
                       '5d': '1 Week Top Movers',
                       '1mo': '1 Month Top Movers',
                       '6mo': '6 Month Top Movers'};
        this._movTitle.set_text(TITLE[win] ?? "Today's Top Movers");
        const wpct = q => {
            if (win === '1d')
                return q.changePct;
            const sp = q.spark;
            return sp?.length > 1 && sp[0]
                ? sp.at(-1) / sp[0] - 1 : q.changePct;
        };
        const syms = this._activeList()?.symbols ?? [];
        const rows = syms.map(s => this._quoteOf(s))
                         .filter(q => q && !q.error && q.price != null)
                         .map(q => ({q, pct: wpct(q)}))
                         .filter(r => r.pct != null);
        const up = rows.filter(r => r.pct > 0)
                       .sort((a, b) => b.pct - a.pct);
        const down = rows.filter(r => r.pct < 0)
                         .sort((a, b) => a.pct - b.pct);
        const state = (this._quoteOf(this._hero()) ?? rows[0]?.q)?.state;
        const ses = win === '1d'
            ? (state === 'POST' ? 'After-hours '
               : state === 'PRE' ? 'Pre-market ' : '')
            : '';
        this._movHeads.gain.set_text(`${ses}Gainers`);
        this._movHeads.lose.set_text(`${ses}Losers`);
        const flat = rows.length - up.length - down.length;
        this._movSummary.set_text(rows.length
            ? `${rows.length} tracked · ${up.length} gaining · ` +
              `${down.length} losing` + (flat ? ` · ${flat} flat` : '')
            : 'Waiting for quotes…');
        this._fillMovers('gain', up,
            rows.length ? 'Nothing in the green for this window' : '');
        this._fillMovers('lose', down,
            rows.length ? 'No decliners for this window' : '');
    }

    /* whole-market movers: Yahoo's predefined screeners, one request
     * per direction, crumb bootstrapped inside the client. The Nasdaq
     * source routes these to its Yahoo fallback (direct-then-relay) —
     * the screener is the one dataset Nasdaq's site API won't hand
     * out keylessly */
    async _loadMarketMovers() {
        if (this._mvBusy || this._dead)
            return;
        this._mvBusy = true;
        try {
            // one hub key, TTL = the 120s policy _refreshMovers already
            // applies — a concurrent (or storm-retry) call now joins
            // this producer instead of double-tapping the screener
            const [g, l] = await this._fetcher.fetch(
                'movers:market',
                () => Promise.all([
                    this._client.screener('day_gainers', 12),
                    this._client.screener('day_losers', 12),
                ]),
                {ttl: 120});
            if (this._dead)
                return;
            const now = GLib.DateTime.new_now_local();
            log(`TickerGlass: market movers ${g.length} up / ${l.length} down`);
            this._mvMarket = {
                gainers: g, losers: l,
                at: now ? now.format('%H:%M') : '',
                stamp: GLib.get_monotonic_time() / 1e6,
            };
        } catch (e) {
            log(`TickerGlass: market movers failed: ${e.message}`);
            // record the attempt: an empty answer is still an answer —
            // without it every table flush would re-hit a dead screener
            this._mvMarket ??= {gainers: [], losers: [], at: '', stamp: 0};
        } finally {
            this._mvBusy = false;
        }
        this._refreshMovers();
    }

    _updateSparkBtn() {
        if (!this._mvSparkBtn)
            return;
        const L = {'1d': '1D', '5d': '1W', '1mo': '1M', '6mo': '6M'};
        const r = this._settings.get_string('spark-range');
        this._mvSparkBtn.set_label(`Spark ${L[r] ?? r}`);
    }

    _fillMovers(key, rows, emptyText) {
        const fb = this._movLists[key];
        let c = fb.get_last_child();
        while (c !== null) {
            fb.remove(c);
            c = fb.get_last_child();
        }
        for (const {q, pct} of rows.slice(0, 12)) {
            fb.insert(this._moversTile(q, pct), -1);
            // the card is decoration, not a focus stop — the tile's
            // click handler is the interaction, and a focused/selected
            // FlowBoxChild paints a halo no ancestor rule reaches
            let fc = fb.get_last_child();
            if (fc && !(fc instanceof Gtk.FlowBoxChild) && fc.get_last_child)
                fc = fc.get_last_child();   // internal box, if this GTK nests
            if (fc) {
                fc.set_can_focus(false);
                fc.add_css_class('tg-flowcell');
            }
        }
        const ph = this._movEmpties[key];
        ph.set_text(emptyText);
        ph.set_visible(!rows.length && !!emptyText);
    }

    /* one dashboard tile: symbol + pct up top, name, price, and the
     * window's shape across the full tile width. `pct` is the same
     * number the ranking used — tile and sort order never disagree */
    _moversTile(q, pct) {
        const shown = pct ?? q.changePct ?? 0;
        const t = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                               spacing: 6, css_classes: ['tg-tile']});
        t._sym = q.symbol;
        t._name = q.name ?? q.symbol;
        const head = new Gtk.Box({spacing: 8});
        const symL = new Gtk.Label({label: q.symbol});
        symL.add_css_class('tg-row-sym');
        head.append(symL);
        const spacer = new Gtk.Box();
        spacer.set_hexpand(true);
        head.append(spacer);
        const pill = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                  spacing: 4});
        pill.add_css_class(shown >= 0 ? 'tg-up' : 'tg-down');
        const tri = this._makeTri(10);
        tri._up = shown >= 0;
        pill.append(tri);
        const pctL = new Gtk.Label({label: fmtPct(Math.abs(shown)),
                                    css_classes: ['numeric']});
        pctL.add_css_class('heading');
        pill.append(pctL);
        head.append(pill);
        t.append(head);
        const nameL = new Gtk.Label({label: q.name || q.symbol, xalign: 0,
                                     ellipsize: 3, max_width_chars: 18,
                                     css_classes: ['dim-label', 'caption']});
        t.append(nameL);
        const priceL = new Gtk.Label({label: fmtPrice(q.price, q.currency),
                                      xalign: 0,
                                      css_classes: ['numeric', 'title-3']});
        t.append(priceL);
        if (q.spark?.length > 1) {
            const sp = new Gtk.DrawingArea({content_width: 150,
                                            content_height: 34,
                                            hexpand: true,
                                            valign: Gtk.Align.END});
            const vals = q.spark;
            sp.set_draw_func((a, cr, w, h) =>
                paintMiniSpark(cr, {w, h, values: vals, up: shown >= 0}));
            t.append(sp);
        }
        t.set_size_request(178, -1);
        return t;
    }

    /* ── data flow ────────────────────────────────────────────────────── */

    _hero() {
        // a previewed symbol (search-selected, not added to the list)
        // stays the hero until the user adds it or moves on
        const sel = this._settings.get_string('selected-symbol');
        const syms = this._activeList()?.symbols ?? [];
        if (sel && (sel === this._preview?.sym || syms.includes(sel)))
            return sel;
        return syms[0] ?? '';
    }

    isPreview() {
        const sym = this._hero();
        return !!this._preview && this._preview.sym === sym &&
            !(this._activeList()?.symbols ?? []).includes(sym);
    }

    /* make `symbol` the hero WITHOUT touching the watchlist; `info` is the
     * catalog row ({name, exchange}) so the hero paints a name instantly */
    _showSymbol(symbol, info = {}) {
        const inList =
            (this._activeList()?.symbols ?? []).includes(symbol);
        this._preview = inList ? null
            : {sym: symbol, name: info.name ?? '',
               exchange: info.exchange ?? ''};
        this._previewQ = null;
        const was = this._settings.get_string('selected-symbol');
        this._selectSymbol(symbol);
        if (was === symbol) {        // no settings-change signal will come
            this._updateHero();
            this._loadHistory();
            this._loadNews(symbol);
        }
    }

    _selectSymbol(sym) {
        // clicking a row anywhere jumps to the full history view
        this._stack?.set_visible_child_name('chart');
        this._settings.set_string('selected-symbol', sym);
    }

    _refresh(manual = false) {
        if (this._busy) {
            // don't drop the request: an add/remove landing mid-fetch must
            // still repaint once the in-flight round ends
            this._queued = true;
            // belt over suspenders: the client-side request deadlines
            // should make this unreachable, but a stuck _busy must never
            // become a permanent freeze
            const stalled = this._busySince &&
                GLib.get_monotonic_time() / 1e6 - this._busySince > 120;
            if (!stalled)
                return;
            log('TickerGlass: fetch stalled >120s — recovering');
            this._busy = false;
            this._setSpinner(false);
        }
        const syms = this._activeList()?.symbols ?? [];
        // a previewed hero gets its own quote too, so the panel keeps
        // ticking while it's just on loan from the search results
        const prev = this._preview?.sym && !syms.includes(this._preview.sym)
            ? [this._preview.sym] : [];
        if (!syms.length && !prev.length) {
            this._quotes = [];
            this._refreshTable();
            this._updateHero();
            this._setStatus('Nothing to show — add symbols with “/”');
            return;
        }
        const wait = this._client.retryIn();
        if (wait > 0) {
            this._setStatus(`Rate limited by Yahoo — retry in ${wait}s`);
            return;
        }
        this._busy = true;
        this._busySince = GLib.get_monotonic_time() / 1e6;
        this._setSpinner(true);
        // ttl 0: a round must always hit the network (that's what a
        // round IS) — the fetcher's job here is the in-flight dedup
        // (watcher storms used to be serialised by _busy alone) and
        // giving every surface one key to reason about
        this._fetcher.fetch(
            `quotes:${syms.slice().sort().join(',')}:${
                this._settings.get_string('spark-range')}`,
            () => this._client.quotes([...syms, ...prev],
                                      {sparkRange:
                                       this._settings.get_string(
                                           'spark-range'),
                                       onQuote: q =>
                                           this._partialQuote(q)}),
            {ttl: 0})
            .then(res => {
                if (this._dead)
                    return;
                if (GLib.getenv('TG_TIMING'))
                    log(`TG t=${(GLib.get_monotonic_time() / 1e6
                                  - this._t0).toFixed(1)}s quotes round done`
                          + ` (${res.quotes.length} symbols)`);
                this._quotes = res.quotes;
                // same bridge rule after a wholesale replace: if the
                // previewed symbol's real quote is in the set, retire it
                if (this._previewQ && res.quotes.some(
                        x => x.symbol === this._previewQ.symbol
                             && x.price != null))
                    this._previewQ = null;
                this._atWall = Math.floor(GLib.get_real_time() / 1e6);
                this._busy = false;
                this._busySince = 0;
                this._setSpinner(false);
                // final pass wins over any debounced partial rebuild
                if (this._tablePend) {
                    GLib.source_remove(this._tablePend);
                    this._tablePend = 0;
                }
                this._refreshTable();
                this._updateWatchRows();
                this._updateHero();
                // pull the hero's chart as soon as quotes land (don't wait
                // for the next refresh tick to paint something)
                if (this._hist?.symbol !== this._hero())
                    this._loadHistory();
                this._setStatus(
                    `${sourceLabel(this._settings.get_string('data-source'))} · updated ` +
                    new Date(this._atWall * 1000)
                        .toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
                if (manual)
                    this._toast('Quotes refreshed');
                this._drainRefresh();
            })
            .catch(e => {
                if (this._dead)
                    return;
                logError(e, 'TickerGlass app');
                this._busy = false;
                this._busySince = 0;
                this._setSpinner(false);
                this._setStatus(`Fetch failed: ${e.message}`);
                this._drainRefresh();
            });
    }

    _drainRefresh() {
        if (this._queued && !this._busy && !this._dead) {
            this._queued = false;
            this._refresh();
        }
    }

    /* incremental paint during a quotes round: one row lands, one row
     * paints — the watchlist shouldn't sit blank while the relay's slow
     * crypto leg dribbles in. The round's final pass still replaces the
     * whole set (adding error rows and the back-fetched ones). */
    _partialQuote(q) {
        if (this._dead)
            return;
        if (GLib.getenv('TG_TIMING'))
            log(`TG t=${(GLib.get_monotonic_time() / 1e6
                          - this._t0).toFixed(1)}s quote ${q.symbol}`);
        const i = this._quotes.findIndex(x => x.symbol === q.symbol);
        if (i >= 0)
            this._quotes[i] = q;
        else
            this._quotes.push(q);
        // the first real quote supersedes the add-bridge preview data
        if (this._previewQ?.symbol === q.symbol && q.price != null)
            this._previewQ = null;
        // measured: a full table rebuild costs ~8ms at 11 symbols, and
        // quotes arrive faster than that — rebuild once per burst instead
        // of once per quote (the round-done pass flushes the pending one)
        if (!this._tablePend)
            this._tablePend = GLib.timeout_add(GLib.PRIORITY_LOW, 250, () => {
                this._tablePend = 0;
                if (!this._dead)
                    this._refreshTable();
                return GLib.SOURCE_REMOVE;
            });
        this._updateWatchRows(q.symbol);
        if (q.symbol === this._hero())
            this._updateHero();
    }

    /* targeted quote round for symbols just added to the active list:
     * existing rows stay untouched, only the new ticker crosses the
     * network, the hero and its chart are never reloaded */
    _fetchAdded(syms) {
        if (this._busy) {
            // an in-flight full round already fetches the pre-add set;
            // re-queue so it runs again over the post-add one
            this._queued = true;
            return;
        }
        this._setSpinner(true);
        this._fetcher.fetch(
            `quotes:${syms.slice().sort().join(',')}:1mo`,
            () => this._client.quotes(syms,
                                      {sparkRange: '1mo',
                                       onQuote: q =>
                                           this._partialQuote(q)}),
            {ttl: 0})
            .then(res => {
                if (this._dead)
                    return;
                for (const q of res.quotes) {
                    const i = this._quotes.findIndex(
                        x => x.symbol === q.symbol);
                    if (i >= 0)
                        this._quotes[i] = q;
                    else
                        this._quotes.push(q);
                }
                this._setSpinner(false);
                if (this._tablePend) {
                    GLib.source_remove(this._tablePend);
                    this._tablePend = 0;
                }
                this._refreshTable();
                this._updateWatchRows();
                if (syms.includes(this._hero()))
                    this._updateHero();
            })
            .catch(e => {
                if (this._dead)
                    return;
                logError(e, 'TickerGlass app');
                this._setSpinner(false);
                this._refresh(true);   // fall back to the full round
            });
    }

    async _loadHistory() {
        const sym = this._hero();
        if (!sym)
            return;
        const range = this._settings.get_string('chart-range');
        const iv = this._settings.get_string('chart-interval');
        // dedup: the boot kick races the quotes-landed hook — two fetches
        // of the same key would only make each other redundant
        const key = `${sym}|${range}|${iv}`;
        if (this._histKey === key)
            return;
        this._histKey = key;
        try {
            // hub: 60s TTL lets the compare chart reuse the hero's
            // fetch (and vice versa) — they used to hit the endpoint
            // twice for the same sym|range|interval
            const hist = await this._fetcher.fetch(
                `hist:${key}`, () => this._client.history(sym, range, iv),
                {ttl: 60});
            if (this._dead || this._hero() !== sym ||
                this._settings.get_string('chart-range') !== range)
                return;
            this._hist = hist;
            // a previewed symbol has no watchlist quote row yet; borrow
            // the history's meta so price/chips/pill still paint
            if (this.isPreview() &&
                !this._quotes.find(x => x.symbol === sym)) {
                const m = hist.meta ?? {};
                const chg = m.price != null && m.prevClose != null
                    ? m.price - m.prevClose : null;
                // changePct is a FRACTION app-wide (fmtPct multiplies by
                // 100); and a borrowed change can be garbage (Nasdaq's
                // fallback daily row vs last-sale can be weeks apart) —
                // never paint a percent the quote can't back up
                const pct = chg != null && m.prevClose
                    ? chg / m.prevClose : null;
                const sane = pct == null || Math.abs(pct) <= 0.6;
                this._previewQ = {
                    symbol: sym, name: this._preview?.name || sym,
                    price: m.price, prevClose: sane ? m.prevClose : null,
                    currency: m.currency ?? 'USD', state: m.state ?? '',
                    exchange: m.exchange ?? '', volume: m.volume,
                    change: sane ? chg : null,
                    changePct: sane ? pct : null,
                    spark: null, error: null,
                };
            }
            this._startDrawIn();
            if (GLib.getenv('TG_TIMING'))
                log(`TG t=${(GLib.get_monotonic_time() / 1e6
                              - this._t0).toFixed(1)}s history ${sym} `
                      + `${range} (${hist.points.length} pts)`);
            this._ivBtn.set_label(INTERVAL_LABEL[hist.interval] ?? hist.interval);
            this._updateHero();
            this._loadCompare();
        } catch (e) {
            logError(e, 'TickerGlass app');
            if (this._histKey === key)
                this._histKey = null;      // failed key must be retryable
            if (!this._dead && this._hero() === sym) {
                if (this.isPreview()) {
                    // nothing answers for this symbol: drop the preview,
                    // say so, and hand the hero back to the list
                    this._preview = null;
                    this._previewQ = null;
                    this._toast(`No market data for ${sym}`);
                    this._selectSymbol(
                        this._activeList()?.symbols?.[0] ?? '');
                    return;
                }
                this._hist = null;
                this._chart.queue_draw();
            }
        }
    }

    /* benchmark overlay: fetch the compare symbol's history over the
     * same range/interval; _drawChart normalizes it into the primary's
     * price space (both share the first point = 0% move) */
    async _loadCompare() {
        const sym = this._settings.get_string('compare-symbol');
        const hero = this._hero();
        if (!sym || sym === hero) {
            this._cmpHist = null;
            this._cmpKey = null;
            this._chart.queue_draw();
            this._updateCmpChip();
            return;
        }
        const range = this._settings.get_string('chart-range');
        const iv = this._settings.get_string('chart-interval');
        const key = `${sym}|${range}|${iv}`;
        if (this._cmpKey === key)
            return;
        this._cmpKey = key;
        try {
            const hist = await this._fetcher.fetch(
                `hist:${key}`, () => this._client.history(sym, range, iv),
                {ttl: 60});
            if (this._dead || this._cmpKey !== key ||
                this._settings.get_string('compare-symbol') !== sym)
                return;
            this._cmpHist = hist;
            this._chart.queue_draw();
            this._updateCmpChip();
            if (GLib.getenv('TG_TIMING'))
                log(`TG cmp ${sym} ${range} (${hist.points.length} pts)`);
        } catch (e) {
            log(`TG cmp ${sym} failed: ${e.message}`);
            if (this._cmpKey === key)
                this._cmpKey = null;      // retryable
            this._cmpHist = null;
            this._chart.queue_draw();
            this._updateCmpChip();
        }
    }

    /* the style button mirrors what the canvas actually draws: an
     * active comparison forces area→line at paint time, and the label
     * says so rather than advertising a fill the user can't see */
    _syncStyleBtn() {
        const style = this._settings.get_string('chart-style');
        const cmpSym = this._settings.get_string('compare-symbol');
        const cmpOn = !!this._cmpHist &&
            this._cmpHist.range === this._hist?.range &&
            cmpSym && cmpSym !== this._hero();
        const eff = (cmpOn && style === 'area') ? 'line' : style;
        const L = {area: 'Area', line: 'Line', candles: 'Candles'};
        this._styleBtn.set_label(L[eff] ?? 'Area');
    }

    _updateCmpChip() {
        const sym = this._settings.get_string('compare-symbol');
        if (!sym || sym === this._hero()) {
            this._cmpBtn.set_label('vs Off');
            this._cmpBtn.set_tooltip_text('Compare against');
            this._syncStyleBtn();
            return;
        }
        // window move of the benchmark, straight from its own series
        const pts = this._cmpHist?.points;
        let pct = null;
        if (pts?.length > 1 && pts[0].c)
            pct = (pts.at(-1).c / pts[0].c - 1) * 100;
        this._cmpBtn.set_label(
            pct == null ? `vs ${sym}`
                        : `vs ${sym} ${fmtPct(pct / 100)}`);
        this._cmpBtn.set_tooltip_text(
            `Overlay ${sym}, normalized to ${this._hero()}'s first point`);
        this._syncStyleBtn();
    }

    /* ── news ─────────────────────────────────────────────────────────── */

    async _loadNews(sym) {
        const list = this._newsList;
        if (!list)
            return;
        for (let r = list.get_first_child(); r;) {
            const next = r.get_next_sibling();
            list.remove(r);
            r = next;
        }
        this._newsCount.set_text('');
        this._newsEmpty.set_text(sym ? `Loading news for ${sym}…` : '');
        const items = sym ? await this._client.news(sym) : [];
        if (this._dead || this._newsFor !== sym)
            return;
        this._newsCount.set_text(items.length ? `· ${items.length}` : '');
        this._newsEmpty.set_text(sym ? `No recent news for ${sym}` : '');
        for (const n of items) {
            const row = new Gtk.ListBoxRow();
            row._url = n.url;
            row._title = n.title;
            const line = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                      spacing: 10, margin_start: 12,
                                      margin_end: 12, margin_top: 8,
                                      margin_bottom: 8});
            // site icon: favicon when known, letter avatar meanwhile
            const av = new Gtk.DrawingArea();
            av.set_content_width(20);
            av.set_content_height(20);
            av.set_valign(Gtk.Align.CENTER);
            av._host = hostOf(n.url);
            av._letter = ((n.source || av._host || '?').trim()[0] ?? '?')
                .toUpperCase();
            av.set_draw_func(paintFav);
            favAttach(av);
            line.append(av);
            const txt = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                     spacing: 2, hexpand: true});
            const title = new Gtk.Label({label: n.title, xalign: 0,
                                         wrap: true, ellipsize: 3});
            title.set_lines(2);
            title.add_css_class('tg-news-title');
            txt.append(title);
            const sub = new Gtk.Label({
                label: [n.source, relTime(n.at)].filter(Boolean).join('  ·  '),
                xalign: 0, css_classes: ['dim-label', 'caption']});
            txt.append(sub);
            line.append(txt);
            row.set_child(line);
            list.append(row);
        }
    }

    _openUrl(url) {
        try {
            const p = this._launcher.launch(url, this);
            if (p?.catch)
                p.catch(() => this._toast('Couldn’t open link'));
        } catch {
            this._toast(`Couldn’t open ${url}`);
        }
    }

    /* news reader: article opens as a page INSIDE the window (stack page
     * 'reader'); the “← Ticker” pill or Escape returns to the chart.
     * Falls back to the system browser when webkitgtk isn't installed */
    async _openReader(url, title) {
        try {
            await this._openReaderInner(url, title);
        } catch (e) {
            logError(e, 'TickerGlass news reader');
            this._openUrl(url);
        }
    }

    async _openReaderInner(url, title) {
        if (!this._readerWeb) {
            let WebKit = null;
            // dynamic gi imports land on .default; try newest WebKitGTK first
            for (const v of ['6.0', '5.0', '4.1']) {
                try {
                    const mod = await import(`gi://WebKit?version=${v}`);
                    const W = mod.default ?? mod;
                    if (W?.WebView) {
                        WebKit = W;
                        break;
                    }
                } catch { /* next */ }
            }
            if (!WebKit) {
                this._openUrl(url);
                return;
            }
            // full-bleed page; all controls live in the morphed header bar
            const web = new WebKit.WebView();
            web.set_vexpand(true);
            // add_titled (not add_child): GJS binds add_child to the
            // 1-arg GtkWidget method and drops the name. Harmless here —
            // the Chart/Table toggles are manual buttons, not a ViewSwitcher
            this._stack.add_titled(web, 'reader', 'Reader');
            this._readerWeb = web;
        }
        this._readTitle.set_label(title ?? 'Story');
        this._readerWeb.load_uri(url);
        this._stack.set_visible_child_name('reader');
    }

    _leaveReader() {
        if (this._stack.get_visible_child_name() !== 'reader')
            return;
        this._readerWeb?.load_uri('about:blank');   // stop + free the page
        this._stack.set_visible_child_name('chart');
    }

    _startDrawIn() {
        if (this._morphId)
            GLib.source_remove(this._morphId);
        this._progress = 0;
        const t0 = GLib.get_monotonic_time();
        this._morphId = GLib.timeout_add(GLib.PRIORITY_LOW, 20, () => {
            const k = (GLib.get_monotonic_time() - t0) / 1e6 / 0.55;
            this._progress = Math.min(1, k);
            this._chart.queue_draw();
            if (k >= 1) {
                this._morphId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _drawChart(cr, w, h) {
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const hist = this._hist;
        if (!hist?.points?.length) {
            drawCenteredHint(cr, w, h, this._styleManager ?
                this._styleManager.get_dark() : true,
                this._hero() ? 'Loading chart…' : 'Add symbols to get started');
            return;
        }
        const intraday = INTRADAY.has(hist.range);
        // rescale the benchmark into the primary's price space so both
        // lines share their first point (0% move) and the y-axis stays
        // honest in the hero's own currency
        let cmp = null;
        const cp = this._cmpHist?.range === hist.range
            ? this._cmpHist.points : null;
        if (cp?.length > 1 && hist.points[0]?.c && cp[0].c) {
            const p0 = hist.points[0].c, c0 = cp[0].c;
            cmp = {
                points: cp.map(p => ({t: p.t, c: p0 * (p.c / c0)})),
                // the gutter pill shows the benchmark's own price, not
                // the normalized value the line is drawn at
                endLabel: fmtPrice(cp.at(-1).c, hist.meta.currency),
            };
        }
        const xlab = t => intraday
            ? fmtTime(t, hist.meta.tz)
            : axisDate(t, (hist.points[hist.points.length - 1].t -
                           hist.points[0].t) / 86400);
        // two stacked area gradients read as mud: while a benchmark is
        // overlaid, the primary renders as a line regardless of the
        // saved style (the preference itself is untouched)
        const style = this._settings.get_string('chart-style');
        const mode = (cmp && style === 'area') ? 'line' : style;
        // hover bubble: both tickers' REAL price and window move at the
        // hovered instant (the overlay is normalized, the numbers are
        // not). Hero % follows the hero pill's baseline (prev-close on
        // 1d), benchmark % is its own first point — matching the line
        // shapes. paintChart tints the pills with each series' color.
        const cmpSym = this._settings.get_string('compare-symbol');
        const cursorFmt = (cmp && cmpSym) ? i => {
            const n0 = hist.points.length - 1;
            const p = hist.points[Math.max(0, Math.min(n0, i))];
            const j = Math.round(i / n0 * (cp.length - 1));
            const c = cp[Math.max(0, Math.min(cp.length - 1, j))];
            const cur = hist.meta.currency;
            const hBase = hist.range === '1d' && hist.meta.prevClose
                ? hist.meta.prevClose : hist.points[0].c;
            const seg = (sym, price, frac) => `${sym} ` +
                `${fmtPrice(price, cur)} ` +
                `${frac >= 0 ? '\u25B2' : '\u25BC'}${fmtPct(Math.abs(frac))}`;
            return {
                date: xlab(p.t),
                items: [
                    {text: seg(symbolShort(this._hero()), p.c,
                               p.c / hBase - 1)},
                    {text: seg(symbolShort(cmpSym), c.c,
                               c.c / cp[0].c - 1)},
                ],
            };
        } : null;
        paintChart(cr, {
            w, h,
            points: hist.points,
            mode,
            prevClose: hist.range === '1d' ? hist.meta.prevClose : null,
            dark: this._styleManager?.get_dark() ?? true,
            fmtY: v => fmtPrice(v, hist.meta.currency),
            fmtX: xlab,
            progress: this._progress,
            cursor: this._cursor,
            compare: cmp,
            cursorFmt,
        });
    }

    /* the header IS the ticker name now: big company name, quiet symbol
     * badge (the symbol stands in for the name until quotes land) */
    _repaintTitle() {
        const sym = this._hero();
        const q = this._quotes.find(x => x.symbol === sym)
            ?? (this._previewQ?.symbol === sym ? this._previewQ : null);
        const name = q
            ? (q.name !== q.symbol ? q.name : q.exchange ?? '')
            : (this.isPreview()
                ? [this._preview.name, this._preview.exchange]
                    .filter(Boolean).join(' · ')
                : '');
        if (!sym) {
            this._heroName.set_label('');
            this._heroSym.set_label('');
        } else if (name) {
            this._heroName.set_label(name);
            this._heroSym.set_label(symbolShort(sym));
        } else {
            this._heroName.set_label(symbolShort(sym));
            this._heroSym.set_label('');
        }
        this._heroSym.set_visible(!!this._heroSym.get_label());
        // taskbar/window-list identity follows the ticker, not the app;
        // blank (not 'TickerGlass') when no hero — XWayland paints the
        // WM title into the frame, which is exactly the app-title-in-
        // header the user asked to evict
        this.set_title(sym ? `${symbolShort(sym)} · TickerGlass`
                           : '');
    }

    _flipHeroValue() {
        this._heroMode = this._heroMode === 'pct' ? 'dollars' : 'pct';
        this._settings.set_string('change-style', this._heroMode);
        this._updateHero();
    }

    _updateHero() {
        const sym = this._hero();
        // no fallback to quotes[0]: painting another ticker's price under
        // the new hero symbol would lie until the refresh lands
        const q = this._quotes.find(x => x.symbol === sym)
            ?? (this._previewQ?.symbol === sym ? this._previewQ : null);
        const hist = this._hist;
        this._addBtn.set_visible(this.isPreview());
        // build the menu BEFORE the button shows: a popover populated
        // only at show-time measures zero and auto-hides instantly
        if (this.isPreview())
            this._populateAddMenu();
        this._addBtn.set_tooltip_text(
            `Add ${sym} to “${this._activeList()?.name ?? 'Watchlist'}”`);
        this._repaintTitle();
        if (sym !== this._newsFor) {
            this._newsFor = sym;
            this._loadNews(sym);
        }
        for (const [r, b] of Object.entries(this._rangeChips)) {
            b.set_css_classes(r === this._settings.get_string('chart-range')
                ? ['tg-chip', 'tg-chip-active'] : ['tg-chip']);
        }
        this._syncStyleBtn();
        this._ivBtn.set_label(
            INTERVAL_LABEL[hist?.interval] ?? 'Auto');

        if (!q) {
            this._heroPrice.set_label('');
            this._heroPillLbl.set_label('');
            renderChips(this._chips, []);
            return;
        }
        this._heroPrice.set_label(q.price != null
            ? fmtPrice(q.price, q.currency) : '—');
        // pill reflects the VISIBLE window, not just the day: on a 2Y
        // chart "+1.09%" would be the day's move wearing the range's clothes
        let chg = q.change ?? null, pct = q.changePct ?? null, tag = '';
        const pts = hist?.points;
        if (hist && hist.symbol === q.symbol && pts.length > 1) {
            const base = hist.range === '1d'
                ? (hist.meta?.prevClose ?? pts[0].c) : pts[0].c;
            if (base) {
                chg = pts[pts.length - 1].c - base;
                pct = chg / base;
                tag = hist.range === '1d'
                    ? '' : (RANGE_LABEL[hist.range] ?? '');
            }
        }
        const up = (chg ?? 0) >= 0;
        // price always shows; the pill carries either the dollar move or
        // the percentage move for the visible range (change-style)
        const showPct = this._heroMode === 'pct';
        this._heroPrice.set_visible(q.price != null);
        this._heroPill.set_visible(chg != null);
        this._heroPill.set_css_classes(['tg-pill', 'tg-hero-pct',
                                        up ? 'tg-up-soft' : 'tg-down-soft']);
        this._heroTri._up = up;
        this._heroTri.queue_draw();
        this._heroPillLbl.set_label(chg != null
            ? `${showPct ? fmtPct(pct) : fmtDelta(chg, q.currency)}${
                tag ? ` · ${tag}` : ''}`
            : '');
        this._heroPrice.set_css_classes(['tg-hero-price',
                                         chg != null ? (up ? 'tg-up' : 'tg-down') : '']);

        const m = hist?.meta ?? {};
        const stateTxt = {REGULAR: 'Market open', PRE: 'Pre-market',
                          POST: 'After-hours', CLOSED: 'Closed'}[q.state] ?? '';
        renderChips(this._chips, [
            stateTxt && [stateTxt, undefined],
            q.exchange && [q.exchange, undefined],
            m.open != null && ['Open', fmtPrice(m.open, q.currency)],
            m.dayHigh != null && ['High', fmtPrice(m.dayHigh, q.currency)],
            m.dayLow != null && ['Low', fmtPrice(m.dayLow, q.currency)],
            q.volume != null && ['Volume', fmtCompact(q.volume)],
            m.wk52High != null && ['52W High', fmtPrice(m.wk52High, q.currency)],
            m.wk52Low != null && ['52W Low', fmtPrice(m.wk52Low, q.currency)],
            q.prevClose != null && ['Prev Close', fmtPrice(q.prevClose, q.currency)],
            q.currency && [q.currency, undefined],
        ].filter(Boolean));
    }

    /* ── details / prefs / about dialogs ──────────────────────────────── */

    _openDetails(sym) {
        const q = this._quotes.find(x => x.symbol === sym);
        if (!q)
            return;
        const dlg = new Adw.Dialog({title: sym, can_close: true});
        const bin = new Adw.Bin();
        bin.add_css_class('dlg-pad');
        const clamp = new Adw.Clamp({maximum_size: 420});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                 spacing: 12});
        const grid = new Gtk.Grid({row_spacing: 6, column_spacing: 18});
        const rows = [
            ['Name', q.name ?? ''], ['Price', fmtPrice(q.price, q.currency)],
            ['Change', q.change != null ? fmtDelta(q.change, q.currency) : '—'],
            ['Change %', fmtPct(q.changePct)],
            ['Day range', q.dayLow != null && q.dayHigh != null
                ? `${fmtPrice(q.dayLow, q.currency)} – ${fmtPrice(q.dayHigh, q.currency)}` : '—'],
            ['52 weeks', q.wk52Low != null
                ? `${fmtPrice(q.wk52Low, q.currency)} – ${fmtPrice(q.wk52High, q.currency)}` : '—'],
            ['Volume', fmtCompact(q.volume)],
            ['Exchange', q.exchange ?? ''], ['Currency', q.currency ?? ''],
            ['Market state', q.state ?? ''],
            ['Symbol', q.symbol],
        ];
        rows.forEach(([k, v], i) => {
            const kl = new Gtk.Label({label: k, css_classes: ['dim-label'],
                                      xalign: 0});
            const vl = new Gtk.Label({label: String(v), xalign: 1,
                                      hexpand: true, selectable: true});
            grid.attach(kl, 0, i, 1, 1);
            grid.attach(vl, 1, i, 1, 1);
        });
        box.append(grid);
        const btns = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                  spacing: 8, halign: Gtk.Align.CENTER});
        const rm = new Gtk.Button({label: 'Remove from watchlist'});
        rm.add_css_class('destructive-action');
        rm.connect('clicked', () => { this._removeSymbol(sym); dlg.force_close(); });
        const ok = new Gtk.Button({label: 'Close', hexpand: true});
        ok.add_css_class('suggested-action');
        ok.connect('clicked', () => dlg.force_close());
        btns.append(rm);
        btns.append(ok);
        box.append(btns);
        clamp.set_child(box);
        bin.set_child(clamp);
        dlg.set_child(bin);
        dlg.present(this);
    }

    _openPrefsDialog() {
        const dlg = new Adw.PreferencesDialog();
        const page = new Adw.PreferencesPage();
        const g = new Adw.PreferencesGroup({title: 'Behaviour'});
        const src = new Adw.ComboRow({
            title: 'Data source',
            model: new Gtk.StringList({strings: ['Yahoo Finance',
                                                 'Yahoo via relay',
                                                 'Nasdaq (US stocks & ETFs)',
                                                 'Demo (offline)']}),
        });
        const srcIds = ['yahoo', 'yahoo-relay', 'nasdaq', 'demo'];
        src.set_selected(Math.max(0, srcIds.indexOf(
            this._settings.get_string('data-source'))));
        src.connect('notify::selected', () => this._settings.set_string(
            'data-source', srcIds[src.get_selected()] ?? 'yahoo'));
        g.add(src);
        const spin = new Adw.SpinRow.new_with_range(15, 3600, 15);
        spin.set_title('Refresh quotes every (seconds)');
        this._settings.bind('refresh-seconds', spin.get_adjustment(), 'value',
                            Gio.SettingsBindFlags.DEFAULT);
        g.add(spin);
        page.add(g);
        const g2 = new Adw.PreferencesGroup({title: 'Appearance'});
        const theme = new Adw.ComboRow({
            title: 'Color scheme',
            model: new Gtk.StringList({strings: ['Follow system', 'Light', 'Dark']}),
        });
        const themeIds = ['default', 'light', 'dark'];
        theme.set_selected(Math.max(0, themeIds.indexOf(
            this._settings.get_string('app-theme'))));
        theme.connect('notify::selected', () => this._settings.set_string(
            'app-theme', themeIds[theme.get_selected()] ?? 'default'));
        g2.add(theme);
        page.add(g2);
        const g3 = new Adw.PreferencesGroup({
            title: 'Watchlists',
            description: 'Watchlists are shared live with the GNOME Shell ' +
                         'extension (tickerglass@vijaybala.dev). Edit them ' +
                         'from the sidebar here or from the extension prefs.',
        });
        page.add(g3);
        dlg.add(page);
        dlg.present(this);
    }

    _openAbout() {
        const dlg = new Adw.AboutDialog({
            application_name: 'TickerGlass',
            application_icon: 'org.gnome.Desktop-symbolic',
            version: '0.1',
            developer_name: 'vijaybala',
            website: 'https://vijaybala.dev',
            license_type: Gtk.License.GPL_2_0,
            comments: 'Sparkline market watch — quotes by Yahoo Finance ' +
                'or Nasdaq. ' +
                      'Pairs live with the GNOME Shell extension of the ' +
                      'same name through a shared gsettings schema.',
        });
        dlg.present(this);
    }

    /* ── misc ─────────────────────────────────────────────────────────── */

    _applyTheme(mode) {
        const map = {
            default: Adw.ColorScheme.DEFAULT,
            light: Adw.ColorScheme.FORCE_LIGHT,
            dark: Adw.ColorScheme.FORCE_DARK,
        };
        this._styleManager.set_color_scheme(map[mode] ?? Adw.ColorScheme.DEFAULT);
    }

    _setStatus(text) {
        this._statusLbl.set_label(text);
    }

    _toast(text) {
        this._toasts.add_toast(new Adw.Toast({title: text, timeout: 2}));
    }

    _syncColumnMenuState() {
        const cfg = this._columnsSetting();
        const vis = new Set(cfg.visible);
        for (const [key, act] of Object.entries(this._colActions ?? {}))
            act.set_state(new GLib.Variant('b', vis.has(key)));
        if (this._sortKeyAction)
            this._sortKeyAction.set_state(new GLib.Variant('s', cfg.sort));
    }

    _onSetting(key) {
        switch (key) {
        case 'watchlists': {
            if (this._dragging) {
                // a fan-out landing mid-drag must not destroy the row
                // under the pointer — settle it at drag-end instead
                this._dragPending = true;
                break;
            }
            // incremental: adding a symbol must not refetch the 11 quotes
            // that are already fresh, drop the table, or reload the hero
            const after = this._activeList()?.symbols ?? [];
            const before = this._uiSymbols ?? [];
            const added = after.filter(s => !before.includes(s));
            const removed = before.filter(s => !after.includes(s));
            this._rebuildSidebar();
            if (removed.length)
                this._quotes = this._quotes.filter(
                    q => !removed.includes(q.symbol));
            if (added.length)
                this._fetchAdded(added);
            else if (removed.length) {
                // a removal needs no network — repaint from cached quotes
                if (this._tablePend) {
                    GLib.source_remove(this._tablePend);
                    this._tablePend = 0;
                }
                this._refreshTable();
                this._updateHero();
            }
            // rename / reorder / other lists' edits: sidebar rebuild above
            // is the whole story; the right panel is untouched
            break;
        }
        case 'active-watchlist':
            this._rebuildSidebar();
            this._refresh(true);
            this._loadHistory();
            break;
        case 'change-style':
            // external flips (prefs dialog, other window) re-sync mode
            this._heroMode = this._settings.get_string('change-style')
                || 'dollars';
            this._updateHero();
            break;
        case 'selected-symbol':
            this._updateHero();
            this._loadHistory();
            this._loadCompare();
            break;
        case 'chart-range':
        case 'chart-interval':
            this._updateHero();
            this._loadHistory();
            this._loadCompare();
            break;
        case 'compare-symbol': {
            // external flips (other window) re-sync the menu state too
            const s = this._settings.get_string('compare-symbol');
            this._cmpAction.set_state(new GLib.Variant('s', s || 'off'));
            this._loadCompare();
            break;
        }
        case 'spark-range':
            this._sparkAction?.set_state(new GLib.Variant('s',
                this._settings.get_string('spark-range')));
            this._updateSparkBtn();
            // sparklines ride the quote round — refetch it
            this._refresh(true);
            break;
        case 'movers-scope':
            this._refreshMovers();
            break;
        case 'chart-style':
            this._updateHero();
            this._chart.queue_draw();
            break;
        case 'columns':
            this._rebuildTable();
            this._refreshTable();
            break;
        case 'data-source':
            this._client.setSource(this._settings.get_string('data-source'));
            // cached answers belong to the OTHER provider — purge,
            // and drop the hist-dedup keys so the fetches below fire
            this._fetcher.invalidate();
            this._histKey = null;
            this._cmpKey = null;
            this._refresh(true);
            this._loadHistory();
            break;
        case 'refresh-seconds':
            this._restartTimer();
            break;
        case 'sidebar-visible':
            this._split.set_show_sidebar(
                this._settings.get_boolean('sidebar-visible'));
            break;
        case 'sidebar-width':
            this._sidePx = this._settings.get_int('sidebar-width');
            this._applySidebarWidth();
            break;
        }
    }

    /* pixels are the promise; OverlaySplitView takes a fraction, so
     * translate against the live split width — re-applied from the
     * content snapshot (a draw is always post-allocation, so that
     * single hook covers boot AND every window resize). set_property
     * rather than the dotted form so a wrong property name THROWS:
     * GJS expands unknown "properties" into silent no-op JS fields.
     * Verified live: sidebar-width-FRACTION is real; the newer
     * sidebar-width-unit does not alter the math. */
    _applySidebarWidth() {
        const total = this._split?.get_width() ?? 0;
        if (total < 1)                        // not allocated yet
            return;
        const target = this._sidePx / total;
        // (no get_property from GJS — shadow the last value we wrote)
        if (Math.abs(target - (this._frac ?? -1)) < 0.002)
            return;                           // steady state (~1px)
        this._frac = target;
        this._split.set_property('sidebar-width-fraction', target);
    }

    _restartTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        const secs = this._settings.get_int('refresh-seconds');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, secs, () => {
            this._timer = 0;
            this._refresh();
            this._loadHistory();
            return GLib.SOURCE_REMOVE;
        });
    }

    vfunc_close_request() {
        this._dead = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._morphId)
            GLib.source_remove(this._morphId);
        // persist the WATCHLIST preference, not Movers' transient
        // collapse (the notify handler keeps the setting in sync for
        // every non-movers state anyway)
        if (this._stack?.get_visible_child_name() !== 'movers')
            this._settings.set_boolean('sidebar-visible',
                                       this._split.get_show_sidebar());
        return false;
    }
}
);

/* ── module-level helpers ─────────────────────────────────────────────── */

/* "3h ago" for news stamps; older items fall back to a date */
function relTime(epochSec) {
    if (!epochSec)
        return '';
    const days = (GLib.get_real_time() / 1e6 - epochSec) / 86400;
    if (days > 30)
        return new Intl.DateTimeFormat(undefined,
            {month: 'short', day: 'numeric'}).format(new Date(epochSec * 1000));
    const m = Math.max(0, Math.round(days * 1440));
    if (m < 60)
        return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24)
        return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function renderChips(wrap, entries) {
    for (let c = wrap.get_first_child(); c;) {
        const next = c.get_next_sibling();
        wrap.remove(c);
        c = next;
    }
    for (const [k, v] of entries) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                 spacing: 5, css_classes: ['tg-chip-static']});
        box.append(new Gtk.Label({label: k, css_classes: ['dim-label', 'caption']}));
        if (v !== undefined)
            box.append(new Gtk.Label({label: String(v), css_classes: ['caption']}));
        wrap.append(box);
    }
}

function drawCenteredHint(cr, w, h, dark, text) {
    cr.selectFontFace?.('Inter', 0, 0);
    cr.setFontSize?.(13);
    cr.textExtents?.(text);
    // simple centered placeholder without pulling Pango here
    cr.setSourceRGBA(dark ? 1 : 0.06, dark ? 1 : 0.09, dark ? 1 : 0.14, 0.4);
    cr.moveTo(w / 2 - text.length * 3.6, h / 2);
    cr.showText?.(text) ?? cr.show_text?.(text);
}
