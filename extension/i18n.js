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
