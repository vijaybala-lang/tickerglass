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
    // Cancel + Accept as an even two-button row: Adw.Dialog honors
    // Escape via can_close, but a dialog with only a suggested-action
    // button leaves no visible way OUT — the eye goes to buttons.
    const btnRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL,
                                spacing: 6});
    const cancel = new Gtk.Button({label: _('Cancel'), hexpand: true});
    cancel.add_css_class('flat');
    cancel.connect('clicked', () => dlg.force_close());
    const btn = new Gtk.Button({label: acceptLabel, hexpand: true});
    btn.add_css_class('suggested-action');
    btnRow.append(cancel);
    btnRow.append(btn);
    box.append(btnRow);

    let done = false;
    const accept = () => {
        const text = entry.get_text().trim();
        if (!text)
            return;
        done = true;
        onAccept?.(text);
        dlg.force_close();
    };
    entry.connect('entry-activated', accept);
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
