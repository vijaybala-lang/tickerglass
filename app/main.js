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
        // shortcuts → window actions
        this.set_accels_for_action('win.refresh', ['F5', 'r']);
        this.set_accels_for_action('win.search', ['<Primary>f', 'slash']);
        this.set_accels_for_action('win.sidebar', ['F9']);
        this.set_accels_for_action('win.search', ['slash', '<Primary>f']);
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
