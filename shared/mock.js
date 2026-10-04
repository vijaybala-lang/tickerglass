/* mock.js — "demo" data source: deterministic pseudo-market with the exact
 * shape of the Yahoo client. Used for offline mode, previews and tooling.
 * Pure GLib at most; runs headless under plain gjs. */

import GLib from 'gi://GLib';
import {mulberry32, intervalFor, RANGES} from './fmt.js';

/* Anchors so familiar names look familiar; everything else hashes to a
 * plausible price. Volatility tuned per instrument class. */
const ANCHORS = {
    'AAPL': 232, 'MSFT': 425, 'NVDA': 121, 'GOOGL': 178, 'AMZN': 198,
    'META': 612, 'TSLA': 251, 'BRK-B': 485, 'JPM': 246, 'DIS': 96,
    '^GSPC': 5720, '^IXIC': 18200, '^DJI': 42300, '^VIX': 18,
    'BTC-USD': 68400, 'ETH-USD': 2780, 'SOL-USD': 142,
    'EURUSD=X': 1.087, 'USDJPY=X': 148.2, 'GC=F': 2640, 'CL=F': 61.4,
    'SPY': 578, 'QQQ': 501, 'AMD': 142, 'NFLX': 682, 'COIN': 242,
    'IBM': 228, 'INTC': 23.4, 'BA': 152, 'KO': 62.1, 'PFE': 26.2,
};

const VOLATILE = /(^BTC|ETH|SOL|-USD$|^VIX|COIN|TSLA|NVDA)/;

export function demoAnchor(symbol) {
    if (ANCHORS[symbol] !== undefined)
        return ANCHORS[symbol];
    const rnd = mulberry32(`anchor:${symbol}`);
    return +(12 + rnd() * 480).toFixed(2);
}

/** Wall-clock in an IANA zone as {h, m, weekday} via Intl (no tz math by hand). */
function zonedParts(epochSec, tz) {
    try {
        const p = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', hour: '2-digit',
            minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(new Date(epochSec * 1000));
        const g = t => p.find(x => x.type === t)?.value;
        return {wd: g('weekday'), h: +g('hour'), m: +g('minute')};
    } catch {
        const d = new Date(epochSec * 1000);
        return {wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
                h: d.getUTCHours(), m: d.getUTCMinutes()};
    }
}

/** NYSE-style session state for a symbol (crypto trades through). */
export function demoState(symbol, epochSec) {
    if (/-USD$/.test(symbol) && !/=X$/.test(symbol))
        return 'REGULAR';
    const {wd, h, m} = zonedParts(epochSec, 'America/New_York');
    if (wd === 'Sat' || wd === 'Sun')
        return 'CLOSED';
    const t = h * 60 + m;
    if (t < 240 || t >= 1200)
        return 'CLOSED';
    if (t < 570)
        return 'PRE';
    if (t < 960)
        return 'REGULAR';
    return 'POST';
}

/* One random-walk session, shared by quotes() and history() so the last
 * point of any series equals today's live price. */
function session(symbol, daySeed, n, stepSec, nowEpoch) {
    const anchor = demoAnchor(symbol);
    const vol = (VOLATILE.test(symbol) ? 0.016 : 0.008);
    const rnd = mulberry32(`${symbol}:${daySeed}`);
    const gap = 1 + (rnd() - 0.5) * vol * 2;          // overnight gap
    const open = anchor * gap;
    const mid = anchor * (1 + (rnd() - 0.5) * vol);
    const out = [];
    let p = open;
    for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const pull = (mid - p) * 0.008;               // mean revert toward mid
        p += pull + (rnd() - 0.5) * anchor * vol * 0.18 +
             (anchor - p) * 0.0015;
        out.push(Math.max(anchor * 0.5, p));
    }
    // pin the close to a stable "last price" independent of n/step: an
    // absolute anchor-seeded value, so quotes() (78 steps) and history()
    // (any length) agree to the cent on both price and prev close
    const closeRnd = mulberry32(`${symbol}:close:${daySeed}`);
    const last = anchor * (1 + (closeRnd() - 0.5) * vol * 0.9);
    const prevRnd = mulberry32(`${symbol}:prev:${daySeed}`);
    const prevClose = last * (1 - (prevRnd() - 0.5) * vol * 1.6);
    out[out.length - 1] = last;
    return {
        values: out,
        prevClose,
        time: nowEpoch,
    };
}

export class DemoClient {
    constructor() {
        this.name = 'demo';
    }

    _now() {
        return Math.floor(GLib.get_real_time() / 1e6);
    }

    async quotes(symbols, {sparkRange = '1d'} = {}) {
        const now = this._now();
        const quotes = symbols.map(symbol => {
            const s = session(symbol, 'day', 78, 300, now);
            const price = s.values[s.values.length - 1];
            const prev = s.prevClose;
            const rnd = mulberry32(`${symbol}:meta`);
            const wkUp = 1 + rnd() * 0.9, wkDn = wkUp * (0.55 + rnd() * 0.3);
            return {
                symbol,
                name: symbol.replace(/[\^=]/g, ''),
                price, prevClose: prev,
                change: price - prev, changePct: (price - prev) / prev,
                dayHigh: Math.max(...s.values), dayLow: Math.min(...s.values),
                volume: Math.round(1e5 + rnd() * 9e7),
                wk52High: price * wkUp * 0.98, wk52Low: price * wkDn,
                currency: /-USD$/.test(symbol) ? 'USD' :
                          /X$/.test(symbol) ? symbol.slice(0, 3) : 'USD',
                exchange: 'DEMO', exchangeName: 'Demo Exchange',
                type: 'MOCK',
                state: demoState(symbol, now),
                tz: 'America/New_York', marketTime: now,
                spark: sparkRange === '1d'
                    ? s.values : this._histSpark(symbol, sparkRange, price),
                open: s.values[0],
            };
        });
        return {at: now, quotes};
    }

    /* multi-day sparkline: the long-range history walk rescaled to end at
     * today's live price, thinned to ≤40 points */
    _histSpark(symbol, range, price) {
        const days = {'7d': 7, '1mo': 30, '52w': 365, ytd: 180,
                      '1y': 365, '2y': 730, '5y': 1825}[range] ?? 30;
        const rnd = mulberry32(`${symbol}:hist:${range}:1d`);
        const out = [];
        let p = price * (0.6 + rnd() * 0.5);
        const n = Math.min(40, days);
        for (let i = 0; i < n; i++) {
            p *= 1 + (rnd() - 0.485) * 0.02;
            out.push(p);
        }
        const k = price / out[n - 1];
        return out.map(v => v * k);
    }

    /* tabloid-lite headlines, deterministic per symbol */
    async news(symbol) {
        const now = this._now();
        const rnd = mulberry32(`${symbol}:news`);
        const srcs = ['Reuters', 'Bloomberg', 'Barron\u2019s', 'CNBC',
                      'The Wall Street Journal', 'Investor\u2019s Business Daily'];
        const heads = [
            `${symbol} climbs as traders position ahead of earnings`,
            `Analysts raise ${symbol} price targets on strong guidance`,
            `Sector rotation lifts ${symbol} in choppy session`,
            `Insider filings show mixed signals for ${symbol}`,
            `${symbol}: options market bets on a volatility squeeze`,
            `Funds trim ${symbol} as flows shift to value names`,
            `${symbol} holders weigh dividend against buyback math`,
            `Morning brief: ${symbol}, futures and what movers mean for you`,
        ];
        const out = [];
        for (let i = 0; i < 6; i++) {
            const h = heads[Math.floor(rnd() * heads.length)];
            out.push({
                title: out.some(o => o.title === h) ? `${h} — update` : h,
                source: srcs[Math.floor(rnd() * srcs.length)],
                url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/news`,
                at: now - (i * 7 + Math.floor(rnd() * 6)) * 3600,
            });
        }
        return out;
    }

    async history(symbol, range = '1d', interval = 'auto') {
        const iv = intervalFor(range, interval);
        const now = this._now();
        const perDay = {'1m': 390, '5m': 78, '15m': 26, '30m': 13, '1h': 7};
        const days = {'1d': 1, '7d': 6, '5d': 5, '1mo': 22, '3mo': 66, '6mo': 130,
                      ytd: 180, '52w': 252, '1y': 252, '2y': 504,
                      '5y': 1260, max: 2520}[range] ?? 22;
        const stepSec = {'1m': 60, '5m': 300, '15m': 900, '30m': 1800,
                         '1h': 3600 * 7, '1d': 86400, '1wk': 604800,
                         '1mo': 2592000}[iv] ?? 86400;
        const anchor = demoAnchor(symbol);
        const rnd = mulberry32(`${symbol}:hist:${range}:${iv}`);
        const pts = [];
        let p = anchor * (0.6 + rnd() * 0.5);
        const n = Math.min(400, Math.ceil(days * (perDay[iv] ?? 1)));
        const t0 = now - n * stepSec;
        for (let i = 0; i < n; i++) {
            p *= 1 + (rnd() - 0.485) * (iv === '1d' || iv === '1wk' || iv === '1mo' ? 0.016 : 0.004);
            const o = p * (1 + (rnd() - 0.5) * 0.002);
            const c = p;
            const hi = Math.max(o, c) * (1 + rnd() * 0.002);
            const lo = Math.min(o, c) * (1 - rnd() * 0.002);
            pts.push({t: t0 + i * stepSec, o, h: hi, l: lo, c,
                      v: Math.round(1e5 + rnd() * 5e7)});
        }
        // stitch the tail of long-range views onto today's session
        const today = session(symbol, 'day', pts.length, stepSec, now);
        if (range === '1d' && pts.length) {
            pts.forEach((pt, i) => {
                pt.c = today.values[i] ?? pt.c;
                pt.h = Math.max(pt.c, pt.o);
                pt.l = Math.min(pt.c, pt.o);
            });
        }
        // scale the walk so the series ends exactly at today's live price —
        // charts and the hero quote then always agree
        const last = pts[pts.length - 1];
        const price = today.values[today.values.length - 1];
        const k = price / last.c;
        if (range !== '1d')
            pts.forEach(pt => {
                pt.o *= k; pt.h *= k; pt.l *= k; pt.c *= k;
            });
        return {
            symbol, range, interval: iv,
            meta: {
                price, prevClose: today.prevClose, currency: 'USD',
                exchange: 'DEMO', state: demoState(symbol, now),
                tz: 'America/New_York', marketTime: last.t,
                wk52High: anchor * 1.35, wk52Low: anchor * 0.7,
            },
            points: pts,
        };
    }

    async search(q) {
        const qq = q.trim().toUpperCase();
        const known = Object.keys(ANCHORS)
            .filter(s => qq && s.toUpperCase().includes(qq))
            .slice(0, 8)
            .map(s => ({symbol: s, name: ANCHORS[s] ? s.replace(/[\^=]/g, '') : s,
                        exchange: 'DEMO', type: 'MOCK', currency: 'USD'}));
        const made = [...Array(3).keys()].map(i => ({
            symbol: `${qq || 'DEMO'}${i ? `.${i}` : ''}`,
            name: `${q.trim() || 'Demo Corp'} Demo Co ${i + 1}`,
            exchange: 'DEMO', type: 'COMMON', currency: 'USD',
        }));
        return [...known, ...made];
    }

    /* pseudo market screener: the anchor stock pool ranked by demo move */
    async screener(scrId, count = 12) {
        const pool = Object.keys(ANCHORS)
            .filter(s => !/[\^=]|-USD$/.test(s) && s !== 'BRK-B');
        const {quotes: qs} = await this.quotes(pool);
        const dir = scrId === 'day_losers' ? 1 : -1;
        return qs.filter(q => !q.error && q.changePct != null)
                 .sort((a, b) => dir * (a.changePct - b.changePct))
                 .slice(0, count);
    }
}
