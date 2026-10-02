/* window.js — the whole TickerGlass app UI.
 * Layout: OverlaySplitView(sidebar(watchlist dropdown + sparkline rows) |
 * toast overlay(headerbar + ViewStack(chart page: hero + cairo chart +
 * ranges + news | table page: sortable list table))).
 * Everything is driven by the shared gsettings schema; Yahoo/demo comes
 * through the shared MarketClient. */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';
import Cairo from 'gi://cairo';

import {MarketClient} from './yahoo.js';
import {paintChart, paintMiniSpark} from './spark.js';
import {textPrompt} from './prompt.js';
import {parseWatchlists, stringifyWatchlists, fmtPrice, fmtDelta, fmtPct,
        fmtCompact, fmtTime, axisDate, symbolShort, RANGES, RANGE_LABEL,
        INTERVALS, INTERVAL_LABEL, intervalFor} from './fmt.js';

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
        this._refresh();
        this._restartTimer();
        // TG_VIEW=table|chart forces the initial view (dev/testing hook)
        const view0 = GLib.getenv('TG_VIEW');
        if (view0 === 'table' || view0 === 'chart')
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
    }

    /* ── UI construction ──────────────────────────────────────────────── */

    _buildUi() {
        // header identity, Robinhood-style: the company name leads big and
        // bold, the symbol rides along as a quiet badge; left justified
        this._heroSym = new Gtk.Label({label: '', css_classes: ['tg-win-sym']});
        this._heroName = new Gtk.Label({
            label: 'TickerGlass', css_classes: ['tg-win-name'],
            ellipsize: 3, max_width_chars: 38,
        });
        this._tickerTitle = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 10,
            valign: Gtk.Align.CENTER, halign: Gtk.Align.START,
            hexpand: true, margin_start: 6,
        });
        this._tickerTitle.append(this._heroName);
        this._tickerTitle.append(this._heroSym);

        const hbar = new Adw.HeaderBar();
        this.set_title('TickerGlass');
        const sideBtn = new Gtk.ToggleButton({icon_name: 'sidebar-show-symbolic',
                                              tooltip_text: 'Watchlists (F9)'});
        hbar.pack_start(sideBtn);
        // identity is a start-packed item, not title_widget: libadwaita
        // forces the title slot centered; packed items sit flush left
        hbar.pack_start(this._tickerTitle);
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

        // reading mode replaces the ticker chrome entirely (back pill,
        // article title, open-externally) — toggled per visible page below
        this._readBack = new Gtk.Button({label: '← Ticker',
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
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
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
        // identity moved to the header; the page leads with the price
        this._heroPrice = new Gtk.Label({label: '', css_classes: ['tg-hero-price']});
        this._heroPill = new Gtk.Label({label: '', css_classes: ['tg-pill']});
        heroTop.append(this._heroPrice);
        heroTop.append(this._heroPill);
        heroTop.append(new Gtk.Box());     // spacer
        const spacer = heroTop.get_last_child();
        spacer.set_hexpand(true);
        // shown only while the hero is a search-preview not yet in the list
        this._addBtn = new Gtk.Button({label: '+ Watchlist',
                                       valign: Gtk.Align.CENTER});
        this._addBtn.add_css_class('tg-chip');
        this._addBtn.set_visible(false);
        this._addBtn.connect('clicked', () => this._addSymbol(this._hero()));
        heroTop.append(this._addBtn);
        this._heroBox.append(heroTop);
        this._chips = new Adw.WrapBox({margin_top: 4, line_spacing: 8,
                                       child_spacing: 8});
        this._heroBox.append(this._chips);
        chartPage.append(this._heroBox);

        // chart
        this._chart = new Gtk.DrawingArea();
        this._chart.set_vexpand(true);
        this._chart.set_content_height(220);
        this._chart.set_margin_top(8);
        this._chart.add_css_class('tg-chart-area');
        this._chart.set_draw_func((area, cr, w, h) => this._drawChart(cr, w, h));
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
        this._newsList.set_header_func((row, before) => {
            row.set_header(before ? new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}) : null);
        });
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
        this._stack = new Gtk.Stack({
            vexpand: true, transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
            transition_duration: 180,
        });
        this._stack.add_titled(chartPage, 'chart', 'Chart');
        this._stack.add_titled(tablePage, 'table', 'Table');
        content.append(this._stack);
        this._stack.connect('notify::visible-child-name', () => {
            const p = this._stack.get_visible_child_name();
            if (p === 'chart' || p === 'table')
                this._viewAction?.set_state(new GLib.Variant('s', p));
            // the reader owns the whole pane: swap the ticker chrome out
            const reading = p === 'reader';
            for (const w of [sideBtn, menuBtn, search])
                w.set_visible(!reading);
            if (reading)
                this._searchPop?.popdown();
            this._readBack.set_visible(reading);
            this._readExt.set_visible(reading);
            this._tickerTitle.set_visible(!reading);
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
        const newBtn = new Gtk.Button({icon_name: 'list-add-symbolic',
                                       tooltip_text: 'New list (Ctrl+N)'});
        newBtn.add_css_class('flat');
        newBtn.set_action_name('win.newlist');
        newBtn.set_halign(Gtk.Align.END);
        newBtn.set_hexpand(true);
        newBtn.set_valign(Gtk.Align.CENTER);
        sideHead.append(newBtn);
        sideBox.append(sideHead);

        // dropdown picking the active watchlist (the extension follows live)
        const chooser = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                     margin_start: 10, margin_end: 10,
                                     margin_top: 2, spacing: 4});
        this._wlStrings = new Gtk.StringList();
        this._wlDrop = new Gtk.DropDown({model: this._wlStrings,
                                         hexpand: true});
        this._wlDrop.connect('notify::selected', () => {
            if (this._suppressWl)
                return;
            const lists = this._lists();
            const wl = lists[this._wlDrop.get_selected()];
            if (wl && wl.id !== this._settings.get_string('active-watchlist'))
                this._settings.set_string('active-watchlist', wl.id);
        });
        chooser.append(this._wlDrop);
        const renameBtn = new Gtk.Button({icon_name: 'document-edit-symbolic',
                                          tooltip_text: 'Rename current list'});
        renameBtn.add_css_class('flat');
        renameBtn.connect('clicked', () =>
            this._renameList(this._settings.get_string('active-watchlist')));
        chooser.append(renameBtn);
        const delBtn = new Gtk.Button({icon_name: 'user-trash-symbolic',
                                       tooltip_text: 'Delete current list'});
        delBtn.add_css_class('flat');
        delBtn.connect('clicked', () =>
            this._deleteList(this._settings.get_string('active-watchlist')));
        chooser.append(delBtn);
        sideBox.append(chooser);

        // the watchlist itself: symbol + sparkline + price per row
        this._symList = new Gtk.ListBox({vexpand: true});
        this._symList.add_css_class('navigation-sidebar');
        this._symList.set_selection_mode(Gtk.SelectionMode.SINGLE);
        this._symList.connect('row-activated', (l, row) => {
            if (row?._sym)
                this._selectSymbol(row._sym);
        });
        const symClick = new Gtk.GestureClick();
        symClick.set_button(3);
        symClick.connect('pressed', (g, nPress, x, y) => {
            const row = this._symList.get_row_at_y(y);
            this._showRowMenu(row?._sym, this._symList);
        });
        this._symList.add_controller(symClick);
        const symScroll = new Gtk.ScrolledWindow({vexpand: true});
        symScroll.set_child(this._symList);
        sideBox.append(symScroll);
        sidebar.set_child(sideBox);

        this._split = new Adw.OverlaySplitView({
            sidebar: sidebar, show_sidebar: this._settings.get_boolean('sidebar-visible'),
            min_sidebar_width: 240, max_sidebar_width: 360,
        });
        sideBtn.bind_property('active', this._split, 'show_sidebar',
                              GObject.BindingFlags.BIDIRECTIONAL);
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

        act('refresh', null, () => this._refresh(true));
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
                                     spacing: 8, margin_start: 10,
                                     margin_end: 10, margin_top: 5,
                                     margin_bottom: 5});
            const symL = new Gtk.Label({label: sym, ellipsize: 3, xalign: 0});
            symL.add_css_class('tg-row-sym');
            symL.set_max_width_chars(10);
            box.append(symL);
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
            const pctL = new Gtk.Label({label: '', css_classes: ['caption', 'numeric'],
                                        halign: Gtk.Align.END});
            const praw = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                      spacing: 0});
            praw.append(priceL);
            praw.append(pctL);
            box.append(praw);
            row.set_child(box);
            row._priceL = priceL;
            row._pctL = pctL;
            row._spark = spark;
            this._symList.append(row);
            this._symRows[sym] = row;
        }
        this._updateWatchRows();
        this._repaintTitle();
    }

    _quoteOf(sym) {
        return this._quotes.find(x => x.symbol === sym);
    }

    /* push fresh quote data into the sidebar rows (labels + sparklines) */
    _updateWatchRows() {
        if (!this._symRows)
            return;
        for (const [sym, row] of Object.entries(this._symRows)) {
            const q = this._quoteOf(sym);
            row._priceL.set_text(q?.price != null
                ? fmtPrice(q.price, q.currency) : '—');
            row._pctL.set_text(q?.changePct != null ? fmtPct(q.changePct) : '');
            row._pctL.remove_css_class('tg-up');
            row._pctL.remove_css_class('tg-down');
            if (q?.change != null)
                row._pctL.add_css_class(q.change >= 0 ? 'tg-up' : 'tg-down');
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
        const lists = this._lists().filter(w => w.id !== id);
        if (!lists.length)
            return;
        this._writeLists(lists);
        if (this._settings.get_string('active-watchlist') === id)
            this._settings.set_string('active-watchlist', lists[0].id);
        this._toast('List deleted');
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
            this._preview = null;     // real now; the button hides itself
            this._previewQ = null;
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

    _showRowMenu(sym, parent) {
        const symbol = sym ?? this._hero();
        if (!symbol)
            return;
        const m = new Gio.Menu();
        m.append('Details…', `win.details::${symbol}`);
        m.append('Copy symbol', `win.copy::${symbol}`);
        m.append('Remove from watchlist', `win.removeSymbol::${symbol}`);
        const pop = Gtk.PopoverMenu.new_from_model(m);
        pop.set_parent(parent ?? this._tableList);
        pop.present();
    }

    _refreshTable() {
        if (!this._tableList)
            return;
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
                box.append(lbl);
            }
            row.set_child(box);
            this._tableList.append(row);
            if (q.symbol === hero)
                this._tableList.select_row(row);
        }
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
            this._spinner.set_visible(false);
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
        this._spinner.set_visible(true);
        this._client.quotes([...syms, ...prev], {sparkRange: '1mo'})
            .then(res => {
                if (this._dead)
                    return;
                this._quotes = res.quotes;
                this._atWall = Math.floor(GLib.get_real_time() / 1e6);
                this._busy = false;
                this._busySince = 0;
                this._spinner.set_visible(false);
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
                this._spinner.set_visible(false);
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

    async _loadHistory() {
        const sym = this._hero();
        if (!sym)
            return;
        const range = this._settings.get_string('chart-range');
        try {
            const hist = await this._client.history(
                sym, range, this._settings.get_string('chart-interval'));
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
            this._ivBtn.set_label(INTERVAL_LABEL[hist.interval] ?? hist.interval);
            this._updateHero();
        } catch (e) {
            logError(e, 'TickerGlass app');
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
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                     spacing: 2, margin_start: 12,
                                     margin_end: 12, margin_top: 8,
                                     margin_bottom: 8});
            const title = new Gtk.Label({label: n.title, xalign: 0,
                                         wrap: true, ellipsize: 3});
            title.set_lines(2);
            title.add_css_class('tg-news-title');
            box.append(title);
            const sub = new Gtk.Label({
                label: [n.source, relTime(n.at)].filter(Boolean).join('  ·  '),
                xalign: 0, css_classes: ['dim-label', 'caption']});
            box.append(sub);
            row.set_child(box);
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
        paintChart(cr, {
            w, h,
            points: hist.points,
            mode: this._settings.get_string('chart-style'),
            prevClose: hist.range === '1d' ? hist.meta.prevClose : null,
            dark: this._styleManager?.get_dark() ?? true,
            fmtY: v => fmtPrice(v, hist.meta.currency),
            fmtX: t => intraday ? fmtTime(t, hist.meta.tz)
                                : axisDate(t, (hist.points[hist.points.length - 1].t - hist.points[0].t) / 86400),
            progress: this._progress,
            cursor: this._cursor,
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
            this._heroName.set_label('TickerGlass');
            this._heroSym.set_label('');
        } else if (name) {
            this._heroName.set_label(name);
            this._heroSym.set_label(symbolShort(sym));
        } else {
            this._heroName.set_label(symbolShort(sym));
            this._heroSym.set_label('');
        }
        this._heroSym.set_visible(!!this._heroSym.get_label());
    }

    _updateHero() {
        const sym = this._hero();
        // no fallback to quotes[0]: painting another ticker's price under
        // the new hero symbol would lie until the refresh lands
        const q = this._quotes.find(x => x.symbol === sym)
            ?? (this._previewQ?.symbol === sym ? this._previewQ : null);
        const hist = this._hist;
        this._addBtn.set_visible(this.isPreview());
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
        const ids = ['area', 'line', 'candles'];
        const styleLbl = {area: 'Area', line: 'Line', candles: 'Candles'};
        this._styleBtn.set_label(
            styleLbl[this._settings.get_string('chart-style')] ?? 'Area');
        this._ivBtn.set_label(
            INTERVAL_LABEL[hist?.interval] ?? 'Auto');

        if (!q) {
            this._heroPrice.set_label('');
            this._heroPill.set_label('');
            renderChips(this._chips, []);
            return;
        }
        this._heroPrice.set_label(q.price != null
            ? fmtPrice(q.price, q.currency) : '—');
        const up = (q.change ?? 0) >= 0;
        this._heroPill.set_css_classes(['tg-pill',
                                        up ? 'tg-up-soft' : 'tg-down-soft']);
        this._heroPill.set_label(q.change != null
            ? `${fmtDelta(q.change, q.currency)}  ${fmtPct(q.changePct)}` : '');
        this._heroPrice.set_css_classes(['tg-hero-price',
                                         q.change != null ? (up ? 'tg-up' : 'tg-down') : '']);

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
        case 'watchlists':
            this._rebuildSidebar();
            this._refresh(true);
            break;
        case 'active-watchlist':
            this._rebuildSidebar();
            this._refresh(true);
            this._loadHistory();
            break;
        case 'selected-symbol':
            this._updateHero();
            this._loadHistory();
            break;
        case 'chart-range':
        case 'chart-interval':
            this._updateHero();
            this._loadHistory();
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
        }
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
