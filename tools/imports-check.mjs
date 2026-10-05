/* imports-check.mjs — part of TickerGlass
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
/* imports-check.mjs — smoke-import every module that doesn't need the shell
 * (shared/*). Run: gjs -m tools/imports-check.mjs                      */

const mods = ['../shared/fmt.js', '../shared/mock.js', '../shared/yahoo.js',
              '../shared/spark.js'];

for (const m of mods) {
    await import(m);
    console.log(`ok  ${m}`);
}

/* quick behavioural smoke on formatters */
const F = await import('../shared/fmt.js');
const assert = (c, m) => { if (!c) throw new Error(`assert failed: ${m}`); };
assert(F.parseWatchlists('not json').length === 1, 'watchlist fallback');
assert(F.parseWatchlists('[{"id":"a","symbols":[]}]')[0].name === 'a', 'name default');
assert(F.fmtPrice(232.1, 'USD').includes('232.10'), 'price 2dp');
assert(F.fmtPct(0.01234).startsWith('+'), 'pct sign');
assert(F.fmtPct(-0.01234).startsWith('−'), 'pct sign minus');
assert(F.fmtCompact(1.23e9).length < 8, 'compact');
assert(F.intervalFor('1d', 'auto') === '5m', 'interval 1d');
assert(F.intervalFor('5y', '5m') === '1wk', 'interval clamp');
/* mock client smoke */
const {DemoClient} = await import('../shared/mock.js');
const d = new DemoClient();
const q = await d.quotes(['AAPL', '^GSPC', 'BTC-USD']);
assert(q.quotes.length === 3 && q.quotes[0].spark.length > 10, 'demo quotes');
const hh = await d.history('AAPL', '1mo', 'auto');
assert(hh.points.length > 10 && hh.interval === '1h', 'demo history');
console.log('ok  mock client smoke');

const {subsample} = await import('../shared/yahoo.js');
const ss = subsample([...Array(100).keys()], 10);
assert(ss.length === 10 && ss[0] === 0 && ss.at(-1) === 99, 'subsample pins ends');

console.log('\nall modules import clean ✓');
