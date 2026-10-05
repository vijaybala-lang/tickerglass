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
        if (/resource:\/\/|Cannot resolve module/.test(msg))
            console.log(`ok    ${f} (parses; shell-only imports pending)`);
        else if (/SyntaxError/.test(msg)) {
            console.log(`FAIL  ${f}: ${msg}`);
            bad++;
        } else {
            console.log(`FAIL  ${f}: ${msg}`);
            bad++;
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

if (bad)
    throw new Error(`${bad} file(s) failed`);
console.log('\nsyntax clean ✓');
