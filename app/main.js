/* TickerGlass app — GJS + GTK4 + libadwaita, no build step.
 * Run from a build dir:  gjs -m dist/app/main.js
 * Shares its gsettings schema (and therefore watchlists) with the GNOME
 * Shell extension: edit in either place, both react live. */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import {TickerWindow} from './window.js';

const APP_ID = 'dev.vijaybala.TickerGlass';
// gjs 1.88: import.meta.filename may be unset; decode the file: URL
const DIR = GLib.path_get_dirname(
    decodeURIComponent(import.meta.url.replace(/^file:\/\//, '')));

export const TickerGlassApp = GObject.registerClass(
class TickerGlassApp extends Adw.Application {
    constructor() {
        super({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
            // GJS app: resources live next to main.js, not in a GResource
        });
        this._css = new Gtk.CssProvider();
        try {
            this._css.load_from_path(`${DIR}/style.css`);
        } catch (e) {
            logError(e, 'TickerGlass app: no style.css');
        }
        this._cssNight = null;
        try {
            const night = new Gtk.CssProvider();
            night.load_from_path(`${DIR}/night.css`);
            this._cssNight = night;
        } catch (e) {
            logError(e, 'TickerGlass app: no night.css');
        }
    }

    vfunc_startup() {
        super.vfunc_startup();
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), this._css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        // dark variant rides the resolved scheme (system setting or the
        // in-app override): libadwaita flips StyleManager:dark, we swap
        // the override provider on top of the base one
        const sm = Adw.StyleManager.get_default();
        const syncVariant = () => {
            if (!this._cssNight)
                return;
            if (sm.get_dark())
                Gtk.StyleContext.add_provider_for_display(
                    Gdk.Display.get_default(), this._cssNight,
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 10);
            else
                Gtk.StyleContext.remove_provider_for_display(
                    Gdk.Display.get_default(), this._cssNight);
        };
        syncVariant();
        sm.connect('notify::dark', syncVariant);
        // The OS accent rides the add button. libadwaita injects the real
        // accent by templating `@define-color accent_bg_color %s`, but our
        // style.css/night.css redefine that token to the brand green (focus
        // rings, switches), so mirror the OS value into a private
        // tg-accent token instead. One hex per accent name, identical in
        // light and dark (extracted from libadwaita's own palette).
        const ACCENTS = {
            blue: '#3584e4', teal: '#2190a4', green: '#3a944a',
            yellow: '#c88800', orange: '#ed5b00', red: '#e62d42',
            pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
        };
        this._cssAccent = new Gtk.CssProvider();
        const iface = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        const syncAccent = () => {
            let hex = ACCENTS[iface.get_string('accent-color')];
            try {
                if (iface.get_string('accent-color') === 'custom') {
                    const c = iface.get_string('custom-accent-color');
                    if (/^#[0-9a-fA-F]{6}$/.test(c))
                        hex = c.toLowerCase();
                }
            } catch (e) { /* old GNOME: no custom accent */ }
            if (!hex)
                hex = '#3584e4';        // 'default' or unknown → Adwaita blue
            // pick readable ink by luminance instead of assuming white
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            const fg = (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150
                ? '#000000' : '#ffffff';
            this._cssAccent.load_from_string(
                `@define-color tg-accent ${hex};\n` +
                `@define-color tg-accent-fg ${fg};`);
        };
        syncAccent();
        iface.connect('changed::accent-color', syncAccent);
        try {
            iface.connect('changed::custom-accent-color', syncAccent);
        } catch (e) { /* key may not exist on older schemas */ }
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), this._cssAccent,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 20);
        // shortcuts → window actions. Refresh is F5 / Ctrl-R, NOT bare
        // “r”: a single letter bound as a window accelerator fires on
        // keypress and is swallowed before the search entry can insert
        // it, so typing any symbol containing “r” (ZBRA, ARKK…) broke.
        // Single-letter “focus search” (slash) is kept but scoped below.
        this.set_accels_for_action('win.refresh', ['F5', '<Primary>r']);
        this.set_accels_for_action('win.readerback', ['Escape']);
        this.set_accels_for_action('win.search', ['<Primary>f', 'slash']);
        this.set_accels_for_action('win.sidebar', ['F9']);
        this.set_accels_for_action('win.newlist', ['<Primary>n']);
        this.set_accels_for_action('win.prefs', ['<Primary>comma']);
    }

    vfunc_activate() {
        let win = this.get_active_window();
        if (!win)
            win = new TickerWindow(this);
        win.present();
    }
});

new TickerGlassApp().runAsync(null);
