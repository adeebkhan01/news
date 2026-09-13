# The Daily Digest

A static news reader for Bangladesh, Australia and global headlines. A
scheduled GitHub Action pulls RSS feeds into JSON files; the page is a single
`index.html` that reads them. No build step, no server, no dependencies.

## How it works

```
.github/workflows/fetch-feeds.yml   every 3 hours
        └── node fetch.js --region {bd,au,global}
                ├── fetch + parse each RSS/Atom feed
                ├── drop articles older than 30 days, dedupe by link
                ├── backfill missing images from each article's og:image
                ├── translate new Bangladesh articles to Bangla (Claude)
                ├── write a short briefing for the region (Claude)
                └── write data-{bd,au,global}.json  ── committed back to main
index.html  fetches the JSON for the selected region and renders it
```

| File | Purpose |
|---|---|
| `index.html` | The whole front end — markup, styles and script in one file |
| `fetch.js` | Feed fetcher, parser and Claude integration |
| `tools/check-feeds.js` | Feed health check (see below) |
| `data-*.json` | Generated. Committed by the workflow; don't hand-edit |

## Running it locally

```bash
node fetch.js --region bd        # writes data-bd.json
python3 -m http.server 8000      # then open http://localhost:8000
```

The page fetches its data over HTTP, so open it through a server rather than
as a `file://` URL.

`ANTHROPIC_API_KEY` enables the Bangla translations and the region briefing.
Without it the fetch still runs and the page still works — those two features
are simply skipped. In CI the key comes from the `ANTHROPIC_API_KEY` secret.

## Feeds

Sources live in the `REGIONS` table at the top of `fetch.js`. Publishers
retire and block feeds without notice, so check a URL before adding it:

```bash
node tools/check-feeds.js                          # every configured feed
node tools/check-feeds.js --region bd              # one region
node tools/check-feeds.js https://example.com/rss  # try a candidate
```

It exits non-zero when a configured feed is dead. The **Feed Health** workflow
runs the same check every Monday and can be dispatched by hand with candidate
URLs in its input box, which is the easiest way to test replacements — some
publishers answer runners but not local machines, and vice versa.

A feed that fails is not fatal: that source is skipped for the run, previously
collected articles are retained, and the run log ends with a list of what
failed.

## Behaviour worth knowing

- **Articles accumulate.** Each run merges new articles into the existing file
  and prunes anything older than 30 days, so the feed survives a publisher
  outage.
- **Translations retry.** A failure caused by the API being unavailable
  (exhausted credit, rate limits, timeouts) leaves the article queued. Only an
  unusable model response marks it permanently untranslatable, and up to
  `RETRY_PER_RUN` of those are retried each run.
- **A failed briefing keeps the previous one** rather than blanking it.
- **Bangla is Bangladesh-only.** `translate: true` is set per region.
- **Global is topic-filtered** through `TOPIC_KEYWORDS`; the other regions
  take everything their feeds publish.

## Front end

`index.html` holds a small design-token system (`--bg`, `--text`, `--brand`
and friends) with a light and a dark palette, switched by `data-theme` on
`<html>` and remembered in `localStorage`. Type is Libre Baskerville for
headlines, Source Sans 3 for UI, Tiro Bangla for Bangla.

Cards render 24 at a time and load more on scroll; a feed can hold thousands
of articles and putting them all in the DOM makes every later repaint crawl.
