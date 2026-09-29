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
    const btn = new Gtk.Button({label: acceptLabel,
                                halign: Gtk.Align.CENTER});
    btn.add_css_class('suggested-action');
    box.append(btn);

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
