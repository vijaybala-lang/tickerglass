/* prefs.js — part of TickerGlass
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
/* prefs.js — Adw preferences (ExtensionPreferences: the shell constructs the
 * window, we just fill it). All edits write gsettings immediately; the
 * running extension reacts live, no restart dance (weatherglass rule). */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {initI18n, _} from './i18n.js';
import {textPrompt} from './prompt.js';
import {parseWatchlists, stringifyWatchlists, RANGES, RANGE_LABEL,
        INTERVALS, INTERVAL_LABEL} from './fmt.js';
import {MarketClient} from './yahoo.js';

/* a deletable list row (prefs.js ResultRow pattern, generalized) */
const SymbolRow = GObject.registerClass(
class SymbolRow extends Adw.ActionRow {
    constructor(symbol, onRemove) {
        super({title: symbol});
        const btn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
        });
        btn.add_css_class('flat');
        btn.add_css_class('dim-label');
        btn.connect('clicked', () => onRemove(symbol));
        this.add_suffix(btn);
    }
});

/* the app's search-box typeahead, rebuilt for prefs rows: debounced
 * catalog search (Yahoo quotes — every data source answers search,
 * even the nasdaq route relays it), results as name+exchange rows,
 * Enter = exact/top/raw pick. onPick gets the chosen SYMBOL. */
function attachSuggest(entry, client, onPick) {
    const pop = new Gtk.Popover({autohide: true});
    const scroller = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        min_content_height: 90, max_content_height: 300,
        propagate_natural_height: true,
    });
    const results = new Gtk.ListBox();
    results.add_css_class('boxed-list');
    results.set_activate_on_single_click(true);
    scroller.set_child(results);
    pop.set_child(scroller);
    pop.set_size_request(340, -1);
    // the ENTRY is the keyboard host: a mapping popover steals focus,
    // and with Adw.EntryRow (unlike the app's Gtk.SearchEntry) the
    // caret never comes back — typeahead would die after the first
    // keystroke. Nothing in here may be focusable; single-click
    // activation stays fully mouse-driven, Enter picks from the entry
    // (see entry-activated below). Belt: re-grab after every popup.
    scroller.set_can_focus(false);
    results.set_can_focus(false);
    // no set_popover on an EntryRow: parent by hand, drop below
    pop.set_parent(entry);
    pop.set_position(Gtk.PositionType.BOTTOM);
    entry.connect('notify::has-focus', () => {
        if (!entry.is_focus())
            pop.popdown();
    });

    let seq = 0, pending = 0, pickable = [];
    const pick = sym => {
        pop.popdown();
        entry.set_text('');
        onPick(sym);
    };
    const populate = items => {
        pickable = items.filter(it => !it.pending);
        for (let r = results.get_first_child(); r;) {
            const next = r.get_next_sibling();
            results.remove(r);
            r = next;
        }
        for (const it of items) {
            const row = new Adw.ActionRow({
                title: it.symbol, subtitle: it.name,
            });
            row.set_can_focus(false);
            if (it.pending) {
                row.set_activatable(false);
                results.append(row);
                continue;
            }
            row.add_suffix(new Gtk.Label({
                label: it.exchange || it.type || '',
                css_classes: ['dim-label', 'caption'],
                valign: Gtk.Align.CENTER,
            }));
            row.connect('activated', () => pick(it.symbol));
            results.append(row);
        }
        if (items.some(it => !it.pending)) {
            pop.popup();
            entry.grab_focus();
        }
    };
    const runSearch = text => {
        const mySeq = ++seq;
        const sym = text.trim().toUpperCase();
        if (!sym) {
            populate([]);
            return;
        }
        populate([{symbol: '…', name: _('Searching\u2026'),
                   exchange: '', type: '', pending: true}]);
        client.search(sym).then(res => {
            if (mySeq !== seq)
                return;
            populate([...(res ?? []), {
                symbol: sym, name: _('Add this symbol directly'),
                exchange: '', type: '',
            }]);
        }).catch(() => {
            if (mySeq === seq) {
                populate([{symbol: sym,
                           name: _('Add this symbol directly')}]);
            }
        });
    };
    // 'notify::text' is the guarantee (Adw.EntryRow is not a
    // Gtk.SearchEntry — no 'search-changed'; 'changed' is not
    // documented on this row either)
    entry.connect('notify::text', () => {
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
        if (!sym)
            return;
        const hit = pickable.find(it => it.symbol === sym) ?? pickable[0];
        pick(hit?.symbol ?? sym);
    });
}

export default class TickerGlassPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        initI18n(this.uuid, this.dir.get_path());
        const settings = this.getSettings();
        window.set_default_size(560, 640);

        window.add(this._watchlistsPage(settings));
        window.add(this._panelPage(settings));
        window.add(this._dataPage(settings));
        window.add(this._aboutPage());
    }

    /* ── watchlists ────────────────────────────────────────────────────── */

    _read(settings) {
        return parseWatchlists(settings.get_string('watchlists'));
    }

    _write(settings, lists) {
        settings.set_string('watchlists', stringifyWatchlists(lists));
    }

    _watchlistsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Watchlists'), icon_name: 'view-list-symbolic',
        });

        /* active picker */
        // search catalog for the typeahead rows below — every data
        // source answers search (the nasdaq route relays Yahoo)
        const client = new MarketClient(settings.get_string('data-source'));

        const pickGroup = new Adw.PreferencesGroup();
        const activeRow = new Adw.ComboRow({title: _('Active watchlist')});
        const refreshActive = () => {
            const lists = this._read(settings);
            activeRow.model = new Gtk.StringList({
                strings: lists.map(w => w.name),
            });
            const id = settings.get_string('active-watchlist');
            const i = lists.findIndex(w => w.id === id);
            activeRow.selected = i < 0 ? 0 : i;
        };
        activeRow.connect('notify::selected', () => {
            const lists = this._read(settings);
            const wl = lists[activeRow.selected];
            if (wl)
                settings.set_string('active-watchlist', wl.id);
        });
        pickGroup.add(activeRow);

        const addBtn = new Adw.ActionRow({title: _('Create a new watchlist')});
        const addOuter = new Gtk.Button({child: addBtn});
        addOuter.add_css_class('flat');
        addOuter.connect('clicked', () => {
            textPrompt({
                parent: window,
                title: _('Watchlist name'),
                acceptLabel: _('Create'),
                onAccept: name => {
                    const lists = this._read(settings);
                    const id = `wl${Date.now()}`;
                    lists.push({id, name, symbols: []});
                    this._write(settings, lists);
                    settings.set_string('active-watchlist', id);
                },
            });
        });
        pickGroup.add(addOuter);
        page.add(pickGroup);

        /* the obvious one: app-style search box up top, with an
         * explicit target list — the quiet row inside the expander
         * never read as an input */
        const addGroup = new Adw.PreferencesGroup({title: _('Add symbol')});
        const addEntry = new Adw.EntryRow({
            title: _('Search company or ticker (Apple, ^GSPC, BTC-USD\u2026)'),
        });
        // plain constructor: Gtk.Image.from_icon_name doesn't exist on
        // this GTK build (4.16+ only) and new_from_* is factory style
        addEntry.add_prefix(new Gtk.Image({
            icon_name: 'system-search-symbolic',
        }));
        const addTarget = new Adw.ComboRow({title: _('Add to')});
        // stick with the list the user picked, even after the rebuild
        // an add triggers; default to the active watchlist
        let targetId = null;
        const syncTarget = () => {
            const lists = this._read(settings);
            addTarget.model = new Gtk.StringList({
                strings: lists.map(w => w.name),
            });
            let i = lists.findIndex(w => w.id === targetId);
            if (i < 0) {
                i = lists.findIndex(
                    w => w.id === settings.get_string('active-watchlist'));
            }
            addTarget.selected = i < 0 ? 0 : i;
        };
        addTarget.connect('notify::selected', () => {
            const wl = this._read(settings)[addTarget.selected];
            if (wl)
                targetId = wl.id;
        });
        attachSuggest(addEntry, client, sym => {
            const lists = this._read(settings);
            const wl = lists[addTarget.selected];
            if (!wl)
                return;
            if (wl.symbols.includes(sym)) {
                addEntry.add_css_class('error');
                return;
            }
            addEntry.remove_css_class('error');
            wl.symbols.push(sym);
            this._write(settings, lists);
        });
        addGroup.add(addEntry);
        addGroup.add(addTarget);
        page.add(addGroup);

        /* one expander per watchlist */
        const listGroup = new Adw.PreferencesGroup();
        page.add(listGroup);
        // AdwPreferencesGroup is NOT a plain container: get_last_child()
        // shows its internal GtkBox, and remove() on those trips
        // adw-preferences-group.c:430 ("non-child" ×N) without removing
        // anything — track the rows we actually added and remove those
        const tracked = [];

        const rebuild = () => {
            for (const r of tracked.splice(0))
                listGroup.remove(r);
            const lists = this._read(settings);
            for (const wl of lists) {
                const exp = new Adw.ExpanderRow({
                    title: wl.name,
                    subtitle: `${wl.symbols.length} ${_('symbols')}`,
                });

                const addRow = new Adw.EntryRow({
                    title: _('Add to “%s” — name or ticker ' +
                             '(AAPL, BTC-USD…)').format(wl.name),
                });
                addRow.add_prefix(new Gtk.Image({
                    icon_name: 'system-search-symbolic',
                }));
                attachSuggest(addRow, client, sym => {
                    if (!sym || wl.symbols.includes(sym)) {
                        addRow.add_css_class('error');
                        return;
                    }
                    addRow.remove_css_class('error');
                    wl.symbols.push(sym);
                    this._write(settings, lists);
                });
                exp.add_row(addRow);

                for (const sym of [...wl.symbols]) {
                    exp.add_row(new SymbolRow(sym, s => {
                        wl.symbols = wl.symbols.filter(x => x !== s);
                        this._write(settings, lists);
                    }));
                }

                const renameBtn = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    valign: Gtk.Align.CENTER, tooltip_text: _('Rename'),
                });
                renameBtn.add_css_class('flat');
                renameBtn.connect('clicked', () => {
                    textPrompt({
                        parent: window,
                        title: _('Watchlist name'),
                        initial: wl.name,
                        onAccept: name => {
                            wl.name = name;
                            this._write(settings, lists);
                        },
                    });
                });
                exp.add_prefix(renameBtn);

                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER, tooltip_text: _('Delete list'),
                });
                delBtn.add_css_class('flat');
                delBtn.connect('clicked', () => {
                    const keep = lists.filter(w => w.id !== wl.id);
                    if (!keep.length)
                        return;                       // never empty everything
                    this._write(settings, keep);
                    if (settings.get_string('active-watchlist') === wl.id)
                        settings.set_string('active-watchlist', keep[0].id);
                });
                exp.add_suffix(delBtn);

                listGroup.add(exp);
                tracked.push(exp);
            }
            refreshActive();
            syncTarget();
        };
        rebuild();
        settings.connect('changed::watchlists', rebuild);   // live app edits
        return page;
    }

    /* ── panel ─────────────────────────────────────────────────────────── */

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Panel'), icon_name: 'preferences-system-symbolic',
        });
        const g = new Adw.PreferencesGroup({title: _('In the top bar')});
        g.description = _('The panel counts how many symbols in the ' +
            'active watchlist are up (▲) and down (▼) today. The menu ' +
            'lists its five biggest gainers and five biggest losers — ' +
            'click a ticker to open it in the app, in the first list ' +
            'that contains it.');
        page.add(g);

        const g2 = new Adw.PreferencesGroup({title: _('Dropdown rows')});
        const colRow = new Adw.SwitchRow({
            title: _('Two-column movers'),
            subtitle: _('Gainers and losers side by side; off stacks ' +
                        'them in one column'),
        });
        settings.bind('menu-two-column', colRow, 'active',
                      Gio.SettingsBindFlags.DEFAULT);
        g2.add(colRow);
        const sparkIds = ['1d', '5d'];
        const sparkRow = new Adw.ComboRow({
            title: _('Sparkline window'),
            subtitle: _('What each watchlist row\u2019s spark covers'),
            model: new Gtk.StringList({
                strings: [_('Today'), _('Last 5 days')]}),
        });
        sparkRow.selected = Math.max(0, sparkIds.indexOf(
            settings.get_string('panel-spark-range')));
        sparkRow.connect('notify::selected', () =>
            settings.set_string('panel-spark-range',
                                sparkIds[sparkRow.selected]));
        g2.add(sparkRow);
        page.add(g2);
        return page;
    }

    /* ── data & chart ──────────────────────────────────────────────────── */

    _dataPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Data & Chart'), icon_name: 'network-server-symbolic',
        });

        const g1 = new Adw.PreferencesGroup({title: _('Market data')});
        const srcRow = new Adw.ComboRow({
            title: _('Data source'),
            subtitle: _('Yahoo Finance needs no account; demo generates ' +
                        'plausible offline data'),
            model: new Gtk.StringList({
                strings: ['Yahoo Finance', _('Yahoo via relay'),
                          _('Nasdaq (US stocks & ETFs)'),
                          _('Demo (offline)')]}),
        });
        const srcIds = ['yahoo', 'yahoo-relay', 'nasdaq', 'demo'];
        srcRow.selected = Math.max(0, srcIds.indexOf(
            settings.get_string('data-source')));
        srcRow.connect('notify::selected', () =>
            settings.set_string('data-source', srcIds[srcRow.selected]));
        g1.add(srcRow);

        // static factory, NOT a class: 'new' before new_with_range is a
        // TypeError ("not a constructor") that kills the whole dialog
        const refreshRow = Adw.SpinRow.new_with_range(
            15, 3600, 15);
        refreshRow.title = _('Refresh quotes every');
        settings.bind('refresh-seconds', refreshRow.get_adjustment(), 'value',
                      Gio.SettingsBindFlags.DEFAULT);
        g1.add(refreshRow);
        page.add(g1);

        const g2 = new Adw.PreferencesGroup({title: _('Chart defaults')});
        g2.description = _('The dropdown has no chart anymore — these ' +
            'shape the app\u2019s big chart.');
        const styleIds = ['area', 'line', 'candles'];
        const styleRow = new Adw.ComboRow({
            title: _('Style'),
            model: new Gtk.StringList({
                strings: [_('Area'), _('Line'), _('Candlesticks')]}),
        });
        styleRow.selected = Math.max(0, styleIds.indexOf(
            settings.get_string('chart-style')));
        styleRow.connect('notify::selected', () =>
            settings.set_string('chart-style', styleIds[styleRow.selected]));
        g2.add(styleRow);

        const rangeRow = new Adw.ComboRow({title: _('Default range')});
        // this GtkStringList build rejects the {strings:} construct dict
        const rangeModel = new Gtk.StringList();
        for (const r of RANGES)
            rangeModel.append(RANGE_LABEL[r]);
        rangeRow.model = rangeModel;
        rangeRow.selected = Math.max(0, RANGES.indexOf(
            settings.get_string('chart-range')));
        rangeRow.connect('notify::selected', () =>
            settings.set_string('chart-range', RANGES[rangeRow.selected]));
        g2.add(rangeRow);

        const ivIds = ['auto', ...INTERVALS];
        const ivRow = new Adw.ComboRow({
            title: _('Interval'),
            subtitle: _('auto matches Yahoo’s own defaults per range'),
            model: new Gtk.StringList({
                strings: [_('Auto'), ...INTERVALS.map(iv => INTERVAL_LABEL[iv])]}),
        });
        ivRow.selected = Math.max(0, ivIds.indexOf(
            settings.get_string('chart-interval')));
        ivRow.connect('notify::selected', () =>
            settings.set_string('chart-interval', ivIds[ivRow.selected]));
        g2.add(ivRow);
        page.add(g2);
        return page;
    }

    /* ── about ─────────────────────────────────────────────────────────── */

    _aboutPage() {
        const page = new Adw.PreferencesPage({
            title: _('About'), icon_name: 'help-about-symbolic',
        });
        const g = new Adw.PreferencesGroup();
        g.add(new Adw.ActionRow({
            title: 'TickerGlass',
            subtitle: _('Sparkline ticker for GNOME — quotes by Yahoo ' +
                        'Finance, no account, no tracking. Edits here live ' +
                        'in sync with the TickerGlass app.'),
        }));
        g.add(new Adw.ActionRow({
            title: _('Privacy'),
            subtitle: _('Requests go straight from this machine to ' +
                        'finance.yahoo.com; nothing is cached on disk.'),
        }));
        page.add(g);
        return page;
    }
}
