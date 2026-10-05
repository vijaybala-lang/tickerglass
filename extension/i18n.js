/* i18n.js — part of TickerGlass
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
/* ── i18n glue ───────────────────────────────────────────────────────────
 *
 * GJS's native gettext module (the gi://Gettext typelib is gone from
 * modern GJS). The shell process and the prefs process each call
 * initI18n() once — extension UUID + extension dir — before any UI is
 * built. Until then, and whenever no catalog exists for the user's
 * locale, gettext() hands back the English msgid, so the extension
 * degrades to English instead of breaking.
 *
 * Catalogs live at  <ext>/locale/<lang>/LC_MESSAGES/<uuid>.mo  — built
 * from po/*.po by tools/i18n-build.sh (xgettext → msgmerge → msgfmt).
 * New languages: add a line to po/LINGUAS + a po/<lang>.po.
 */
import {bindtextdomain, textdomain, setlocale, LocaleCategory,
        gettext} from 'gettext';

let ready = false;

export function initI18n(uuid, dirPath) {
    if (ready)
        return;
    try {
        // gnome-shell already runs with the user's LC_* environment;
        // the explicit setlocale covers the prefs process and gjs tools
        setlocale(LocaleCategory.MESSAGES, '');
        textdomain(uuid);
        bindtextdomain(uuid, `${dirPath}/locale`);
    } catch (e) {
        // English forever — never a broken weather card over a catalog hiccup
    }
    ready = true;
}

/** Translate at CALL time: tables (the WMO descriptions in weather.js,
 *  the prefs LEGEND) are built at module-load, before any domain is
 *  bound — wrapping their literals where they're constructed would bake
 *  English into the catalog lookup and miss it entirely. */
export const _ = s => gettext(s);

/** Mark a string for extraction (xgettext collects it into the .pot)
 *  but hand it back unchanged — for table entries that get _()-ed later
 *  at render time. Identity at runtime, visible to the build tooling. */
export const N_ = s => s;
