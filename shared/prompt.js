/* prompt.js — part of TickerGlass
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
/* prompt.js — one-line text prompt dialog. Adw.EntryDialog only arrived in
 * libadwaita 1.5 and this Fedora's typelib withholds it, so we build the
 * same thing from Adw.Dialog + Adw.EntryRow. Used by the app (rename/create
 * lists) and the extension prefs. */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

/**
 * textPrompt({parent, title, initial, acceptLabel, onAccept})
 * Presents modally; onAccept(text) runs on Enter or the Accept button.
 */
export function textPrompt({parent, title, initial = '',
                            acceptLabel = _('Save'), onAccept}) {
    const dlg = new Adw.Dialog({title, can_close: true});
    const bin = new Adw.Bin();
    bin.add_css_class('dlg-pad');
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL,
                             spacing: 10});
    const entry = new Adw.EntryRow({title, text: initial});
    box.append(entry);
    // Mirror Adw.AlertDialog's response row exactly (probed its widget
    // tree): response-area buttons are NOT flat — libadwaita styles
    // 'dialog .response-area button' with its own muted ink, and
    // slapping .flat on ours overrode it to window-fg (the color
    // mismatch). So: same classes libadwaita uses (bare text-button),
    // a 'response-area' parent box, pill geometry replicated since
    // that look lives in '.alert-dialog .text-button.pill' which
    // won't match our box name.
    const btnRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                spacing: 6,
                                css_classes: ['response-area'],
                                halign: Gtk.Align.CENTER});
    const cancel = new Gtk.Button({label: _('Cancel')});
    cancel.add_css_class('pill');
    cancel.set_size_request(124, 24);
    cancel.connect('clicked', () => dlg.force_close());
    const btn = new Gtk.Button({label: acceptLabel});
    btn.add_css_class('suggested-action');
    btn.add_css_class('pill');
    btn.set_size_request(124, 24);
    btnRow.append(cancel);
    btnRow.append(btn);
    box.append(btnRow);

    let done = false;
    const accept = () => {
        if (done)
            return;   // Enter, ✓-apply and the button can race
        const text = entry.get_text().trim();
        if (!text)
            return;
        done = true;
        onAccept?.(text);
        dlg.force_close();
    };
    entry.connect('entry-activated', accept);
    entry.connect('apply', accept);   // EntryRow's own ✓ button
    btn.connect('clicked', accept);

    const clamp = new Adw.Clamp({maximum_size: 360, child: box});
    bin.set_child(clamp);
    dlg.set_child(bin);
    dlg.connect('closed', () => { done = false; });
    dlg.present(parent);
    return dlg;
}

function _(s) {
    return s;   // no-op gettext hook keeps msgids greppable
}
