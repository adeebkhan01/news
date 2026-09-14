# The Daily Digest

A static news reader for Bangladesh, Australia and global headlines. A
scheduled GitHub Action pulls RSS feeds into a small database, one file per
region; the page reads it. No build step, no server, no dependencies of its
own on the write side — the one real dependency this project has is on the
read side, a vendored WebAssembly build of SQLite the page uses to query its
own data file client-side.

It is not an RSS mirror. The pipeline groups the articles into *stories* —
one event, however many publishers covered it — ranks those stories by how
much they matter rather than how recently they arrived, and writes a briefing
over the top few: what happened, why it matters, what to watch.

## How it works

```
.github/workflows/fetch-feeds.yml   twice a day (00:20 and 12:20 UTC)
        └── node fetch.js --region {bd,au,global}
                ├── check every URL against the egress policy (lib/security.js)
                ├── fetch + parse each RSS/Atom feed
                ├── drop articles older than the retention window, dedupe by link
                ├── backfill missing images from each article's og:image
                ├── detect each article's language, translate it the other way (Claude)
                ├── group articles into stories (lib/cluster.js)
                ├── rank the stories and classify their topics (lib/rank.js)
                ├── write the briefing over the top stories, and a
                │   "why this matters" line for the top of the feed (Claude)
                ├── translate both into Bangla (Claude)
                ├── validate everything the model returned
                ├── diff against the last dated snapshot (lib/db.js)
                └── write data-{bd,au,global}.sqlite
        └── node --test tests/*.test.js   ── the gate: red here, nothing is committed
                └── data-*.sqlite committed back to main
index.html  loads sql.js (vendor/), fetches the region's .sqlite file whole,
            and queries it client-side for everything it renders
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
| `lib/cluster.js` | Grouping articles into stories — offline, no model call |
| `lib/rank.js` | Story ranking and topic classification |
| `lib/db.js` | The database: schema, the write transaction, pruning — Node-side, via `node:sqlite` |
| `lib/security.js` | Egress policy and input validation — what may be fetched, what may be published |
| `tests/*.test.js` | `node --test tests/*.test.js`. No network, no dependencies |
| `tools/check-feeds.js` | Feed health check (see below) |
| `vendor/sql-wasm-*.{js,wasm}` | sql.js — vendored, not installed; how the page reads its own data files |
| `data-*.sqlite` | Generated. Committed by the workflow; don't hand-edit |

## Running it locally

```bash
node fetch.js --region bd        # writes data-bd.sqlite
python3 -m http.server 8000      # then open http://localhost:8000
```

The page fetches its data over HTTP, so open it through a server rather than
as a `file://` URL — the `.sqlite` file is fetched with the same `fetch()`
call as any other same-origin resource, and `file://` has no origin for
`connect-src 'self'` to mean anything about. Run `node --test tests/*.test.js`
before pushing; CI runs the same command, and the publishing workflow runs it
again between fetching and committing.

`fetch.js` needs Node 22 or newer — `node:sqlite` is built in from there, so
this adds no package and no install step, but it does mean an older Node
cannot run it. The front end has no such requirement; any browser that runs
WebAssembly opens the page.

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
crash. A feed that answers but whose newest item is already past the retention
window is reported `STALE`: it parses fine and contributes nothing. The
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

## Stories, ranking and the briefing

Three stages sit between the feeds and the page, and they are what make this
a briefing rather than a list.

**Grouping (`lib/cluster.js`).** Headlines become IDF-weighted token vectors
and are compared by cosine similarity; anything above the threshold, published
within four days, and sharing at least two tokens rare enough to mean
something joins the same story. No model call, no embedding service, nothing
that can fail halfway through a run or cost money per article.

It is tuned to **under-merge**. A story split in two reads as two stories,
which is what the page did before any of this existed. A wrong merge puts one
publisher's headline over another publisher's link, which is a
misattribution — so the threshold was set by reading the merges it produces
over the three real data files, not derived: at 0.42 it found 15 multi-source
stories in a month of global news; at 0.24 it began joining an analysis piece
to the event it analysed. At 0.30 every merge across all three regions was the
same event.

Marks matter more than they look. Bengali vowel signs are combining marks
rather than letters, so a token pattern of `\p{L}\p{N}` alone splits বাংলাদেশ
into five one-character fragments and a Bangla headline tokenises to nothing.
With `\p{M}` in the class, a Bangla report and an English one about the same
event cluster together — which they now do, via the English translation the
pipeline already bought.

**Ranking (`lib/rank.js`).** Four multiplicative factors: corroboration (how
many independent newsrooms carried it, log-scaled), recency (half-life 18
hours), topic weight, and burst (how concentrated the coverage is in time).
Multiplicative rather than additive, so a factor at its floor suppresses a
story instead of being outvoted — a week-old cricket round-up covered by four
outlets should not out-rank this morning's rate decision on volume alone.
Every factor is returned alongside the score, because a rank nobody can
explain is a rank nobody can debug.

There is deliberately **no per-publisher quality score**. There is no
defensible basis for asserting that one masthead is worth 1.3 of another, and
a number invented to look rigorous is worse than no number. What the pipeline
can honestly observe is how many independent newsrooms judged the event worth
covering, and that factor does most of the work.

`TOPIC_WEIGHT` is an editorial position, not a fact: this is a current-affairs
briefing, so a central-bank decision outranks a cricket result. Someone
building a sports product would invert the table, and should.

**The briefing.** The model is handed ranked, deduplicated stories with each
publisher's wording, and asked for one object per story: a headline, what
happened, why it matters, what to watch. That is the whole reason it can be
written at all — asked to summarise forty raw headlines, it had no way to know
which five mattered. `security.validateBriefing` enforces the promise: three
to seven items, every field within length, no markup, `watch` the only field a
story is allowed not to have. Anything else is a failed call and the previous
briefing stays up.

**On the page.** The feed shows one card per story, defaulting to importance
order with a Latest toggle beside the heading. A card names how many sources
carried the story; a story only one newsroom carried says so, because that is
a weaker claim and should not look identical, and the count is also the way
in — clicking it opens a comparison of every publisher's own wording of the
event, closed by default and costing nothing until asked for. The "why this
matters" line lives in the briefing only, not repeated on every card: the
stories that matter most already carry the analysis there, and putting it on
every card too was exactly the kind of per-item chrome a scanning reader is
meant to get past, not read.

## The page must not get longer

Intelligence that costs height is not free, and the first version of all this
spent height it had not earned: the briefing panel went from 346px to 829px on
desktop and from 213px to **1,299px** on a phone, and the number of stories
visible in the first screen went from two to none. A briefing you have to
scroll past is not a briefing.

So the page is measured, not eyeballed. The rule is that the reader should
understand the day in about thirty seconds, and the metric that tracks it is
**how far you scroll before you have seen six of the day's stories** —
counting briefing items as stories, because they are.

| | before any of this | now |
|---|---|---|
| Briefing panel, desktop | 346px | 494px |
| Briefing panel, phone | 213px | 602px |
| **Scroll to six stories, desktop** | 2,270px | **1,188px** |
| **Scroll to six stories, phone** | 1,291px | **1,154px** |
| Whole page, desktop | 5,629px | 5,489px |

Six stories now cost about half the scroll they used to on desktop and
slightly less on a phone — and each of those six carries a source count and
a change marker, where before they were bare headlines.

Four rules got it there, and they are worth keeping:

**One line per thing.** A source count and a "developing" marker are four
words; given a row of their own they cost more height than the headline they
annotate. They ride on the end of the headline instead. The card's own
"why this matters" line went further: it is not on the card at all any more.
It survived one round as a labelled paragraph and another as an inline
`Why:` clamped to two lines, but neither earned a permanent place — the
stories that matter most already carry the analysis in the briefing above,
and repeating it under every card was exactly the per-item chrome a scanning
reader is here to get past. The sentence itself is untouched in the data; it
simply is not rendered a second time.

**Nothing may grow on a talkative day.** Every model-written line is clamped
to two lines, so the height of the page does not depend on how expansive the
model felt that morning. The prompts ask for eighteen words for the same
reason — not to save space, since the clamp already bounds it, but so the
reader sees a finished sentence rather than a truncated one.

**Depth goes behind the count.** The source comparison — each newsroom's own
wording of the same event, how many reports from how many sources, and how
long the story has been running — opens from the `N sources` chip. Closed it
costs nothing; open it is the one thing an aggregator can do that a single
masthead cannot.

**The feed does not repeat the briefing.** Briefing headlines link straight to
the story, and the ranked feed skips what the briefing already covered. Five
cards restating the five items directly above them was the single biggest
thing standing between a reader and the sixth story of the day. For the same
reason there is no hero card while a briefing is up: the first card in the
feed would be the sixth most important thing that happened, and giving that
the largest box on the page under a badge reading "Lead story" is the page
contradicting itself.

And the ranked view stops at thirty stories. The feed holds a month — around
1,300 — and an infinite scroll over them is the instinct this product exists
to resist: comprehensiveness is what an RSS reader already gives you, and it
is why reading one takes all morning. Past thirty the honest answer is
"nothing else today", with Latest one click away for everything.

## The database

Everything the page knows used to be overwritten twice a day, which was fine
for a feed and useless for a reader who came back: "what changed since I
last looked" was unanswerable when there was only ever a now, and the
history that made it answerable — a dated archive of headlines — had to be
kept compact, because a flat JSON file rewritten wholesale every run could
not afford to hold 120 days of full articles. A real database does not have
that problem, so it now holds everything within the retention window:
articles, the stories they cluster into, every day's structured briefing in
full, and a frozen daily snapshot of the top twenty stories for the
day-over-day diff and the archive. One file per region, one retention
window (120 days) for all of it, replacing the two-tier design (30 days of
articles, 120 of archive headlines) that used to exist only because storing
more than that was expensive.

**Written with `node:sqlite`, read with sql.js.** The pipeline (Node,
`lib/db.js`) writes a standard SQLite file using Node's own built-in driver
— no npm package, no install step, the thing this project has never had.
The page (the browser) reads that exact file back with
[sql.js](https://github.com/sql-js/sql.js), a WebAssembly build of SQLite,
vendored into `vendor/` rather than pulled from a CDN — the CSP allows
`script-src 'self'` and nothing else, so a third-party script has to be
self-hosted to run at all. Nothing is exported or converted between the two:
whatever Node wrote to disk is exactly what the browser opens, because both
are the same file format. `'wasm-unsafe-eval'` is the one narrow addition to
the CSP this needs — WebAssembly.instantiate asks for it specifically, and it
grants nothing `eval` or `new Function` would; `tests/frontend.test.js`
checks the vendored file never actually needs the broader grant.

**One request per region, then no more.** Switching from Bangladesh to
Australia fetches a new `.sqlite` file — the one real piece of network
traffic the page makes beyond its own static assets. Everything after that —
searching, filtering, switching between Top Stories and Latest, browsing the
archive twenty days back — is a SQL query against the file already sitting
in the browser's memory. The old archive fetched a fresh JSON file for every
day a reader stepped back through; this fetches nothing for any of it.

**The migration.** The first time `fetch.js` runs against a region with no
database yet, and a legacy `data-{region}.json` still on disk, it imports
that file's articles, stories and briefing into the new database before
doing anything else — so translations and a briefing that already cost real
API calls are not silently thrown away and re-bought. This runs at most
once per region, ever: the JSON file is deleted once it has been read, and a
region with no JSON file (or a database already holding rows) skips the step
entirely. It is deliberately not a full historical import — the JSON file
only ever held "now", never a day-by-day past — so the one snapshot this
writes simply establishes migration day as day one of database-backed
history, honestly, rather than inventing days that were never recorded.

**The baseline is a day strictly before today.** Both of a day's runs write
to the same date, so comparing today against today would report the
morning's news as unchanged since the morning. A region whose history has a
gap compares against the last day it has, and that day is stored in the
database (`meta.changedSince`) so the page can say which one rather than
claiming "yesterday".

**With no baseline, nothing is new.** On the first run every story is
trivially new, and a page announcing 146 new stories on its first morning
teaches its reader to ignore the badge forever. The diff returns nothing
rather than a verdict, no story carries a `status`, and the page renders no
markers — which is deliberately *not* the same as rendering "unchanged". So
the markers appear from the second day the pipeline runs, not the first.

A story that lost members is not "developing" either: articles age out of
the retention window, so a story can shrink, and that is not a development.

**A run that fails to generate a briefing falls back to the most recently
written one, whatever day it was written under** — not strictly today's.
That is the same property the single unversioned JSON blob had by simply
not being overwritten; the difference is that a day with nothing generated
now honestly has no row for that day, rather than an undated blob quietly
describing an older one.

**Browsing it.** The briefing panel carries Older / Today / Newer, and the
selected day is in the URL — `index.html?region=bd&date=2026-09-13` — so a
dated briefing is a link someone can send to someone else, and it opens
instantly: no fetch, just a different query against the database already in
memory. Today's own snapshot is skipped when stepping back, because the live
view already shows that day and an Older button landing on the date already
on screen reads as a bug; a link straight to it still opens it.

An archived day renders as a list, not a card grid: the snapshot holds
headlines, and cards would promise art, descriptions and a live source
breakdown it deliberately does not carry. The controls that describe live
data — the source chips, the ordering, the LIVE strip — are hidden rather
than disabled, because a day that is over has no live ordering to offer.

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
hash for the five-line theme bootstrap that has to run before first paint,
plus `'wasm-unsafe-eval'` for sql.js's WebAssembly instantiation — the one
narrow grant beyond `'self'`, and narrower than `'unsafe-eval'`: sql.js
doesn't call `eval` or `new Function` at all, and `tests/frontend.test.js`
checks the vendored file for exactly that, not just app.js.
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
a key, so a leak cannot reach a committed database file.

sql.js is the one exception to "no dependencies", and it is deliberately not
managed the way a real dependency would be: no `package.json`, no lockfile,
no Dependabot — it is two files under `vendor/`, fetched once from the npm
registry, checked into git like any other asset, and upgraded by hand
(replacing both files and every filename reference to them) on the rare
occasion sql.js itself needs it. Nothing about that upgrade path is
automatic, which is the honest trade for having no automatic update
mechanism pull in something unreviewed.

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

- **Articles accumulate.** Each run merges new articles into the database
  and prunes anything older than the 120-day retention window, so the feed
  survives a publisher outage.
- **Run cadence and the item cap go together.** Runs are 12 hours apart, so
  `MAX_ITEMS_PER_FEED` has to exceed what a feed publishes in 12 hours or
  articles are lost between runs; the busiest single-URL feeds manage 30-35.
  `RETRY_PER_RUN` is sized the same way. Shorten the cron and both can come
  down; lengthen it and both need raising.
- **Translations retry.** A failure caused by the API being unavailable
  (exhausted credit, rate limits, timeouts) leaves the article queued. Only an
  unusable model response marks it permanently untranslatable, and up to
  `RETRY_PER_RUN` of those are retried each run.
- **A failed briefing keeps the previous one** rather than blanking it, and a
  briefing is only rewritten when the run brought in new articles.
- **The briefing is translated, not written twice.** For a region with
  `translate: true` the English briefing is generated first and then
  translated item by item into `briefingBn`, so both languages describe the
  same stories in the same order. A new briefing clears the old translation;
  the translation is retried each run until it lands, and the page falls back
  to English until it does.
- **A "why this matters" line is bought once per story.** It is cached against
  the story id and reused until the story gains a member — at which point the
  line was written against a smaller set of headlines and is rewritten. Story
  ids are derived from the *earliest* member's link, which is the one part of
  a growing story that does not change.
- **A run with no briefing writes no snapshot.** A snapshot whose briefing is
  null is a baseline that makes tomorrow's comparison compare against nothing,
  which is worse than having no snapshot for that day.
- **Not every story gets a row in the `stories` table.** Only those with more
  than one member (so the page can collapse them into one card) and the top
  few by rank (which carry the analytical line). An article can still point
  at a story id with no row of its own — the page treats that exactly like a
  story it has never heard of, which is what it is.
- **A story with no live article left in it is deleted immediately**, not
  only at the end-of-run prune — the same write transaction that removes an
  article's last reference to a story sweeps the now-empty story away, so a
  reader can never be handed a story with nothing behind it.
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
  of waiting out the retention window.

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
