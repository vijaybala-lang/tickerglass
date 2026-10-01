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
    }

    /* ── UI construction ──────────────────────────────────────────────── */

    _buildUi() {
        this._title = new Adw.WindowTitle({title: 'TickerGlass'});

        const hbar = new Adw.HeaderBar();
        try {
            hbar.title_widget = this._title;
        } catch {
            hbar.pack(this._title);   // older libadwaita (< 1.4)
        }
        this.set_title('TickerGlass');
        const sideBtn = new Gtk.ToggleButton({icon_name: 'sidebar-show-symbolic',
                                              tooltip_text: 'Watchlists (F9)'});
        hbar.pack_start(sideBtn);
        const searchBtn = new Gtk.Button({icon_name: 'edit-find-symbolic',
                                          tooltip_text: 'Add symbol (/)'});
        searchBtn.set_action_name('win.search');
        hbar.pack_end(this._menuBtn());
        hbar.pack_end(searchBtn);

        /* —— content column —— */
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(hbar);

        // the window body is a two-page stack: Chart (hero + chart + news)
        // and Table (the sortable watchlist grid); the header toggles pages
        const viewBox = new Gtk.Box({css_classes: ['linked']});
        const chartBtn = new Gtk.ToggleButton({label: 'Chart', tooltip_text: 'Chart view'});
        const tableBtn = new Gtk.ToggleButton({label: 'Table', tooltip_text: 'Table view'});
        viewBox.append(chartBtn);
        viewBox.append(tableBtn);
        viewBox.set_halign(Gtk.Align.CENTER);
        hbar.pack_end(viewBox);

        // chart page
        const chartPage = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});

        // hero block
        this._heroBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                     margin_top: 10, margin_bottom: 2,
                                     margin_start: 18, margin_end: 18,
                                     spacing: 2});
        const heroTop = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                     spacing: 12});
        this._heroSym = new Gtk.Label({label: '—', css_classes: ['tg-hero-sym']});
        this._heroName = new Gtk.Label({label: '', css_classes: ['dim-label', 'caption']});
        this._heroPrice = new Gtk.Label({label: '', css_classes: ['tg-hero-price']});
        this._heroPill = new Gtk.Label({label: '', css_classes: ['tg-pill']});
        heroTop.append(this._heroSym);
        heroTop.append(this._heroName);
        heroTop.append(new Gtk.Box());     // spacer
        const spacer = heroTop.get_last_child();
        spacer.set_hexpand(true);
        heroTop.append(this._heroPill);
        heroTop.append(this._heroPrice);
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
        this._newsList = new Gtk.ListBox();
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
        for (const [btn, page] of [[chartBtn, 'chart'], [tableBtn, 'table']]) {
            btn.connect('toggled', () => {
                if (btn.get_active())
                    this._stack.set_visible_child_name(page);
            });
        }
        chartBtn.set_active(true);
        this._stack.connect('notify::visible-child-name', () => {
            const p = this._stack.get_visible_child_name();
            chartBtn.set_active(p === 'chart');
            tableBtn.set_active(p === 'table');
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

        const src = new Gio.Menu();
        src.append('Yahoo Finance', 'win.source::yahoo');
        src.append('Yahoo via relay', 'win.source::yahoo-relay');
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
        act('search', null, () => this._openSearch());
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

    _activeList() {
        const id = this._settings.get_string('active-watchlist');
        const lists = this._lists();
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
        this._title.set_title(this._activeList()?.name ?? 'TickerGlass');
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
        const lists = this._lists();
        const wl = this._activeList();
        if (!wl)
            return;
        if (wl.symbols.includes(symbol)) {
            this._toast(`${symbol} is already in ${wl.name}`);
            return;
        }
        wl.symbols.push(symbol);
        this._writeLists(lists);
        this._toast(`${symbol} added to ${wl.name}`);
    }

    _removeSymbol(symbol) {
        const lists = this._lists();
        const wl = this._activeList();
        if (!wl)
            return;
        wl.symbols = wl.symbols.filter(s => s !== symbol);
        this._writeLists(lists);
        this._toast(`${symbol} removed`);
    }

    /* ── search dialog ────────────────────────────────────────────────── */

    _openSearch() {
        if (this._searchDlg)
            return;
        const dlg = new Adw.Dialog({title: 'Add symbol', can_close: true});
        this._searchDlg = dlg;
        dlg.connect('closed', () => { this._searchDlg = null; });

        const bin = new Adw.Bin();
        bin.add_css_class('dlg-pad');
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                                 spacing: 6});
        const clamp = new Adw.Clamp({maximum_size: 480});
        const entry = new Adw.EntryRow({title: 'Search or type a Yahoo symbol',
                                        show_apply_button: false});
        box.append(entry);

        const listScroll = new Gtk.ScrolledWindow({
            vexpand: true, min_content_height: 180, max_content_height: 320,
        });
        const results = new Gtk.ListBox();
        results.add_css_class('boxed-list');
        results.set_vexpand(true);
        listScroll.set_child(results);
        box.append(listScroll);

        const hint = new Gtk.Label({
            label: 'Stocks, ETFs, indices (^GSPC), FX (EURUSD=X), crypto ' +
                   '(BTC-USD), futures (ES=F)',
            css_classes: ['dim-label', 'caption'], wrap: true,
        });
        box.append(hint);
        clamp.set_child(box);
        bin.set_child(clamp);
        dlg.set_child(bin);

        let seq = 0;
        let pending = 0;
        const populate = (items) => {
            for (let r = results.get_first_child(); r;) {
                const next = r.get_next_sibling();
                results.remove(r);
                r = next;
            }
            for (const it of items) {
                const row = new Adw.ActionRow({
                    title: it.symbol, subtitle: it.name,
                });
                row.add_suffix(new Gtk.Label({
                    label: it.exchange || it.type || '',
                    css_classes: ['dim-label', 'caption'],
                    valign: Gtk.Align.CENTER,
                }));
                row._add = () => { this._addSymbol(it.symbol); dlg.force_close(); };
                row.connect('activated', row._add);
                results.append(row);
            }
        };
        const runSearch = (text) => {
            const mySeq = ++seq;
            const sym = text.trim().toUpperCase();
            if (!sym) { populate([]); return; }
            this._client.search(sym).then(res => {
                if (mySeq !== seq || this._dead || !this._searchDlg)
                    return;
                const extra = {symbol: sym,
                               name: 'Add this symbol directly',
                               exchange: '', type: ''};
                populate([...(res ?? []), extra]);
            }).catch(() => populate([{symbol: sym, name: 'Add this symbol directly'}]));
        };
        entry.connect('changed', () => {
            if (pending)
                GLib.source_remove(pending);
            pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                pending = 0;
                runSearch(entry.get_text());
                return GLib.SOURCE_REMOVE;
            });
        });
        entry.connect('entry-activated', () => {
            const sym = entry.get_text().trim().toUpperCase();
            if (sym) { this._addSymbol(sym); dlg.force_close(); }
        });

        dlg.present(this);
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
        const sorted = [...this._quotes]
            .filter(q => q.price != null || q.error)
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
        const sel = this._settings.get_string('selected-symbol');
        const syms = this._activeList()?.symbols ?? [];
        return syms.includes(sel) ? sel : (syms[0] ?? '');
    }

    _selectSymbol(sym) {
        // clicking a row anywhere jumps to the full history view
        this._stack?.set_visible_child_name('chart');
        this._settings.set_string('selected-symbol', sym);
    }

    _refresh(manual = false) {
        if (this._busy)
            return;
        const syms = this._activeList()?.symbols ?? [];
        if (!syms.length) {
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
        this._spinner.set_visible(true);
        this._client.quotes(syms, {sparkRange: '1mo'})
            .then(res => {
                if (this._dead)
                    return;
                this._quotes = res.quotes;
                this._atWall = Math.floor(GLib.get_real_time() / 1e6);
                this._busy = false;
                this._spinner.set_visible(false);
                this._refreshTable();
                this._updateWatchRows();
                this._updateHero();
                // pull the hero's chart as soon as quotes land (don't wait
                // for the next refresh tick to paint something)
                if (this._hist?.symbol !== this._hero())
                    this._loadHistory();
                this._setStatus(
                    `${this._settings.get_string('data-source') === 'demo'
                        ? 'Demo feed' : 'Yahoo Finance'} · updated ` +
                    new Date(this._atWall * 1000)
                        .toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
                if (manual)
                    this._toast('Quotes refreshed');
            })
            .catch(e => {
                if (this._dead)
                    return;
                logError(e, 'TickerGlass app');
                this._busy = false;
                this._spinner.set_visible(false);
                this._setStatus(`Fetch failed: ${e.message}`);
            });
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
            this._startDrawIn();
            this._ivBtn.set_label(INTERVAL_LABEL[hist.interval] ?? hist.interval);
            this._updateHero();
        } catch (e) {
            logError(e, 'TickerGlass app');
            if (!this._dead && this._hero() === sym) {
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

    /* news reader: in-app WebKit window; falls back to the system browser
     * when webkitgtk isn't installed on the host */
    async _openReader(url, title) {
        try {
            await this._openReaderInner(url, title);
        } catch (e) {
            logError(e, 'TickerGlass news reader');
            this._openUrl(url);
        }
    }

    async _openReaderInner(url, title) {
        let WebKit = null;
        // dynamic gi imports land on .default; try newest WebKitGTK first
        for (const v of ['6.0', '5.0', '4.1']) {
            try {
                const mod = await import(`gi://WebKit?version=${v}`);
                WebKit = mod.default ?? mod;
                if (WebKit?.WebView)
                    break;
                WebKit = null;
            } catch { /* next */ }
        }
        if (!WebKit) {
            this._openUrl(url);
            return;
        }
        if (!this._readerWin) {
            const win = new Adw.Window({
                transient_for: this,
                title: title ?? 'Story',
                default_width: 900,
                default_height: 700,
            });
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
            const hbar = new Adw.HeaderBar();
            const back = new Gtk.Button({icon_name: 'go-previous-symbolic',
                                         sensitive: false, css_classes: ['flat']});
            const ext = new Gtk.Button({icon_name: 'web-browser-symbolic',
                                        tooltip_text: 'Open in browser'});
            ext.add_css_class('flat');
            const close = new Gtk.Button({icon_name: 'window-close-symbolic',
                                          tooltip_text: 'Close'});
            close.add_css_class('flat');
            hbar.pack_start(back);
            hbar.pack_end(close);
            hbar.pack_end(ext);
            const web = new WebKit.WebView();
            web.set_vexpand(true);
            back.connect('clicked', () => web.go_back());
            // this WebKit build lacks can-go-back + item.get_back_list —
            // track the first committed URI ourselves for back sensitivity
            const first = {uri: null};
            web.connect('notify::uri', () => {
                const u = web.get_uri();
                if (u && first.uri === null)
                    first.uri = u;
                back.set_sensitive(!!u && u !== first.uri);
            });
            web.connect('notify::title', () => {
                const t = web.get_title();
                if (t)
                    win.set_title(t);
            });
            ext.connect('clicked', () => this._openUrl(web.get_uri() ?? url));
            close.connect('clicked', () => win.destroy());
            win.connect('destroy', () => {
                this._readerWin = null;
                this._readerWeb = null;
            });
            box.append(hbar);
            box.append(web);
            win.set_content(box);
            this._readerWin = win;
            this._readerWeb = web;
        }
        this._readerWeb.load_uri(url);
        this._readerWin.set_title(title ?? 'Story');
        this._readerWin.present();
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

    _updateHero() {
        const sym = this._hero();
        const q = this._quotes.find(x => x.symbol === sym) ??
                  this._quotes[0];
        const hist = this._hist;
        this._title.set_title(this._activeList()?.name ?? 'TickerGlass');
        this._title.set_subtitle(sym ?? '');
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
            this._heroSym.set_label(sym || '—');
            this._heroName.set_label('');
            this._heroPrice.set_label('');
            this._heroPill.set_label('');
            renderChips(this._chips, []);
            return;
        }
        this._heroSym.set_label(symbolShort(q.symbol));
        this._heroName.set_label(
            q.name !== q.symbol ? q.name : q.exchange ?? '');
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
                                                 'Demo (offline)']}),
        });
        const srcIds = ['yahoo', 'yahoo-relay', 'demo'];
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
            comments: 'Sparkline market watch — quotes by Yahoo Finance. ' +
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
    cr.selectFontFace?.('Cantarell', 0, 0);
    cr.setFontSize?.(13);
    cr.textExtents?.(text);
    // simple centered placeholder without pulling Pango here
    cr.setSourceRGBA(dark ? 1 : 0.06, dark ? 1 : 0.09, dark ? 1 : 0.14, 0.4);
    cr.moveTo(w / 2 - text.length * 3.6, h / 2);
    cr.showText?.(text) ?? cr.show_text?.(text);
}
