# EGO upload kit — v1

The release ritual (every command, in order: review, bump, certify,
guest cert, GitHub release, live gate, captures, publish, README
links, upload) lives in `skills/tickerglass-release/SKILL.md`. This
kit holds only EGO-page material: the artifact identity, the
capture list, the canonical description block, and the standing
reviewer answers.

Upload at: https://extensions.gnome.org/upload/
Artifact:  dist/tickerglass@vijaybala.dev.zip  (version 1, first
submission; its `sha256sum` is recorded in the GitHub release body,
and the uploaded bytes must match the certified + live-verified
ones exactly). The companion app bundle
(`dist/tickerglass-app-v1.tar.gz`) rides the GitHub release only —
EGO never sees it.

## Before uploading (manual verification gate)

The full gate is skill steps 1–6; in short: correct manifest
integer before the final build, host certify + GNOME 50 guest cert
on the release commit, install the exact zip artifact, one
logout/login, walk the panel counts and index dials, the movers
card (one/two column, dark/light), gear → preferences, every
ticker-target, and the app pairing — byte-identical zip verified =
zip uploaded.

## Screenshots (upload in this order)

Live captures from the verified build (skill step 5), taken with
`data-source` set to `demo` so the imagery is deterministic and
never shows stale or half-loaded market state — the demo feed is
the project's fixture scene, the same one the test harness boots
(the prices are fixtures; every widget, layout and paint path is
the real shipped code). TickerGlass has no byte-locked goldens yet
(weatherglass does; adopting them is future work), so captures are
re-shot per release from the verified build, never inherited.

1. screenshots/01-card-two-column.png — hero: panel scoreboard + two-column movers card (dark)
2. screenshots/02-panel-indices.png — index dials in the bar, card open
3. screenshots/03-card-light.png — one-column card, light theme
4. screenshots/04-app.png — companion app (chart, watchlist, news)
5. screenshots/05-preferences.png — preferences (watchlist editor)

## Description text (for the EGO page)

**Canonical source: the `description` field in
`extension/metadata.json`.** EGO renders the extension page from
the uploaded zip's manifest, so every upload replaces the site
copy with the manifest's text. Edit the pitch in the manifest (a
reviewed commit); the mirror below must equal it verbatim —
`tools/package.sh` fails the build when they drift.

A little window onto the market, in your top bar.

The panel counts how many of your watchlist symbols are up and down today - or shows live S&P 500, Dow and Nasdaq dials. Click for the movers card: your five biggest gainers and five biggest losers with sparklines, and every row is a jump-off to the full chart.

What's inside:
* Panel scoreboard: gainers/losers counts across all your watchlists, or index dials
* Movers card: top 5 gainers and losers, one or two columns, per-symbol sparklines
* Any Yahoo Finance symbol: stocks, ETFs, indices (^GSPC), forex (EURUSD=X), crypto (BTC-USD), futures (GC=F)
* Unlimited named watchlists, edited in preferences with live symbol search
* Click a ticker to open it in the companion TickerGlass app, Yahoo Finance or Google Finance
* The companion GTK 4 app (same release on GitHub) shares watchlists and settings live, and this extension serves it quotes over D-Bus so market data is fetched only once

Data sources, your choice: Yahoo Finance (keyless), Yahoo via a public relay, Nasdaq's keyless API (US stocks and ETFs), or a deterministic offline demo feed. No API key, no account, no tracking, no analytics: requests go straight from your machine to the source you picked. The data comes from unofficial, undocumented provider endpoints: a personal ticker, not investment advice and not a feed to redistribute.

## Standing answers for the reviewer

- Network use: the extension fetches market data only from the
  source the user picked in preferences — Yahoo Finance's keyless
  `query*.finance.yahoo.com` endpoints, the same over a public
  relay (`r.jina.ai`), or Nasdaq's keyless `api.nasdaq.com` — plus
  a fully offline demo feed. No account, no API key, no tracking,
  no analytics, disclosed in the manifest pitch. Requests carry
  only the user's own watchlist symbols. The provider endpoints
  are unofficial/undocumented; the pitch and README say so (a
  personal ticker, no redistribution).
- D-Bus export: the shell side owns the session-bus name
  `dev.vijaybala.TickerGlass.Data` to serve the companion app
  (`GetSnapshot` / `Refresh` / `Updated`) — one fetcher, one quota,
  instead of two pollers. It serves only this user's own quotes,
  exports nothing else, and is unexported on disable. With no app
  installed it is simply unused.
- Launching other programs — user clicks only, never timers:
  the companion app by its desktop id (`dev.vijaybala.TickerGlass`,
  `Gio.AppInfo.launch`; a `gjs -m` fallback on the known XDG
  install path when no desktop entry exists), and Yahoo/Google
  quote pages via the default URI handler, per the user's
  ticker-target preference.
- Disk: two small JSON caches under the user's cache dir
  (`tickerglass/quotes.json` warm-boot snapshot; the Nasdaq route's
  symbol-classification cache). Reads are async (EGO-X-004 fixed
  in v1 pre-release: `load_contents_async`, verified by the local
  shexli stage); writes are small buffered stream writes after a
  network round, fire-and-forget — cache loss is always harmless.
- Schemas: XML only in the zip, per EGO-P-006. Delivery compiles
  what it serves (EGO server-side; the Extensions app locally), so
  users get a working schema without a blob in our package. The
  companion app installs the same XML at user level so both
  processes share one settings contract.
- Timers (EGO-L-004): the panel refresh/retry sources are removed
  literally in `destroy()`; the header spinner removes its frame
  source in its own `destroy()`. Nothing creates a main-loop
  source in `enable()` that `disable()` does not reach through the
  indicator's `destroy()` chain. `disable()` is synchronous.
- shell-version ['50', '51']: 51 is certified on the dev host
  (`tools/certify.sh`, real nested-shell boot of this zip); 50 is
  certified on the same zip bytes inside a Fedora 44 container
  (GNOME 50.6, `tools/qa/run-old-shell.sh 44`; summary + zip sha
  in `tools/out/qa-gnome-50/`). The public shexli engine's
  plausibility table (spec 2026-04-02) predates GNOME 51 stable
  and files EGO-M-004 against any list containing it; the local
  gate exempts only that rule, only for majors no newer than the
  host's shell, and prints the exemption every run.
- Try/catch: every catch guards a genuinely throwing API —
  network sends, JSON parsing of provider payloads, GSettings keys
  a distro schema may lack, D-Bus calls with explicit timeouts
  (the 200 ms-capped UPower battery probe), cache IO. Unjustified
  catches were swept in the pre-upload review.
- Unreachable files (EGO-P-007): the zip ships only modules
  reachable from `extension.js` / `prefs.js`; app-only modules
  (e.g. `fetch.js`) are excluded at build time.

## EGO numbers uploads; they are NOT our version integer

Every upload lands in the All-Versions table under SweetTooth's own
counter, and the served zip is re-stamped with it
(`"_generated: Generated by SweetTooth"`, `version` rewritten to
the serial). Consequences (learned on weatherglass, applied here):

- A "version N" on the review page is not a repo bump: our integer
  stays put through a whole review round — same integer, new sha.
- The shell updater compares the INSTALLED metadata version
  against the SERVED serial. To live-verify a local install without
  the shell silently overwriting it, the installed copy's integer
  must sit above the newest active serial (skill step 4).
- "Rejected" next to a serial is not always a reviewer finding: an
  upload superseded by a newer one is auto-rejected. Read
  "Previous Reviews on this Version" before panicking.

## After approval

- The metadata `url` points at the GitHub repo per the EGO review
  guidelines (must be a GitHub/GitLab project URL) — keep it there
  even after approval; link the EGO page from the repo README
  instead.
- Record the outcome (sha, date) in the GitHub release body.
  Next release: integer 2.
