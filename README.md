# AK's Daily Digest

A static news reader for Bangladesh, Australia and global headlines. A
scheduled GitHub Action fetches RSS feeds into one SQLite file per region;
the page reads that file client-side via a vendored build of sql.js. No
server, no build step, no npm dependencies.

It's not an RSS mirror: articles are grouped into stories (one event, however
many publishers covered it), stories are ranked by importance, and a model
writes a short briefing over the top few — what happened, why it matters,
what to watch.

## How it works

```
.github/workflows/fetch-feeds.yml   twice daily (00:20, 12:20 UTC)
  node fetch.js --region {bd,au,global}
    fetch + parse feeds → dedupe → translate (Claude) → cluster into
    stories (lib/cluster.js) → rank + classify topic (lib/rank.js) →
    write briefing (Claude) → validate → write data-{region}.sqlite
  node --test tests/*.test.js   ← gate: failing tests, nothing commits
index.html loads sql.js, fetches the region's .sqlite, queries it client-side
```

A run that fails anywhere (bad URL, bad model output, failing tests) leaves
`main` untouched rather than publishing something broken.

| File | Purpose |
|---|---|
| `index.html` | Markup only, no inline script/style |
| `app.css` / `app.js` | Front end |
| `sw.js` / `manifest.json` | PWA: offline caching, installability |
| `fetch.js` | Feed fetcher, parser, Claude calls |
| `lib/cluster.js` | Groups articles into stories (no model call) |
| `lib/rank.js` | Story ranking + topic classification |
| `lib/db.js` | SQLite schema/writes/pruning (`node:sqlite`) |
| `lib/security.js` | Egress policy + input validation |
| `tests/*.test.js` | `node --test tests/`, no network |
| `tools/check-feeds.js` | Feed health check |
| `vendor/sql-wasm-*` | Vendored sql.js |
| `data-*.sqlite` | Generated — don't hand-edit |

## Running locally

```bash
node fetch.js --region bd        # writes data-bd.sqlite
python3 -m http.server 8000      # open http://localhost:8000
```

Serve over HTTP, not `file://` — the CSP's `connect-src 'self'` needs a real
origin. Run `node --test tests/*.test.js` before pushing.

Needs Node 22+ (`node:sqlite` is built in). `ANTHROPIC_API_KEY` enables
translation and briefings; without it, fetching and the page both still work,
just without those two features.

## Feeds

Sources live in `REGIONS` at the top of `fetch.js`.

```bash
node tools/check-feeds.js                          # every configured feed
node tools/check-feeds.js --region bd
node tools/check-feeds.js https://example.com/rss  # try a candidate
```

Reports `DEAD` (non-200) or `STALE` (parses, but nothing inside the retention
window). The **Feed Health** workflow runs this every Monday and can be
dispatched by hand to test a candidate URL. A test forbids any source from
routing through `news.google.com` — aggregating an aggregator isn't the goal.

**Australia and Global are topic-filtered** (keyword allowlist in `fetch.js`:
`TOPIC_PREFIX_RE` / `TOPIC_WORD_RE` / `TOPIC_ACRONYM_RE`); Bangladesh takes
everything its feeds publish. A source can also `excludeSections` (by URL
path) to drop soft sections like entertainment from an otherwise-wanted feed.

## Security

Rules live in `lib/security.js`, shared by the fetcher and the tests:

- **Fetching**: exact URL allowlist, HTTPS only, no credentials/ports/IP
  literals, redirects re-checked, size/time caps.
- **Storage**: article links and images validated against known domains;
  model output checked for shape, length, no markup, no leaked credentials.
- **Page**: feed text never becomes markup (`textContent` only, no
  `innerHTML`). CSP has no `'unsafe-inline'`; `script-src` is `'self'` plus
  one hash (the theme-bootstrap inline script) plus `'wasm-unsafe-eval'`
  (sql.js). `img-src` lists publisher CDNs by name; a test fails if this list
  and the fetcher's own image rules drift apart.
- **Supply chain**: every GitHub Action pinned to a commit SHA. Only
  `fetch-feeds` has write access. `ANTHROPIC_API_KEY` is scoped to the one
  step that needs it. sql.js is vendored by hand, not npm-managed — the one
  intentional exception to "no dependencies."

Repo settings that can't be committed and still need doing by hand: branch
protection on `main` (require Tests + CodeQL), secret scanning + push
protection, and confirming CodeQL runs off `codeql.yml` rather than default
setup.

## Behavior notes

- Articles accumulate across runs and prune after 120 days.
- A failed briefing keeps the previous one rather than going blank.
- "Why this matters" is cached per story and only rewritten when the story
  gains a member.
- Change badges ("New", "Developing") only appear from the second run a
  region has — day one has no baseline to compare against.
- Bangla translation direction is per-article, not per-region: most sources
  get `titleBn`/`descBn`; Bangla-language sources (Rising BD, Amar Desh) get
  `titleEn`/`descEn`. `lib/lang.js` detects direction from the text itself.
- The page's own UI strings live in `STRINGS` in `app.js`, not translated at
  runtime — a test checks the English and Bangla dictionaries have identical
  keys.

## Front end

Design system: monospace throughout (Space Mono for structure, IBM Plex Mono
for prose, Tiro Bangla for Bangla), navy ink on warm paper, one gold accent,
hard unblurred edges, 2px radius, no spinners or shimmer. Cards page in 24 at
a time on scroll. Below 700px the feed drops to a numbered list — no card
art, no sidebar — since a thumbnail costs more screen than it gives on a
phone.
