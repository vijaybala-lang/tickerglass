/* fmt.js — pure formatting + domain rules shared by the extension and the
 * app. No St/Gtk imports: this module also runs in headless tooling.
 * Canonical rule (from weatherglass): store canonical numbers, convert only
 * at display time. */

/* ── palette ─────────────────────────────────────────────────────────────
 * Rose/red for down, mint/green for up — same hues cairo painters, CSS pills
 * and the app table all agree on. rgb arrays feed cairo setSourceRGBA. */
export const COLORS = {
    up:   [0.00, 0.71, 0.38],   // #00b562 — Robinhood-adjacent green
    down: [0.96, 0.27, 0.36],   // #f5455c
    flat: [0.62, 0.66, 0.72],
    upCss:   '#00b562',
    downCss: '#f5455c',
};

/* ── ranges & intervals ─────────────────────────────────────────────────── */

export const RANGES = ['1d', '7d', '1mo', '52w', 'ytd', '1y', '2y', '5y'];

export const RANGE_LABEL = {
    '1d': '1D', '7d': '7D', '1mo': '1M', '52w': '52W',
    ytd: 'YTD', '1y': '1Y', '2y': '2Y', '5y': '5Y',
};

/* Yahoo's own validity limits per interval (approximated conservatively). */
const INTERVAL_MAX_DAYS = {
    '1m': 7, '5m': 60, '15m': 60, '30m': 60, '1h': 730,
    '1d': 36500, '1wk': 36500, '1mo': 36500,
};

export const INTERVALS = Object.keys(INTERVAL_MAX_DAYS);

export const RANGE_DAYS = {
    '1d': 1, '7d': 7, '1mo': 30, '52w': 365, ytd: 300,
    '1y': 365, '2y': 730, '5y': 1825,
    /* legacy values that may still live in user dconf */
    '5d': 5, '3mo': 91, '6mo': 182, max: 36500,
};

export const INTERVAL_LABEL = {
    '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H',
    '1d': '1D', '1wk': '1W', '1mo': '1M',
};

/** Interval that fits the range — mirrors what finance.yahoo.com offers. */
export function intervalFor(range, want = 'auto') {
    const days = RANGE_DAYS[range] ?? 1;
    if (want !== 'auto' && INTERVALS.includes(want) &&
        (RANGE_DAYS[range] ?? 36500) <= INTERVAL_MAX_DAYS[want])
        return want;
    if (days <= 1)   return '5m';
    if (days <= 5)   return '30m';
    if (days <= 30)  return '1h';
    if (days <= 182) return '1d';
    if (days <= 800) return '1d';
    if (days <= 2200) return '1wk';
    return '1mo';
}

export function intervalsFor(range) {
    const days = RANGE_DAYS[range] ?? 1;
    return INTERVALS.filter(iv => days <= INTERVAL_MAX_DAYS[iv]);
}

/* ── number formatting ─────────────────────────────────────────────────── */

const _nfCache = new Map();
function nf(key, opts) {
    let f = _nfCache.get(key);
    if (!f) {
        try { f = new Intl.NumberFormat(undefined, opts); }
        catch { f = null; }               // ICU rejected it → manual path
        _nfCache.set(key, f);
    }
    return f;
}

/** Price with adaptive precision; currency code appended for exotic FX
 *  (1 234.56 USD, 0.00043200 BTC keeps significant digits for cheap coins). */
export function fmtPrice(v, currency = 'USD') {
    if (!Number.isFinite(v))
        return '—';
    const a = Math.abs(v);
    const [min, max] = a >= 1000 ? [2, 2] : a >= 1 ? [2, 2] :
                       a >= 0.01 ? [2, 4] : [4, 8];
    const f = nf(`p${min}${max}`, {minimumFractionDigits: min,
                                   maximumFractionDigits: max,
                                   useGrouping: true});
    const s = f ? f.format(v) : v.toFixed(max);
    const sym = nf(`c${currency}`, {style: 'currency', currency})
        ?.format(0);
    const prefix = sym ? sym.replace(/[\d.,\s\u00a0 ]/g, '') : '';
    // show bare numbers when we know the symbol ($, £, €, …); otherwise
    // append the ISO code (XUS, KRW-less cases, crypto pairs)
    return (prefix && prefix.length <= 2) ? `${prefix}${s}` : `${s} ${currency}`;
}

/** 1.23B / 45.6M / 987K for volumes & market caps. */
export function fmtCompact(v) {
    if (!Number.isFinite(v))
        return '—';
    const f = nf('compact', {notation: 'compact', maximumFractionDigits: 2});
    return f ? f.format(v) : String(v);
}

/** Price delta, unsigned: every surface pairs it with a ▲/▼ arrow
 * (or up/down color), so the old +/− prefix was pure noise. */
export function fmtDelta(v, currency = 'USD') {
    if (!Number.isFinite(v))
        return '—';
    return fmtPrice(Math.abs(v), currency);
}

/** 1.24% style, sign-free — direction lives in the arrow/color. */
export function fmtPct(x) {
    if (!Number.isFinite(x))
        return '—';
    const v = (x * 100).toFixed(Math.abs(x) < 0.001 ? 3 : 2);
    return `${Math.abs(+v).toFixed(v.includes('.') ? v.split('.')[1].length : 2)}%`;
}

/** Epoch + IANA zone → "09:30" / "Mar 4". Intl gives us the zone math. */
export function fmtTime(epochSec, tzName, opts = {}) {
    try {
        return new Intl.DateTimeFormat(undefined,
            {timeZone: tzName ?? 'UTC', hourCycle: 'h23',
             hour: '2-digit', minute: '2-digit', ...opts})
            .format(new Date(epochSec * 1000));
    } catch {
        return '';
    }
}

/** Epoch in zone, granularity by range: intraday → time, daily → date. */
export function fmtAxisTime(epochSec, tzName, intraday) {
    return intraday
        ? fmtTime(epochSec, tzName)
        : fmtTime(epochSec, tzName, {month: 'short', day: 'numeric'});
}

export function monthDay(epochSec) {
    try {
        return new Intl.DateTimeFormat(undefined,
            {month: 'short', day: 'numeric'}).format(new Date(epochSec * 1000));
    } catch {
        return '';
    }
}

/** x-axis date label; adds ’YY once the span exceeds about a year, so
 *  2Y/5Y charts read chronologically instead of shuffling month-days. */
export function axisDate(epochSec, spanDays) {
    try {
        return new Intl.DateTimeFormat(undefined,
            {month: 'short', day: 'numeric',
             ...(spanDays > 400 ? {year: '2-digit'} : {})}).format(new Date(epochSec * 1000));
    } catch {
        return '';
    }
}

/* ── watchlist JSON glue ────────────────────────────────────────────────── */

export const DEFAULT_WATCHLISTS =
    [{id: 'main', name: 'Watchlist',
      symbols: ['AAPL', 'MSFT', 'NVDA', '^GSPC', 'BTC-USD']}];

export function parseWatchlists(json) {
    try {
        const list = JSON.parse(json);
        if (Array.isArray(list) &&
            list.every(w => typeof w?.id === 'string' &&
                             Array.isArray(w?.symbols)))
            return list.map(w => ({
                id: w.id,
                name: typeof w.name === 'string' && w.name ? w.name : w.id,
                symbols: w.symbols.filter(s => typeof s === 'string' && s),
            }));
    } catch { /* fall through */ }
    return DEFAULT_WATCHLISTS.map(w => ({...w, symbols: [...w.symbols]}));
}

export function stringifyWatchlists(list) {
    return JSON.stringify(list);
}

/** Yahoo symbols can hold '/' '^' '=' '−'; keep it printable for labels. */
export function symbolShort(symbol) {
    return symbol === '^GSPC' ? 'S&P 500' :
           symbol === '^IXIC' ? 'Nasdaq' :
           symbol === '^DJI' ? 'Dow' :
           symbol === '^VIX' ? 'VIX' :
           symbol.replace(/^/, '');
}

/** true → green, false → red; exactly flat falls to `flat` param. */
export function isUp(change) {
    return change > 0;
}

/* deterministic PRNG for the demo feed + previews */
export function mulberry32(seedStr) {
    let h = 1779033703;
    for (const c of String(seedStr))
        h = Math.imul(h ^ c.charCodeAt(0), 3432918353),
        h = (h << 13) | (h >>> 19);
    return function () {
        h = Math.imul(h ^ h >>> 16, 2246822507);
        h = Math.imul(h ^ h >>> 13, 3266489909);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    };
}
