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
 * IO mirrors shared/yahoo.js's classification cache idiom —
 * this GJS/GIO build lacks FileCreateFlags/replace_bytes and
 * load_bytes.get_data, so: TextDecoder over async-read bytes to
 * read, replace + write_bytes + close to write. The read is async
 * because this file ships inside the shell extension: no
 * synchronous file IO in shell code (EGO-X-004). Cache is a
 * luxury; every call is fire-and-forget and resolves null on
 * any failure.
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
        // with-parents: ~/.cache itself may not exist yet on a
        // minimal first login — one-level make_directory would
        // silently lose every snapshot there
        GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
        const out = new GLib.Bytes(new TextEncoder().encode(
            JSON.stringify(snap)));
        const st = file.replace(null, false, 0, null);
        st.write_bytes(out, null);
        st.close(null);
    } catch { /* cache is a luxury; never break a round over it */ }
}

function _parseSnapshot(bytes, maxAgeSec) {
    try {
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

/* Resolves the snapshot, or null when absent, corrupt,
 * wrong-version, too old, or empty — callers treat null as
 * "no cache", which is exactly what it is. Async because this
 * module ships in the shell: the warm-boot paint lands a beat
 * after enable instead of blocking it on disk. */
export function loadSnapshotAsync(maxAgeSec = 24 * 3600) {
    return new Promise(resolve => {
        try {
            cacheFile().load_contents_async(null, (file, res) => {
                try {
                    const [ok, bytes] = file.load_contents_finish(res);
                    resolve(ok && bytes
                        ? _parseSnapshot(bytes, maxAgeSec) : null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}
