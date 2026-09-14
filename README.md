# The Daily Digest

A static news reader for Bangladesh, Australia and global headlines. A
scheduled GitHub Action pulls RSS feeds into JSON files; the page reads them.
No build step, no server, no dependencies.

## How it works

```
.github/workflows/fetch-feeds.yml   twice a day (00:20 and 12:20 UTC)
        └── node fetch.js --region {bd,au,global}
                ├── check every URL against the egress policy (lib/security.js)
                ├── fetch + parse each RSS/Atom feed
                ├── drop articles older than 30 days, dedupe by link
                ├── backfill missing images from each article's og:image
                ├── detect each article's language, translate it the other way (Claude)
                ├── write a short briefing, and translate it for Bangladesh (Claude)
                ├── validate everything the model returned
                └── write data-{bd,au,global}.json
        └── node --test tests/*.test.js   ── the gate: red here, nothing is committed
                └── data files committed back to main
index.html  fetches the JSON for the selected region and renders it
```

Every stage refuses rather than repairs. A URL that fails the policy is not
fetched, an article without a usable link is not stored, an image from an
unknown host loses its picture, a model answer that is not the declared shape
is discarded and the previous one kept, and a run whose output fails the tests
is not published at all — the data already on `main` stays up instead.

| File | Purpose |
|---|---|
| `index.html` | Markup only — no inline script, no inline styles, no handlers |
| `app.css` / `app.js` | The front end. Separate files so the CSP can forbid inline code |
| `fetch.js` | Feed fetcher, parser and Claude integration |
| `lib/security.js` | Egress policy and input validation — what may be fetched, what may be published |
| `tests/*.test.js` | `node --test tests/*.test.js`. No network, no dependencies |
| `tools/check-feeds.js` | Feed health check (see below) |
| `data-*.json` | Generated. Committed by the workflow; don't hand-edit |

## Running it locally

```bash
node fetch.js --region bd        # writes data-bd.json
python3 -m http.server 8000      # then open http://localhost:8000
```

The page fetches its data over HTTP, so open it through a server rather than
as a `file://` URL. Run `node --test tests/*.test.js` before pushing; CI runs
the same command, and the publishing workflow runs it again between fetching
and committing.

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

It exits non-zero when a configured feed is dead — that is the signal, not a
crash. A feed that answers but whose newest item is already past the 30-day
retention is reported `STALE`: it parses fine and contributes nothing. The
**Feed Health** workflow
runs the same check every Monday and can be dispatched by hand with candidate
URLs in its input box, which is the easiest way to test replacements — some
publishers answer runners but not local machines, and vice versa.

`STALE` is a real retirement signal, not a warning: The Daily Star's
`frontpage` and `bangladesh` feeds were dropped on it in 2026-09, both
answering 200 and parsing cleanly with newest items 1514 and 207 days old. Its
`business` feed is still live and stays.

The first Feed Health run over the eight previously unverified feeds settled
all of them on 2026-09-14: **30 live, 0 stale, 7 dead of 37**. What it taught,
beyond which URLs work:

- **A 403 or 404 is recoverable; a TLS refusal is not.** Dhaka Tribune and New
  Age returned 403 and UNB 404 — the publisher blocking the runner or moving a
  path, which Google News routes around. All five CNN URLs failed at the
  handshake with "socket disconnected before secure TLS connection was
  established", which is not an HTTP status and not a wrong path. CNN is
  retired; Global is already covered by BBC, Al Jazeera, the Guardian, NPR,
  France 24 and DW.
- **Guessing a path is worth one run.** Amar Desh's `/rss.xml` and
  `/rss/rss.xml` were both 404 while `/feed` answered with the freshest
  articles in the region. Google News carried it for a day; its own feed is
  strictly better and it went straight back.

Four sources were retired outright rather than kept: Dhaka Tribune and New Age
(403), UNB (404) and BTV (a self-signed certificate). A Google News
`site:` query reaches all four and was used for exactly one day before being
removed — it costs the publisher's own article links, so readers land on a
`news.google.com` redirect, and it carries no images at all, so every card
shows the placeholder. Aggregating an aggregator is not what this reads.

Their untried paths are in the Feed Health candidates box. The only thing that
brings one of them back is its own feed answering: dispatch the workflow, and
if something reports `ok`, add the source pointing at that URL. A test asserts
no source fetches from `news.google.com`, so the route cannot come back by
accident.

A feed that fails is not fatal: that source is skipped for the run, previously
collected articles are retained, and the run log ends with a list of what
failed.

## Security

Everything this project handles comes from somewhere it does not control: the
bytes a publisher's feed returns, the URLs inside those bytes, and whatever the
model writes after reading forty headlines other people wrote. The rules for
all three live in `lib/security.js`, in one place, so they can be tested on
their own and cannot drift apart between the fetcher and the tools.

```
RSS feeds
  └── exact URL allowlist · https only · no credentials, ports or address literals
       └── fetch: redirects off by default, re-checked when on, timeout, size cap
            └── article links validated · images matched against known CDNs
                 └── model output: declared shape, length, no markup, no credentials
                      └── tests/*.test.js ── PASS publishes, FAIL leaves main alone
                           └── GitHub Pages
```

**What may be fetched.** The allowlist is derived from the feed list itself, so
widening what this script talks to means adding a source — a reviewable diff,
not a config flag. Feeds match by exact URL rather than by domain. Article
pages are fetched only on a domain the source list already covers; the BBC is
the one publisher whose articles do not live on its feed's domain, and its
entry says so via `linkDomains` rather than the rule being loosened for
everyone. Registrable domains are computed against a real suffix list, because
"last two labels" reads `unb.com.bd` as `com.bd` and would quietly admit every
commercial host in Bangladesh.

**What may reach the runner.** https only. No credentials in the URL, no
non-default port, no address literals, no private, loopback, link-local or
`.internal` names — which is what keeps a redirect away from cloud instance
metadata. Checked on the first URL and again on every hop, because a 302 that
is not re-checked is the check not happening.

**What reaches the page.** Feed text is never turned into markup. Cards, the
Latest list, the chips, the facts and the error notices are built as DOM nodes
and set with `textContent`; search highlighting appends text nodes and its own
element rather than wrapping a tag around escaped text. There is no
`escapeHTML` any more because there is nothing to escape for. The CSP has no
`'unsafe-inline'` on scripts or styles: `script-src` is `'self'` plus a SHA-256
hash for the five-line theme bootstrap that has to run before first paint.
`img-src` names the publishers' CDNs one by one, and a test fails if that list
and the fetcher's own image rules drift apart.

`frame-ancestors` is omitted deliberately — it is ignored in a meta CSP. So are
`Strict-Transport-Security`, `X-Content-Type-Options` and `Referrer-Policy`:
they are response headers, and GitHub Pages does not let you set any. Getting
them means putting a CDN in front (Cloudflare, Netlify) or hosting elsewhere.
HSTS at least is partly moot, since Pages already serves HTTPS and redirects.

Fonts come from Google, so visitors' IPs reach Google; self-hosting the two
woff2 files removes that, and `font-src` already allows `'self'`.

**Supply chain.** Every action is pinned to a commit SHA — a tag is a mutable
pointer in someone else's repository — with the version in a trailing comment,
and Dependabot raises a PR weekly so pinned does not become stale. Workflow
permissions stop at what each job does: only `fetch-feeds` may write, because
it is the only one that commits. `ANTHROPIC_API_KEY` is scoped to the single
step that calls the API, and the validator refuses any model output containing
a key, so a leak cannot reach a committed data file.

### Still to do, by hand

Three things are repository settings rather than files, so they cannot be
committed. In **Settings → Branches** and **Settings → Code security**:

- **Protect `main`** — require the Tests and CodeQL checks to pass, and
  disallow force pushes. Note that `fetch-feeds` pushes to `main` twice a day,
  so either allow the `github-actions` bot to bypass the rule or have the
  workflow open a PR instead.
- **Enable secret scanning** and **push protection** — push protection is the
  half that matters, since it refuses the commit rather than reporting it
  afterwards.
- **Confirm CodeQL** is picking up `codeql.yml` rather than default setup;
  having both configured makes the workflow silently inert.

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
- **The briefing is translated, not written twice.** For a region with
  `translate: true` the English briefing is generated first and then
  translated into `summaryBn`, so both languages describe the same headlines.
  A new briefing clears the old translation; the translation is retried each
  run until it lands, and the page falls back to English until it does.
- **Bangla is on for every region.** `translate: true` is still set per region
  in `fetch.js`, and `hasLang` in `REGION_CONFIG` (`app.js`) has to match —
  it decides whether the page offers the toggle.
- **Translation runs in whichever direction the article needs.** Most feeds
  publish English, so they get `titleBn`/`descBn`. Rising BD publishes Bangla,
  so its articles get `titleEn`/`descEn` instead. Each article carries its own
  text in `title`/`desc` and exactly one translation alongside it — never both,
  so there is no question of which copy is authoritative. `lib/lang.js` decides
  the direction from the text itself, falling back to the source's declared
  `lang` only when a title is too short to judge.
- **Detection is a ratio, not a character test.** The taka sign ৳ sits in the
  Bengali Unicode block, so "raise ৳400 crore" contains Bengali while being an
  English headline. Asking what *share* of a headline is Bengali gets that
  right; asking whether it contains any Bengali does not, and the wrong answer
  means paying to translate English into English.
- **The page's own words are not translated at run time.** They are fixed, so
  they live in the `STRINGS` dictionary in `app.js` and cost nothing. Pressing
  the toggle switches every label, notice, count, relative time, date format,
  numeral system (Bengali digits) and source name, not just the headlines. A
  test asserts the two dictionaries have identical keys and identical
  interpolation slots, because a missing key renders English inside a Bangla
  page with no error anywhere.
- **A newly translated region backfills over several runs.** Switching
  `translate` on queues the region's entire stored month at once, so
  `BACKFILL_PER_RUN` caps how much of that backlog one run takes and drains it
  newest-first. Articles waiting their turn render in English; the toggle does
  not wait for the backlog to finish.
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

The page is set in the **Aparajita** design system (brand guidelines
v1.0). Tokens live at the top of `app.css`: base scales (`--paper-*`,
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

**The briefing sits beside a facts panel.** Prose is capped at the 68ch
measure the system requires, which leaves the panel wide; the space carries
region, article count, source count and freshness rather than a stretched
line length.

**The page width is `(100vw + 1180px) / 2`** — half the side margin the
system's 1180px column would leave, on request. Below 1180px it exceeds the
viewport and stops binding, so narrow screens are unaffected.

**The lead slot is a fixed box** (`--lead-h`), because ordinary cards are
levelled by the grid row stretching them to match while the lead has a row to
itself — without it the lead's height swung with the length of whichever
headline led the region.

**Below 700px the feed becomes a bulletin**: article art is hidden, the cards
give up their boxes and become numbered entries on dashed hairlines, the
standfirst is dropped, and the Latest panel is hidden because it repeats the
top of the feed. Card art costs a phone screen more than it gives — each
thumbnail is a scroll-length between one headline and the next.
