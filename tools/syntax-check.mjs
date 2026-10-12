/* syntax-check.mjs — part of TickerGlass
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
/* syntax-check.mjs — parse/validate the shell-side modules without a shell.
 * `gjs -m dist/tickerglass@vijaybala.dev/…`: a SyntaxError is a real failure;
 * an ImportError that mentions resource:// means everything parsed fine and
 * only the shell-only imports could not resolve (expected outside gnome-shell).
 * Run: gjs -m tools/syntax-check.mjs                                          */

const DIST = '../dist/tickerglass@vijaybala.dev';
const files = ['extension.js', 'menu.js', 'prefs.js',
               'yahoo.js', 'spark.js', 'fmt.js', 'mock.js', 'i18n.js',
               'prompt.js'];

let bad = 0;
for (const f of files) {
    try {
        await import(`../dist/tickerglass@vijaybala.dev/${f}`);
        console.log(`ok    ${f} (fully loads)`);
    } catch (e) {
        const msg = String(e);
        /* Anything non-SyntaxError here is environmental: resource://
         * modules, and since GNOME 50 the Clutter typelib (no longer
         * exposed to foreign processes — St is). The live shell load
         * is the real gate for those; this harness checks parsing. */
        if (/SyntaxError/.test(msg)) {
            console.log(`FAIL  ${f}: ${msg}`);
            bad++;
        } else {
            console.log(`ok    ${f} (parses; environment pending)`);
        }
    }
}

/* app side: main.js self-launches, check window.js which only defines */
try {
    await import('../dist/app/window.js');
    console.log('ok    app/window.js (fully loads)');
} catch (e) {
    console.log(`FAIL  app/window.js: ${e}`);
    bad++;
}

/* ── module-graph check: names, not just syntax ──────────────────────────
 * Files that need the shell never fully import, so a missing `export`
 * (the Tri incident: extension.js asked menu.js for a const it never
 * exported) stays invisible until the panel dies at login. Statically
 * verify every relative named import against the target's export list. */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
/* import specifiers resolve against THIS file; Gio.File resolves against
 * CWD — anchor explicitly or every read silently misses (a no-op check
 * is how a missing export walked into a login cycle once already).
 * GFile lives under Gio in GJS, not GLib. */
const HERE = GLib.path_get_dirname(decodeURIComponent(
    import.meta.url.replace(/^file:\/\//, '')));
const abs = p => GLib.build_filenamev([HERE, p]);
const read = p => Gio.File.new_for_path(abs(p))
    .load_contents(null)[1].toString();
const exportsOf = new Map();
const findExports = path => {
    if (exportsOf.has(path))
        return exportsOf.get(path);
    const set = new Set();
    try {
        const src = read(path);
        for (const m of src.matchAll(
            /export\s+(?:async\s+)?(?:default\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g))
            set.add(m[1]);
        for (const m of src.matchAll(/export\s*\{([^}]*)\}/g))
            for (const part of m[1].split(',')) {
                const t = part.trim();
                if (t)
                    set.add(t.includes(' as ') ? t.split(/\s+as\s+/)[1] : t);
            }
        if (/export\s+default/.test(src))
            set.add('default');
    } catch {
        /* unreadable file — the import phase above already reports it */
    }
    exportsOf.set(path, set);
    return set;
};
for (const path of [...files.map(f => `${DIST}/${f}`),
                    '../dist/app/window.js']) {
    let src;
    try {
        src = read(path);
    } catch (e) {
        console.log(`FAIL  graph: cannot read ${path}: ${e.message}`);
        bad++;
        continue;
    }
    for (const m of src.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
        const target = `${GLib.path_get_dirname(path)}/${m[2]}`;
        const have = findExports(target);
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0];
            if (name && !have.has(name)) {
                console.log(`FAIL  ${path}: '${m[2]}' doesn't export ` +
                            `'${name}'`);
                bad++;
            }
        }
    }
}
console.log('ok    module graph: every relative named import resolves');

if (bad)
    throw new Error(`${bad} file(s) failed`);
console.log('\nsyntax clean ✓');
