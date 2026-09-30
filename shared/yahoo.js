/* yahoo.js — Yahoo Finance client (no API key) + the MarketClient facade
 * that switches between 'yahoo' and 'demo'. Same conventions as
 * weatherglass/weather.js: fresh Soup.Session per request, promise-wrapped
 * send_and_read_async, session.abort() in finally, plain-object results.
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
import Soup from 'gi://Soup';
import {intervalFor} from './fmt.js';
import {DemoClient} from './mock.js';

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

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

    _get(url, {json = true} = {}) {
        return new Promise((resolve, reject) => {
            const session = new Soup.Session({user_agent: UA, timeout: 15});
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                reject(new Error(`bad url: ${url}`));
                return;
            }
            msg.request_headers.append('Accept',
                json ? 'application/json,text/plain,*/*' : 'text/plain,*/*');
            msg.request_headers.append('Accept-Language', 'en-US,en;q=0.5');
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                                        (sess, res) => {
                let body = '';
                try {
                    const bytes = sess.send_and_read_finish(res);
                    body = bytes ? new TextDecoder().decode(bytes.get_data()) : '';
                    const st = msg.get_status();
                    if (st === 429)
                        throw new HttpError(429, body);
                    if (st >= 400)
                        throw new HttpError(st, body);
                    resolve(json ? JSON.parse(body) : body);
                } catch (e) {
                    reject(e instanceof HttpError ? e
                          : new Error(e.message || 'parse error'));
                } finally {
                    session.abort();
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
            }
            throw e;
        }
    }

    /* cookie + crumb handshake: fc.yahoo.com 404s but sets A1/A3 cookies on
     * the session jar; getcrumb then echoes the crumb for that cookie. */
    async _bootstrapCrumb() {
        const session = new Soup.Session({user_agent: UA, timeout: 15});
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
            if (crumb && !/^\s*</.test(crumb) && crumb.length < 32) {
                this._crumb = crumb;
                return crumb;
            }
        } finally {
            session.abort();
        }
        this._crumb = '';
        return '';
    }

    /* ── quotes ────────────────────────────────────────────────────────── */

    /** Batched spark endpoint: quotes + inline day series in ONE request. */
    async _quotesSpark(symbols, sparkRange) {
        const iv = sparkRange === '5d' ? '1h' : '15m';
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
            if (/HTTP 4(01|03|04)/.test(e.message) && this._crumb === null) {
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
            .map(n => ({
                title: n.title,
                source: n.publisher ?? '',
                url: n.link,
                at: (n.providerPublishTime ?? n.originallyCreated ?? 0) / 1000,
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

/* ── facade ─────────────────────────────────────────────────────────────── */

export class MarketClient {
    constructor(source = 'yahoo') {
        this._yahoo = new YahooClient();
        this._demo = new DemoClient();
        this.setSource(source);
    }

    setSource(source) {
        this.source = source === 'demo' ? 'demo' : 'yahoo';
    }

    get _impl() {
        return this.source === 'demo' ? this._demo : this._yahoo;
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
}
