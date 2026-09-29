/* icontest — nested-shell probe for TickerGlass. Toggles the card open and
 * closed from boot: opening drives allocate → synchronous repaint for the
 * chart, sparklines and rows, turning paint crashes into a red/green test.
 * Also reports whether quotes actually landed (demo feed in the harness). */

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TOGGLES = 8;
const PATIENCE = 25;

export default class IconTest extends Extension {
    enable() {
        this._n = 0;
        this._waited = 0;
        this._reported = false;
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const b = Main.panel.statusArea['tickerglass@vijaybala.dev'];
            if (!b?.menu) {
                this._waited++;
                if (this._waited < PATIENCE)
                    return GLib.SOURCE_CONTINUE;
                log('icontest: FAIL status button never appeared');
                this._id = 0;
                return GLib.SOURCE_REMOVE;
            }
            b.menu.toggle();
            this._n++;
            log(`icontest: toggle ${this._n} → ` +
                `${b.menu.isOpen ? 'open' : 'closed'}`);
            if (!this._reported && this._n >= 5) {
                this._reported = true;
                const rows = b._panel?._rows?.get_n_children() ?? -1;
                const quotes = b._quotes?.length ?? -1;
                const price = b._priceLbl?.get_text?.() ?? '';
                const hist = b._panel?._hist;
                log(`icontest: rows=${rows} quotes=${quotes} ` +
                    `heroHist=${hist ? hist.points.length + 'pts/' + hist.interval : 'none'} ` +
                    `panelPrice='${price}'`);
            }
            if (this._n >= TOGGLES) {
                log('icontest: DONE, shell survived card painting');
                this._id = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._id)
            GLib.source_remove(this._id);
    }
}
