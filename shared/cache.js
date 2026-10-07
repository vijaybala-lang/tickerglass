/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * TickerGlass — shared on-disk quote snapshot.
 *
 * Both processes (the app and the shell extension) used to own private
 * quote sets and private pollers: double traffic against Yahoo, and a
 * cold app boot always meant a blank table until the first round landed.
 * This module is the disk half of the fix — whoever fetches writes the
 * snapshot, whoever starts reads it and paints immediately, updating in
 * the background. The D-Bus provider in extension.js is the live half
 * (push + single poller); the file is the half that survives without
 * either process running, so the pairing degrades gracefully: extension
 * off → app still boots warm and polls itself; app never launched → the
 * extension still fills the file.
 *
 * Layout: ~/.cache/tickerglass/quotes.json
 *   {v, at (unix s), source ('yahoo'|'nasdaq'), quotes: [...]}
 *
 * IO mirrors shared/yahoo.js's classification cache idiom exactly —
 * this GJS/GIO build lacks FileCreateFlags/replace_bytes and
 * load_bytes.get_data, so: load_contents + TextDecoder to read,
 * replace + write_bytes + close to write. Cache is a luxury; every
 * call is fire-and-forget.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SNAPSHOT_VERSION = 1;

function cacheFile() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_cache_dir(), 'tickerglass', 'quotes.json']));
}

/* one shared shape for the file AND the D-Bus payload — the disk
 * snapshot and the live push can never drift apart */
export function makeSnapshot(source, quotes, atWall) {
    return {v: SNAPSHOT_VERSION, at: atWall, source, quotes};
}

export function snapshotJSON(snap) {
    try {
        return snap && snap.quotes?.length ? JSON.stringify(snap) : null;
    } catch {
        return null;
    }
}

/* write-if-newest is NOT enforced here: last writer wins is fine — the
 * writers are the same user's two processes, seconds apart at worst */
export function saveSnapshot(snap) {
    try {
        if (!snap || !snap.quotes?.length)
            return;
        const file = cacheFile();
        const dir = file.get_parent();
        try {
            dir.make_directory(null);      // EXISTS just means already fine
        } catch { /* already there */ }
        const out = new GLib.Bytes(new TextEncoder().encode(
            JSON.stringify(snap)));
        const st = file.replace(null, false, 0, null);
        st.write_bytes(out, null);
        st.close(null);
    } catch { /* cache is a luxury; never break a round over it */ }
}

/* null when absent, corrupt, wrong-version, too old, or empty —
 * callers treat null as "no cache", which is exactly what it is */
export function loadSnapshot(maxAgeSec = 24 * 3600) {
    try {
        const [ok, bytes] = cacheFile().load_contents(null);
        if (!ok || !bytes)
            return null;
        const snap = JSON.parse(new TextDecoder().decode(bytes));
        if (snap?.v !== SNAPSHOT_VERSION || !Array.isArray(snap.quotes) ||
                !snap.quotes.length)
            return null;
        const age = GLib.get_real_time() / 1e6 - (snap.at ?? 0);
        return age <= maxAgeSec ? snap : null;
    } catch {
        return null;
    }
}
