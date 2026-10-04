/* yahoo.js — Yahoo Finance client (no API key), a Nasdaq site-API client
 * (keyless, US stocks/ETFs), and the MarketClient facade that switches
 * between 'yahoo', 'yahoo-relay', 'nasdaq' and 'demo'. Same conventions as
 * weatherglass/weather.js, except the connection story: shared pooled
 * Soup.Sessions (see sessionFor), promise-wrapped send_and_read_async,
 * GCancellable per request, plain-object results.
 *
 * Yahoo is picky about cookie-less bots (HTTP 429) and gates its batch
 * endpoints behind a session cookie + "crumb". Strategy:
 *   1. hit /v7/finance/spark (one request for all quotes + sparklines);
 *   2. on 401/403 → bootstrap cookies via fc.yahoo.com, fetch the crumb
 *      from /v1/test/getcrumb, retry with &crumb=…;
 *   3. on anything else → fall back to one /v8/finance/chart request per
 *      symbol (keyless, richer meta).
 * 429s penalise the host we used and back off exponentially; stale data
 * stays on screen meanwhile. */

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import Gio from 'gi://Gio';
import {intervalFor, RANGE_DAYS} from './fmt.js';
import {DemoClient} from './mock.js';

/* Connection reuse is everything: Soup.Session owns the connection pool,
 * and a fresh session per request pays a full TLS handshake (150–350ms)
 * every single call — a 12-symbol boot made ~27 of them. Cache one
 * session per (UA, timeout) pair and share it across clients and refresh
 * rounds: keep-alive and HTTP/2 multiplexing finally work for us.
 * Deadline cancels are per-request (GCancellable), never session.abort(),
 * which would torch the whole pool over one stalled socket. */
const SESSIONS = new Map();
function sessionFor(ua, timeout) {
    const key = `${ua}|${timeout}`;
    let s = SESSIONS.get(key);
    if (!s)
        SESSIONS.set(key, s = new Soup.Session({user_agent: ua, timeout}));
    return s;
}

/* Read a message's HTTP code defensively: some distro builds ship a
 * Soup-3.0 typelib whose get_status() return is annotated as the Status
 * *enum*, which throws for codes it doesn't list (429 among them). The
 * exception message leaks the number, so recover it from there. */
function httpStatus(msg) {
    try {
        return msg.get_status();
    } catch (e) {
        const m = /(\d{3}) is not a valid value/.exec(String(e?.message ?? e));
        return m ? +m[1] : 0;
    }
}

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

/* Optional fetch relay (public reader proxy). When Yahoo's edge distrusts
 * our egress IP (HTTP 429 land — CGNAT pools), the same well-formed
 * request through a clean fetcher's IP passes. 'yahoo-relay' data-source
 * routes every Yahoo call through this prefix. */
export const RELAY = 'https://r.jina.ai/';

/* Browser-ish UA: Yahoo serves the same 429 to python-yfinance-style agents,
 * but a normal Firefox UA gets through far more reliably. */
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

class HttpError extends Error {
    constructor(status, body) {
        super(`HTTP ${status}`);
        this.status = status;
        this.body = body ?? '';
    }
}

export class YahooClient {
    constructor() {
        this.name = 'yahoo';
        this._crumb = null;                 // string | null (null = not bootstrapped)
        this._penalty = new Map();          // host → monotonic-sec until penalised
        this._consecFail = 0;
        this._relay = null;                 // null | relay prefix (see RELAY)
    }

    setRelay(prefix) {
        this._relay = prefix || null;
    }

    /** Seconds until we may hit the network again (0 = now). */
    retryIn() {
        const now = GLib.get_monotonic_time() / 1e6;
        let soon = 0;
        for (const until of this._penalty.values())
            soon = Math.max(soon, until);
        return Math.max(0, Math.ceil(soon - now));
    }

    _noteFailure() {
        this._consecFail++;
        return Math.min(600, 30 * 2 ** Math.min(this._consecFail, 5));
    }

    _noteSuccess() {
        this._consecFail = 0;
        this._penalty.clear();
    }

    _host() {
        const now = GLib.get_monotonic_time() / 1e6;
        const live = HOSTS.filter(h => (this._penalty.get(h) ?? 0) <= now);
        if (live.length)
            return live[(this._pick = (this._pick ?? 0) + 1) % live.length];
        // every host penalised → cheapest one back first
        return HOSTS.reduce((a, b) =>
            (this._penalty.get(a) ?? 0) <= (this._penalty.get(b) ?? 0) ? a : b);
    }

    _get(url, {json = true, deadline = 40, ua: uaWant = null} = {}) {
        return new Promise((resolve, reject) => {
            // relays 403 browser-spoofing UAs from non-browsers — announce
            // ourselves honestly there; keep the Firefox one for Yahoo direct.
            // The screener opts into the honest UA too: Yahoo's edge 429s
            // cookie-less browser impersonation on that endpoint, while an
            // honest client gets a plain 200 (verified against live Yahoo)
            const ua = uaWant ?? (this._relay
                ? 'TickerGlass/1.0 (GNOME; tickerglass@vijaybala.dev)'
                : UA);
            const session = sessionFor(ua, 30);
            const msg = Soup.Message.new('GET',
                this._relay ? this._relay + url : url);
            if (!msg) {
                reject(new Error(`bad url: ${url}`));
                return;
            }
            msg.request_headers.append('Accept',
                json ? 'application/json,text/plain,*/*' : 'text/plain,*/*');
            msg.request_headers.append('Accept-Language', 'en-US,en;q=0.5');
            if (this._relay)
                msg.request_headers.append('X-Return-Format', 'text');
            // hard deadline: libsoup's timeout only counts gaps between
            // packets, and a half-dead CGNAT connection can dribble forever
            let done = false;
            const cancel = new Gio.Cancellable();
            const timer = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, deadline, () => {
                    if (done)
                        return GLib.SOURCE_REMOVE;
                    done = true;
                    cancel.cancel();      // drops this request, keeps the pool
                    reject(new Error('timeout'));
                    return GLib.SOURCE_REMOVE;
                });
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancel,
                                        (sess, res) => {
                let body = '';
                try {
                    const bytes = sess.send_and_read_finish(res);
                    body = bytes ? new TextDecoder().decode(bytes.get_data()) : '';
                    const st = httpStatus(msg);
                    if (done)                    // deadline already claimed it
                        return;
                    done = true;
                    GLib.source_remove(timer);
                    if (st === 429)
                        throw new HttpError(429, body);
                    if (st >= 400)
                        throw new HttpError(st, body);
                    // defensive: if a relay ever wraps its answer in reader
                    // chrome, cut to the payload
                    if (json && body && body[0] !== '{' && body[0] !== '[') {
                        const cut = Math.max(
                            body.indexOf('{'), body.indexOf('['));
                        if (cut > 0)
                            body = body.slice(cut);
                    }
                    resolve(json ? JSON.parse(body) : body);
                } catch (e) {
                    if (done)                    // the deadline already won
                        return;
                    done = true;
                    GLib.source_remove(timer);
                    reject(e instanceof HttpError ? e
                          : new Error(e.message || 'parse error'));
                }
            });
        });
    }

    async _try(label, url, opts) {
        const host = this._host();
        const target = url.replace(/\{\{host\}\}/g, host);
        try {
            const r = await this._get(target, opts);
            this._noteSuccess();
            return r;
        } catch (e) {
            if (/HTTP 429/.test(e.message)) {
                const secs = this._noteFailure();
                this._penalty.set(host,
                    GLib.get_monotonic_time() / 1e6 + secs);
                log(`TickerGlass: ${label} rate-limited, backing off ${secs}s`);
                // some deployments gate with 429 rather than 401 — bootstrap
                // cookies once and give the same call one crumb-bearing try
                if (this._crumb === null && !this._relay &&
                    !target.includes('crumb=')) {
                    const crumb = await this._bootstrapCrumb();
                    if (crumb) {
                        const withCrumb = target +
                            `&crumb=${encodeURIComponent(crumb)}`;
                        try {
                            const r2 = await this._get(withCrumb, opts);
                            this._noteSuccess();
                            return r2;
                        } catch { /* fall through */ }
                    }
                }
            }
            throw e;
        }
    }

    /* cookie + crumb handshake: fc.yahoo.com 404s but sets A1/A3 cookies on
     * the session jar; getcrumb then echoes the crumb for that cookie.
     * Race-bounded: neither await may strand a 429-retry path forever. */
    _bootstrapCrumb() {
        // re-entrancy matters: the 15s watchdog aborts this._bootSess,
        // so two overlapping bootstraps would let one's watchdog kill
        // the other's live handshake — share the in-flight one instead
        if (this._crumbPend)
            return this._crumbPend;
        const p = new Promise(res => {
            let settled = false;
            const done = v => {
                if (settled)
                    return;
                settled = true;
                try { this._bootSess?.abort(); } catch {}
                res(v);
            };
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                done('');       // timed out: treat as "no crumb available"
                return GLib.SOURCE_REMOVE;
            });
            this._innerCrumb().then(done).catch(() => done(''));
        });
        this._crumbPend = p;
        p.then(() => { this._crumbPend = null; },
               () => { this._crumbPend = null; });
        return p;
    }

    async _innerCrumb() {
        const session = new Soup.Session({user_agent: UA, timeout: 15});
        this._bootSess = session;
        try {
            const seed = Soup.Message.new('GET', 'https://fc.yahoo.com');
            await new Promise(res => session.send_and_read_async(
                seed, GLib.PRIORITY_DEFAULT, null, (s, r) => {
                    try { seed.send_and_read_finish?.(r); } catch {}
                    try { s.send_and_read_finish(r); } catch {}
                    res();
                }));
            const crumbMsg = Soup.Message.new('GET',
                `https://${this._host()}/v1/test/getcrumb`);
            const crumb = await new Promise(res => {
                session.send_and_read_async(crumbMsg, GLib.PRIORITY_DEFAULT,
                    null, (s, r) => {
                        try {
                            const b = s.send_and_read_finish(r);
                            res(b ? new TextDecoder().decode(b.get_data()).trim() : '');
                        } catch {
                            res('');
                        }
                    });
            });
            // crumbs look like "a1B2+c3d4e5f6=" — reject error bodies that
            // would otherwise masquerade as crumbs (e.g. "Too Many Requests")
            if (crumb && /^[A-Za-z0-9+/=._-]{8,24}$/.test(crumb)) {
                this._crumb = crumb;
                return crumb;
            }
        } finally {
            session.abort();
            this._bootSess = null;
        }
        this._crumb = '';
        return '';
    }

    /* ── quotes ────────────────────────────────────────────────────────── */

    /** Batched spark endpoint: quotes + inline day series in ONE request. */
    async _quotesSpark(symbols, sparkRange) {
        const iv = sparkRange === '1d' ? '15m'
            : sparkRange === '5d' ? '1h' : '1d';
        const url = `https://{{host}}/v7/finance/spark?symbols=` +
            `${encodeURIComponent(symbols.join(','))}` +
            `&range=${sparkRange}&interval=${iv}` +
            (this._crumb ? `&crumb=${encodeURIComponent(this._crumb)}` : '');
        const data = await this._try('spark', url);
        return symbols.map(sym => {
            const res = data?.symbols?.[sym]?.chart?.result?.[0]
                     ?? data?.chart?.result?.find(r => r.meta?.symbol === sym);
            if (!res)
                throw new Error('spark: symbol missing');
            const closes = res.indicators?.quote?.[0]?.close ?? [];
            const series = closes.filter(v => v !== null);
            return {meta: res.meta, spark: series.length > 1 ? series : null};
        });
    }

    /** Keyless per-symbol chart meta (richer; always works when not 429'd). */
    async _quotesChart(symbol, sparkRange) {
        const iv = sparkRange === '5d' ? '1d' : '15m';
        const url = `https://{{host}}/v8/finance/chart/` +
            `${encodeURIComponent(symbol)}?range=${sparkRange}` +
            `&interval=${iv}&includePrePost=true`;
        const data = await this._try(`chart ${symbol}`, url);
        const res = data?.chart?.result?.[0];
        if (!res?.meta)
            throw new Error(`chart ${symbol}: empty`);
        const closes = res.indicators?.quote?.[0]?.close ?? [];
        const series = closes.filter(v => v !== null);
        return {meta: res.meta, spark: series.length > 1 ? series : null};
    }

    async quotes(symbols, {sparkRange = '1d'} = {}) {
        let parts = null;
        try {
            parts = await this._quotesSpark(symbols, sparkRange);
        } catch (e) {
            if (/HTTP 4(01|03|04)/.test(e.message) && this._crumb === null &&
                !this._relay) {
                await this._bootstrapCrumb();
                try {
                    parts = await this._quotesSpark(symbols, sparkRange);
                } catch { /* fall through to per-symbol */ }
            }
        }
        if (!parts) {
            parts = await Promise.all(symbols.map(s =>
                this._quotesChart(s, sparkRange).catch(() => null)));
        }
        const at = Math.floor(GLib.get_real_time() / 1e6);
        const quotes = parts.map((part, i) =>
            part ? normalizeQuote(symbols[i], part.meta, part.spark)
                 : {symbol: symbols[i], name: symbols[i], price: null,
                    error: true, spark: null});
        return {at, quotes};
    }

    /* ── history ───────────────────────────────────────────────────────── */

    async history(symbol, range = '1d', interval = 'auto') {
        const iv = intervalFor(range, interval);
        const apiRange = range === '52w' ? '1y' : range;
        const url = r => `https://{{host}}/v8/finance/chart/` +
            `${encodeURIComponent(symbol)}?range=${r}&interval=${iv}` +
            `&includePrePost=false`;
        let data;
        try {
            data = await this._try(`history ${symbol}`, url(apiRange));
        } catch (e) {
            // some deployments reject 7d — degrade to the 5-trading-day view
            if (apiRange === '7d')
                data = await this._try(`history ${symbol}`, url('5d'));
            else
                throw e;
        }
        const res = data?.chart?.result?.[0];
        if (!res?.meta)
            throw new Error(`history ${symbol}: empty`);
        const ts = res.timestamp ?? [];
        const q = res.indicators?.quote?.[0] ?? {};
        const points = [];
        for (let i = 0; i < ts.length; i++) {
            const c = q.close?.[i] ?? null;
            if (c === null || !Number.isFinite(c))
                continue;
            points.push({
                t: ts[i],
                c,
                o: q.open?.[i] ?? c,
                h: q.high?.[i] ?? Math.max(c, q.open?.[i] ?? c),
                l: q.low?.[i] ?? Math.min(c, q.open?.[i] ?? c),
                v: q.volume?.[i] ?? 0,
            });
        }
        const m = res.meta;
        const trade = m.currentTradingPeriod?.regular;
        return {
            symbol, range, interval: iv,
            meta: {
                price: m.regularMarketPrice ?? points.at(-1)?.c ?? null,
                prevClose: m.chartPreviousClose ?? m.previousClose ?? null,
                currency: m.currency ?? 'USD',
                exchange: m.fullExchangeName ?? m.exchangeName ?? '',
                state: m.marketState ?? 'REGULAR',
                tz: m.exchangeTimezoneName ?? 'UTC',
                marketTime: m.regularMarketTime ?? null,
                wk52High: m.fiftyTwoWeekHigh ?? null,
                wk52Low: m.fiftyTwoWeekLow ?? null,
                dayHigh: m.regularMarketDayHigh ?? null,
                dayLow: m.regularMarketDayLow ?? null,
                open: m.regularMarketOpen ?? null,
                volume: m.regularMarketVolume ?? null,
                sessionStart: trade?.start ?? null,
                sessionEnd: trade?.end ?? null,
            },
            points,
        };
    }

    /* ── search ────────────────────────────────────────────────────────── */

    async search(q) {
        const url = `https://{{host}}/v1/finance/search?q=` +
            `${encodeURIComponent(q)}&quotesCount=10&newsCount=0` +
            `&enableFuzzyQuery=true&lang=en-US`;
        const data = await this._try('search', url);
        return (data?.quotes ?? [])
            .filter(r => r.quoteType && r.quoteType !== 'NEWS' && r.symbol)
            .slice(0, 10)
            .map(r => ({
                symbol: r.symbol,
                name: r.shortname ?? r.longname ?? r.exchDisp ?? r.symbol,
                exchange: r.exchDisp ?? r.exchange ?? '',
                type: r.quoteType ?? '',
                currency: r.currency ?? '',
            }));
    }

    /* ── news ──────────────────────────────────────────────────────────── */

    /** Recent stories for a symbol via the search endpoint (keyless). */
    async news(symbol) {
        const url = `https://{{host}}/v1/finance/search?q=` +
            `${encodeURIComponent(symbol)}&quotesCount=1&newsCount=15` +
            `&enableFuzzyQuery=false&lang=en-US`;
        const data = await this._try(`news ${symbol}`, url);
        return (data?.news ?? [])
            .filter(n => n.title && n.link)
            .slice(0, 12)
            .map(n => {
                // providerPublishTime is epoch seconds in practice, but some
                // variants send milliseconds — normalize both
                const t = n.providerPublishTime ?? n.originallyCreated ?? 0;
                return {
                    title: n.title,
                    source: n.publisher ?? '',
                    url: n.link,
                    at: t > 1e12 ? t / 1000 : t,
                };
            });
    }

    /* ── market movers ─────────────────────────────────────────────────── */

    /** Yahoo's predefined screeners: 'day_gainers' | 'day_losers' |
     *  'most_actives'. The endpoint gates behind the same cookie+crumb
     *  handshake the spark path bootstraps on demand — here 401 is the
     *  expected first answer, so bootstrap up front instead of paying
     *  a guaranteed failure per call. */
    async screener(scrId, count = 12) {
        if (!this._crumb && !this._relay) {
            // one handshake shared by concurrent callers
            this._crumbBoot ??= this._bootstrapCrumb();
            await this._crumbBoot;
            this._crumbBoot = null;
        }
        const url = `https://{{host}}/v1/finance/screener/predefined/saved` +
            `?scrIds=${scrId}&count=${count}&formatted=false` +
            (this._crumb && !this._relay
                ? `&crumb=${encodeURIComponent(this._crumb)}` : '');
        // garnish budget: movers must never make the app wait 40s;
        // honest UA (see _get) — the spoofed browser one earns a 429
        const HONEST = 'TickerGlass/1.0 (GNOME; tickerglass@vijaybala.dev)';
        const data = await this._try(`screener ${scrId}`, url,
            {deadline: 12, ua: HONEST});
        // payload shape: {finance: {result: [{quotes: [...]}]}}
        const quotes = data?.finance?.result?.[0]?.quotes ?? [];
        return quotes
            // formatted=false payloads speak regularMarketPrice/pct; the
            // formatted variants send lastPrice/pctChange — take whichever
            .filter(q => q?.symbol && Number.isFinite(
                q.lastPrice ?? q.regularMarketPrice))
            .map(q => ({
                symbol: q.symbol,
                name: q.shortname ?? q.shortName ?? q.longName
                    ?? q.longname ?? q.symbol,
                price: q.lastPrice ?? q.regularMarketPrice,
                changePct: Number.isFinite(q.pctChange)
                    ? q.pctChange / 100
                    : Number.isFinite(q.regularMarketChangePercent)
                        ? q.regularMarketChangePercent / 100 : null,
                spark: null, error: false,
                currency: q.currency ?? 'USD',
                exchange: q.exchDisp ?? q.fullExchangeName
                    ?? q.exchange ?? '',
                state: q.marketState ?? 'REGULAR',
            }));
    }
}

/* meta (v8/v7 spark) → our canonical Quote. Extended-hours prices ride
 * through when that's the live session. */
function normalizeQuote(symbol, m, spark) {
    const state = m.marketState ?? 'REGULAR';
    let price = m.regularMarketPrice ?? null;
    let prev = m.chartPreviousClose ?? m.previousClose ?? null;
    if (state === 'PRE' && m.preMarketPrice != null) {
        prev = price ?? prev;
        price = m.preMarketPrice;
    } else if (state === 'POST' && m.postMarketPrice != null) {
        prev = price ?? prev;
        price = m.postMarketPrice;
    }
    const change = price != null && prev != null ? price - prev : null;
    return {
        symbol,
        name: m.longName ?? m.shortName ?? m.symbol ?? symbol,
        price, prevClose: prev, change,
        changePct: change != null && prev ? change / prev : null,
        dayHigh: m.regularMarketDayHigh ?? null,
        dayLow: m.regularMarketDayLow ?? null,
        open: m.regularMarketOpen ?? null,
        volume: m.regularMarketVolume ?? null,
        wk52High: m.fiftyTwoWeekHigh ?? null,
        wk52Low: m.fiftyTwoWeekLow ?? null,
        currency: m.currency ?? 'USD',
        exchange: m.fullExchangeName ?? m.exchangeName ?? '',
        type: m.instrumentType ?? '',
        state,
        tz: m.exchangeTimezoneName ?? 'UTC',
        marketTime: m.regularMarketTime ?? null,
        spark: spark ? subsample(spark, 40) : null,
    };
}

/* Keep first + last, evenly pick the rest — preserves day open and the tick
 * we just printed no matter how coarse the source interval was. */
export function subsample(arr, maxN) {
    if (arr.length <= maxN)
        return arr;
    const out = [arr[0]];
    const step = (arr.length - 1) / (maxN - 1);
    for (let i = 1; i < maxN - 1; i++)
        out.push(arr[Math.round(i * step)]);
    out.push(arr[arr.length - 1]);
    return out;
}

/* ── Nasdaq client ────────────────────────────────────────────────────── */

/* Nasdaq's public site API: keyless, covers US-listed stocks and ETFs on
 * any exchange (verified: NYSE, NasdaqGS, Arca), and answers polite
 * browser-shaped requests from networks Yahoo blanket-429s. Symbols it
 * does not list (crypto, indices) fall through to the relayed Yahoo
 * client handed in as `back`. No batch endpoint — requests are issued
 * sequentially to stay courteous. */

const NASDAQ_API = 'https://api.nasdaq.com';

const NASDAQ_STATE = {
    Regular: 'REGULAR', 'Pre-Market': 'PRE', 'Post-Market': 'POST',
    Closed: 'CLOSED',
};

/* "$330.32", "-0.81%", "36,306,585", "N/A" → number | null */
function parseNum(s) {
    if (s == null || s === '')
        return null;
    const t = String(s).replace(/[$\s,%]/g, '');
    if (!t || t === 'N/A' || t === 'NA' || t === '--')
        return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
}

/* "09/30/2026" → epoch seconds at noon ET — daily bars land on the right
 * calendar day no matter the machine's timezone */
function parseMDY(s) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s ?? ''));
    return m ? Date.UTC(+m[3], +m[1] - 1, +m[2], 16) / 1000 : 0;
}

/* Date → 'YYYY-MM-DD' (the wire format these endpoints accept) */
function mdym(d) {
    return `${d.getUTCFullYear()}-` +
        `${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
        `${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* run fn over items with N workers; per-item failures land in the result
 * array as the thrown Error (caller decides the fallback) */
async function mapLimit(items, fn, limit) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const k = next++;
            try {
                out[k] = await fn(items[k]);
            } catch (e) {
                out[k] = e;
            }
        }
    };
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({length: n}, worker));
    return out;
}

export class NasdaqClient {
    /** @param back YahooClient (relay on) for symbols/news we cannot serve */
    constructor(back) {
        this.name = 'nasdaq';
        this._back = back;
        this._class = new Map();              // symbol → {ac, exp}
        this._loadClass();
        this._penaltyUntil = 0;
        this._consecFail = 0;
    }

    /** Seconds until we may hit the network again (0 = now). */
    retryIn() {
        return Math.max(0,
            Math.ceil(this._penaltyUntil - GLib.get_monotonic_time() / 1e6));
    }

    /* Classification cache persistence: a cold boot otherwise re-probes
     * every symbol's asset class before trusting a sparkline, which is
     * most of the first round's latency. The map is tiny, re-probes are
     * self-healing (a miss re-classifies and rewrites), so a stale file
     * is at worst one wasted attempt. */
    _cacheFile() {
        return Gio.File.new_for_path(
            `${GLib.get_user_data_dir()}/tickerglass/asset-class.json`);
    }

    /* classification accessors — entries expire so a symbol moving
     * between houses (new listing, delisting) self-heals within 30min */
    _ac(sym) {
        const e = this._class.get(sym);
        if (!e)
            return null;
        if (GLib.get_real_time() / 1e6 > e.exp) {
            this._class.delete(sym);       // re-probe this round
            return null;
        }
        return e.ac;
    }

    _classSet(sym, ac) {
        this._class.set(sym, {ac,
            exp: GLib.get_real_time() / 1e6 + 1800});
    }

    _loadClass() {
        try {
            // load_contents (not load_bytes: this build's binding hands
            // back a GBytes that lacks get_data) — bytes come as Uint8Array
            const [ok, bytes] = this._cacheFile().load_contents(null);
            if (!ok || !bytes)
                return;
            const m = JSON.parse(new TextDecoder().decode(bytes));
            const now = GLib.get_real_time() / 1e6;
            for (const [sym, e] of Object.entries(m))
                if (e && typeof e.exp === 'number' && e.exp > now)
                    this._class.set(sym, e);
        } catch { /* first boot, no file — fine */ }
    }

    _saveClass() {
        try {
            const m = Object.fromEntries(this._class);
            const dir = this._cacheFile().get_parent();
            try {
                dir.make_directory(null);   // EXISTS just means already fine
            } catch { /* already there */ }
            const out = new GLib.Bytes(new TextEncoder().encode(
                JSON.stringify(m)));
            // this GJS/GIO build has neither FileCreateFlags nor
            // File.replace_bytes (introspection gaps) — classic replace,
            // and an explicit close so the buffered write lands now
            const st = this._cacheFile().replace(null, false, 0, null);
            st.write_bytes(out, null);
            st.close(null);
        } catch { /* cache is a luxury; never break a fetch over it */ }
    }

    _noteFailure() {
        this._consecFail++;
        this._penaltyUntil = GLib.get_monotonic_time() / 1e6 +
            Math.min(600, 30 * 2 ** Math.min(this._consecFail, 5));
    }

    _noteSuccess() {
        this._consecFail = 0;
        this._penaltyUntil = 0;
    }

    _get(path) {
        return new Promise((resolve, reject) => {
            const session = sessionFor(UA, 20);
            const msg = Soup.Message.new('GET', NASDAQ_API + path);
            if (!msg) {
                reject(new Error(`bad url: ${path}`));
                return;
            }
            msg.request_headers.append('Accept', 'application/json');
            msg.request_headers.append('Origin', 'https://www.nasdaq.com');
            msg.request_headers.append('Referer', 'https://www.nasdaq.com/');
            // hard deadline (see YahooClient._get): a stalled socket must
            // never strand a pending promise — _busy would stay stuck
            let done = false;
            const cancel = new Gio.Cancellable();
            const timer = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 25, () => {
                    if (done)
                        return GLib.SOURCE_REMOVE;
                    done = true;
                    cancel.cancel();
                    reject(new Error('timeout'));
                    return GLib.SOURCE_REMOVE;
                });
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancel,
                                        (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const body =
                        bytes ? new TextDecoder().decode(bytes.get_data()) : '';
                    const st = httpStatus(msg);
                    if (done)
                        return;
                    done = true;
                    GLib.source_remove(timer);
                    if (st >= 400)
                        throw new HttpError(st, body);
                    resolve(JSON.parse(body));
                } catch (e) {
                    if (done)
                        return;
                    done = true;
                    GLib.source_remove(timer);
                    reject(e instanceof HttpError ? e
                          : new Error(e.message || 'parse error'));
                }
            });
        });
    }

    async _try(path) {
        try {
            const d = await this._get(path);
            this._noteSuccess();
            return d;
        } catch (e) {
            if (/HTTP 4(03|29)/.test(e.message)) {
                this._noteFailure();
                log(`TickerGlass: nasdaq throttled, backing off ${this.retryIn()}s`);
            }
            throw e;
        }
    }

    /* symbol → assetclass, probing stocks then etf once and caching the
     * verdict (including 'yahoo' for symbols Nasdaq has never heard of) */
    async _quoteInfo(sym) {
        const known = this._ac(sym);
        for (const ac of known ? [known] : ['stocks', 'etf']) {
            if (ac === 'yahoo')
                return {ac, info: null};
            try {
                const d = await this._try(
                    `/api/quote/${encodeURIComponent(sym)}/info` +
                    `?assetclass=${ac}`);
                if (d?.data) {
                    this._classSet(sym, ac);
                    return {ac, info: d.data};
                }
            } catch { /* wrong class or transient — try next / give up */ }
        }
        this._classSet(sym, 'yahoo');
        return {ac: 'yahoo', info: null};
    }

    _cleanName(d) {
        return (d.companyName ?? '')
            .replace(/\s+Class\s+[A-Z]\s+Common Stock$/i, '')
            .replace(/\s+Common Stock$/i, '') || (d.symbol ?? '');
    }

    _quoteFrom(sym, d, spark) {
        const p = d.primaryData ?? {};
        const price = parseNum(p.lastSalePrice);
        const change = parseNum(p.netChange);
        const pct = parseNum(p.percentageChange);
        const wk = (d.keyStats?.fiftyTwoWeekHighLow?.value ?? '')
            .split('-').map(t => parseNum(t));
        const dr = (d.keyStats?.dayrange?.value ?? '')
            .split('-').map(t => parseNum(t));
        return {
            symbol: sym,
            name: this._cleanName(d),
            price,
            prevClose: price != null && change != null ? price - change : null,
            change, changePct: pct != null ? pct / 100 : null,
            dayHigh: dr[0] ?? null, dayLow: dr[1] ?? null,
            open: null,
            volume: parseNum(p.volume),
            wk52High: wk[1] ?? null, wk52Low: wk[0] ?? null,
            currency: p.currency || 'USD',
            exchange: d.exchange ?? '',
            type: 'EQUITY',
            state: NASDAQ_STATE[d.marketStatus] ?? 'REGULAR',
            tz: 'America/New_York',
            marketTime: null,
            spark: spark ? subsample(spark, 40) : null,
        };
    }

    _metaFrom(sym, d) {
        const p = d?.primaryData ?? {};
        const price = parseNum(p.lastSalePrice);
        const change = parseNum(p.netChange);
        const wk = (d?.keyStats?.fiftyTwoWeekHighLow?.value ?? '')
            .split('-').map(t => parseNum(t));
        const dr = (d?.keyStats?.dayrange?.value ?? '')
            .split('-').map(t => parseNum(t));
        return {
            price,
            prevClose: price != null && change != null ? price - change : null,
            currency: p.currency || 'USD',
            exchange: d?.exchange ?? '',
            state: NASDAQ_STATE[d?.marketStatus] ?? 'REGULAR',
            tz: 'America/New_York',
            marketTime: null,
            wk52High: wk[1] ?? null, wk52Low: wk[0] ?? null,
            dayHigh: dr[0] ?? null, dayLow: dr[1] ?? null,
            open: null,
            volume: parseNum(p.volume),
            sessionStart: null, sessionEnd: null,
        };
    }

    /* today's intraday session (also answers with the live quote) */
    async _chartSeries(sym, ac) {
        const d = await this._try(
            `/api/quote/${encodeURIComponent(sym)}/chart?assetclass=${ac}`);
        const out = [];
        for (const r of d?.data?.chart ?? []) {
            const v = typeof r?.y === 'number' ? r.y : parseNum(r?.z?.value);
            const t = r?.x ? r.x / 1000 : 0;
            if (v != null && t)
                out.push({t, c: v, o: v, h: v, l: v, v: 0});
        }
        return {points: out, data: d?.data ?? null};
    }

    /* daily OHLCV bars, chronological (the feed sends newest-first) */
    async _daily(sym, ac, fromStr, toStr, limit) {
        const d = await this._try(
            `/api/quote/${encodeURIComponent(sym)}/historical` +
            `?assetclass=${ac}&fromdate=${fromStr}&todate=${toStr}` +
            `&limit=${limit}`);
        const pts = (d?.data?.tradesTable?.rows ?? []).map(r => ({
            t: parseMDY(r.date),
            c: parseNum(r.close),
            o: parseNum(r.open),
            h: parseNum(r.high),
            l: parseNum(r.low),
            v: parseNum(r.volume) ?? 0,
        })).filter(p => p.t && p.c != null);
        pts.reverse();
        for (const p of pts) {
            p.o ??= p.c;
            p.h ??= p.c;
            p.l ??= p.c;
        }
        return pts;
    }

    async _dailyDays(sym, ac, days) {
        const now = new Date();
        const from = new Date(now.getTime() - (days + 4) * 86400e3);
        return this._daily(sym, ac, mdym(from), mdym(now),
            Math.min(days + 10, 420));
    }

    async quotes(symbols, {sparkRange = '1d', onQuote = null} = {}) {
        // 5 at a time with the shared connection pool — the politeness
        // argument died with the per-request TLS handshakes
        //
        // symbols already known to be Yahoo-only (crypto, indices) fire
        // their relay calls NOW, not after the whole Nasdaq round: the
        // long relay leg stops gating the stock rows, and stock rows
        // stream in via onQuote as each lands
        const rel = [], nas = [];
        for (const s of symbols)
            (this._ac(s) === 'yahoo' ? rel : nas).push(s);
        const relP = rel.length
            ? this._back.quotes(rel, {sparkRange})
                .then(b => {
                    for (const q of b?.quotes ?? [])
                        if (onQuote)
                            onQuote(q);
                    return b?.quotes ?? [];
                }).catch(() => [])
            : Promise.resolve([]);
        const results = await mapLimit(
            nas, async sym => {
                const r = await this._quoteOne(sym, sparkRange);
                if (onQuote && r && !r.viaBack)
                    onQuote(r.q);
                return r;
            }, 5);
        const bySym = new Map();
        const viaBack = [];
        results.forEach((r, i) => {
            if (r instanceof Error)
                return;                       // -> fallback error row
            if (r.viaBack)
                viaBack.push(nas[i]);
            else
                bySym.set(nas[i], r.q);
        });
        // newly-classified strays need their own relay pass
        const late = viaBack.length
            ? (await this._back.quotes(viaBack, {sparkRange})
                .catch(() => null))?.quotes ?? []
            : [];
        const back = [...(await relP), ...late];
        const quotes = symbols.map(sym =>
            bySym.get(sym)
            ?? back.find(q => q.symbol === sym)
            ?? {symbol: sym, name: sym, price: null, error: true, spark: null});
        this._saveClass();
        return {at: Math.floor(GLib.get_real_time() / 1e6), quotes};
    }

    /* one symbol end to end: classify (cached), sparkline alongside.
     * When we already know the house, the spark fires BEFORE the info
     * call returns — two serial HTTP calls become one round trip. */
    async _quoteOne(sym, sparkRange) {
        const acs = this._ac(sym);
        if (acs === 'yahoo')
            return {viaBack: true};
        const sparkP = acs
            ? this._spark(sym, sparkRange, acs).catch(() => null)
            : null;
        const r = await this._quoteInfo(sym);
        if (r.ac === 'yahoo')
            return {viaBack: true};
        let spark = null;
        try {
            spark = await (sparkP ?? this._spark(sym, sparkRange, r.ac));
        } catch { /* sparkline is optional — quote still paints */ }
        return {q: this._quoteFrom(sym, r.info,
            spark && spark.length > 1 ? spark : null)};
    }

    /* sidebar sparkline values: session series for 1d, dailies else */
    _spark(sym, sparkRange, ac) {
        return sparkRange === '1d'
            ? this._chartSeries(sym, ac).then(ch => ch.points.map(p => p.c))
            : this._dailyDays(sym, ac,
                Math.min(RANGE_DAYS[sparkRange] ?? 30, 400))
                .then(pts => pts.map(p => p.c));
    }

    async history(symbol, range = '1d', interval = 'auto') {
        const {ac, info} = await this._quoteInfo(symbol);
        if (ac === 'yahoo')
            return this._back.history(symbol, range, interval);
        const meta = this._metaFrom(symbol, info);
        let points = [];
        if (range === '1d') {
            const ch = await this._chartSeries(symbol, ac);
            points = ch.points;
            if (ch.data) {
                meta.price = parseNum(ch.data.lastSalePrice) ?? meta.price;
                meta.prevClose = parseNum(ch.data.previousClose) ?? meta.prevClose;
                meta.volume = parseNum(ch.data.volume) ?? meta.volume;
            }
            if (!points.length) {
                // weekend/holiday: the session feed is empty — show the
                // last five trading days instead of a blank canvas
                const now = new Date();
                points = await this._daily(symbol, ac,
                    mdym(new Date(now.getTime() - 9 * 86400e3)), mdym(now), 10);
            }
        } else {
            const days = RANGE_DAYS[range] ?? 30;
            const now = new Date();
            const from = range === 'ytd'
                ? `${now.getUTCFullYear()}-01-01`
                : mdym(new Date(now.getTime() - (days + 6) * 86400e3));
            points = await this._daily(symbol, ac, from, mdym(now),
                Math.min(Math.ceil(days * 1.6) + 10, 3200));
        }
        if (!points.length)
            throw new Error(`history ${symbol}: empty`);
        return {
            symbol, range,
            interval: range === '1d' ? '1m' : intervalFor(range, interval),
            meta, points,
        };
    }

    /* no keyless search on nasdaq.com — the relayed Yahoo catalog answers */
    async search(q) {
        return this._back.search(q);
    }

    /* ditto news */
    async news(symbol) {
        return this._back.news(symbol);
    }

    /* screeners are Yahoo-side: Nasdaq's own screener endpoints are
     * Akamai-gated. Direct Yahoo first (its cookie+crumb flow survives
     * the 429 gate — a crumb can only match the session that holds the
     * cookies, so the relayed client usually can't answer this one),
     * relay second as the clean-IP shot, empty last */
    async screener(scrId, count = 12) {
        this._scr ??= [new YahooClient(), this._back];
        for (const c of this._scr) {
            try {
                const r = await c.screener(scrId, count);
                if (r?.length)
                    return r;
            } catch { /* next */ }
        }
        return [];
    }
}

/* ── facade ─────────────────────────────────────────────────────────────── */

export class MarketClient {
    constructor(source = 'yahoo') {
        this._yahoo = new YahooClient();
        /* relayed Yahoo client the Nasdaq source leans on for symbols it
         * does not list (crypto, indices) and for news */
        this._yahooBack = new YahooClient();
        this._yahooBack.setRelay(RELAY);
        this._nasdaq = null;
        this._demo = new DemoClient();
        this.setSource(source);
    }

    setSource(source) {
        // 'yahoo-relay' = same Yahoo API, fetched through a public reader
        // proxy (clean IP) when our own egress gets blanket-429'd
        // 'nasdaq' = direct keyless api.nasdaq.com (US stocks/ETFs only;
        //            unknown symbols + news ride the relay)
        this._yahoo.setRelay(source === 'yahoo-relay' ? RELAY : null);
        this.source = source === 'demo' ? 'demo'
            : source === 'nasdaq' ? 'nasdaq' : 'yahoo';
    }

    get _impl() {
        if (this.source === 'demo')
            return this._demo;
        if (this.source === 'nasdaq')
            return this._nasdaq ??= new NasdaqClient(this._yahooBack);
        return this._yahoo;
    }

    retryIn() {
        return this._impl.retryIn?.() ?? 0;
    }

    quotes(symbols, opts) {
        return this._impl.quotes(symbols, opts);
    }

    history(symbol, range, interval) {
        return this._impl.history(symbol, range, interval);
    }

    search(q) {
        return this._impl.search(q);
    }

    async news(symbol) {
        try {
            return await this._impl.news(symbol);
        } catch {
            return [];   // news is garnish — never break the quote flow
        }
    }

    async screener(scrId, count = 12) {
        try {
            return await this._impl.screener(scrId, count);
        } catch {
            return [];   // market movers are garnish too
        }
    }
}
