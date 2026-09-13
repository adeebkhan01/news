# The Daily Digest

A static news reader for Bangladesh, Australia and global headlines. A
scheduled GitHub Action pulls RSS feeds into JSON files; the page is a single
`index.html` that reads them. No build step, no server, no dependencies.

## How it works

```
.github/workflows/fetch-feeds.yml   twice a day (00:20 and 12:20 UTC)
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
- **Run cadence and the item cap go together.** Runs are 12 hours apart, so
  `MAX_ITEMS_PER_FEED` has to exceed what a feed publishes in 12 hours or
  articles are lost between runs; the busiest single-URL feeds manage 30-35.
  `RETRY_PER_RUN` is sized the same way. Shorten the cron and both can come
  down; lengthen it and both need raising.
- **Translations retry.** A failure caused by the API being unavailable
  (exhausted credit, rate limits, timeouts) leaves the article queued. Only an
  unusable model response marks it permanently untranslatable, and up to
  `RETRY_PER_RUN` of those are retried each run.
- **A failed briefing keeps the previous one** rather than blanking it.
- **Bangla is Bangladesh-only.** `translate: true` is set per region.
- **Australia and Global are topic-filtered**; Bangladesh is not, so it takes
  whatever its feeds publish. The filter is a keyword whitelist in three
  parts: `TOPIC_PREFIX_RE` matches any continuation (`econom` catches
  economy/economic/economics), `TOPIC_WORD_RE` matches whole words only
  (`tax` must not catch taxi), and `TOPIC_ACRONYM_RE` is case-sensitive so
  `/i` doesn't match the ordinary words "un", "eu" and "ai". It applies to
  stored articles as well as new ones, so editing the keywords takes effect
  on the next run.
- **Soft sections are excluded per source.** A publisher with one site-wide
  feed sends entertainment and photo galleries along with the news, and the
  section is in the article URL (`en.prothomalo.com/entertainment/...`), so
  `excludeSections` on a source drops them by section rather than by guessing
  from keywords. Prothom Alo excludes `entertainment`, `photo` and
  `lifestyle`; sports and opinion are kept. The filter also applies to
  already-stored articles, so a change takes effect on the next run instead
  of waiting out the 30-day retention.

## Front end

`index.html` is set in the **Aparajita** design system (brand guidelines
v1.0). Tokens live at the top of the stylesheet: base scales (`--paper-*`,
`--ink-*`, `--gold-*`) and the semantic aliases (`--bg-page`, `--text-body`,
`--border-strong`) that every rule references, so the night theme re-points
the aliases without touching a component. Token values are taken from the
system's own token file, including the night theme and the status hexes the
written guidelines name but do not specify.

What the system asks for, and where it shows up here:

- **Monospace throughout.** Space Mono 700 for structure — headlines, buttons,
  tabs, micro-labels — and IBM Plex Mono for prose and data. Never the reverse.
  Tiro Bangla stays for Bangla, as no monospace Bengali face exists.
- **Navy on warm paper.** Never pure black or white. Per-source brand colours
  were dropped: the palette is ink plus one gold.
- **One gold thing per view** — here, the wordmark tick. The region tabs
  therefore use the lifted-paper active state rather than a gold rule. The
  focus ring and selection wash are gold by exemption.
- **A hard, unblurred edge** on every raised box, offset down-and-right in a
  darker shade of its own surface. Raised acts, inset receives: buttons and
  cards are raised, the search field is inset. Nothing is blurred anywhere.
- **2px radius everywhere**, 1px ink borders, dashed hairlines between rows.
- **Micro-labels** — 11px uppercase, +0.14em — above every section and field.
- **Motion is 70ms on state, 130ms on layout**, and nothing else. No shimmer,
  no spinner, no entrance animation: loading says "48 / 3435 shown", a refresh
  says "Fetching", and a run state is a glyph plus a colour.
- **Icons are unicode glyphs** set in Space Mono. No SVG icon set, no emoji.
- **Images are evidence.** Article art is the publisher's own; anything
  missing gets the 135° striped placeholder captioned with what belongs there.

Cards render 24 at a time and load more on scroll; a feed can hold thousands
of articles and putting them all in the DOM makes every later repaint crawl.

**The lead slot is a fixed box** (`--lead-h`), because ordinary cards are
levelled by the grid row stretching them to match while the lead has a row to
itself — without it the lead's height swung with the length of whichever
headline led the region.

**Below 700px the feed becomes a bulletin**: article art is hidden, the cards
give up their boxes and become numbered entries on dashed hairlines, the
standfirst is dropped, and the Latest panel is hidden because it repeats the
top of the feed. Card art costs a phone screen more than it gives — each
thumbnail is a scroll-length between one headline and the next.
