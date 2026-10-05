/* fetch.js — part of TickerGlass
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
/* fetch.js — the common data-fetch layer shared by every surface:
 * quote rounds (sidebar rows, hero pill, table, tiles), chart
 * history (hero + compare), and the movers screener all go through
 * one DataFetcher instead of per-call-site caches grown ad hoc.
 *
 * Semantics it owns:
 *  - in-flight dedup: concurrent fetches of the same key join the
 *    one producer promise (no duplicate network from watcher storms)
 *  - TTL result cache: ttl=0 → cache-never-serves (quote rounds:
 *    every round must hit the network, but joiners still dedup)
 *  - force: bypass cache AND join (explicit user refresh)
 *  - invalidate(prefix): source switches / manual refresh purge
 *  - health(): per key-prefix {ok, at, ms, err} of the last REAL
 *    (non-cache, non-join) settle — the source-health menu reads it
 *
 * It deliberately does NOT do: scheduling, retry/backoff (the
 * client owns rate-limit backoff), or streaming — onQuote callbacks
 * ride inside the producer the caller supplies. */

import GLib from 'gi://GLib';

const nowS = () => GLib.get_monotonic_time() / 1e6;

export class DataFetcher {
    constructor() {
        this._inflight = new Map();   // key → promise
        this._cache = new Map();      // key → {at, value}
        this._health = new Map();     // key-prefix → settle record
        this.onHealth = null;         // set by the UI: called on record
    }

    /**
     * fetch(key, producer, {ttl = 0, force = false})
     * producer: () => value | Promise<value>
     * ttl in seconds; 0 means never serve from cache (dedup only).
     * Errors are NOT cached; the next call retries.
     */
    async fetch(key, producer, {ttl = 0, force = false} = {}) {
        const hit = this._cache.get(key);
        if (!force && ttl > 0 && hit && nowS() - hit.at < ttl)
            return hit.value;
        if (!force) {
            const fly = this._inflight.get(key);
            if (fly)
                return fly;
        }
        const cat = key.split(':')[0];
        const t0 = nowS();
        const p = Promise.resolve().then(producer).then(
            v => {
                this._inflight.delete(key);
                this._cache.set(key, {at: nowS(), value: v});
                this._note(cat, true, nowS() - t0, null);
                return v;
            },
            e => {
                this._inflight.delete(key);
                this._note(cat, false, nowS() - t0, e);
                throw e;
            });
        this._inflight.set(key, p);
        return p;
    }

    /* the last REAL settle per category (cache hits and joiners are
     * invisible — health means "when did the wire last answer") */
    _note(cat, ok, secs, err) {
        this._health.set(cat, {
            ok,
            at: GLib.get_real_time() / 1e6,        // wall: age across idle
            ms: Math.round(secs * 1000),
            err: ok ? null
                : String(err?.message ?? err ?? 'error')
                    .replace(/\s+/g, ' ').slice(0, 70),
        });
        if (this.onHealth)
            try { this.onHealth(cat); } catch { /* UI not wired */ }
    }

    health() {
        return [...this._health].map(([cat, r]) => ({cat, ...r}));
    }

    /* last settled value, fresh or not (stale-while-revalidate UIs
     * paint peek() while the next fetch runs) */
    peek(key) {
        const h = this._cache.get(key);
        return h ? h.value : null;
    }

    age(key) {
        const h = this._cache.get(key);
        return h ? nowS() - h.at : Infinity;
    }

    invalidate(prefix = '') {
        for (const k of [...this._cache.keys()])
            if (k.startsWith(prefix))
                this._cache.delete(k);
        // in-flight calls are left alone: they settle into orphan
        // cache entries nobody re-reads after purge
    }
}
