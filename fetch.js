const https   = require('https');
const fs      = require('fs');
const security = require('./lib/security.js');
const lang     = require('./lib/lang.js');
const cluster  = require('./lib/cluster.js');
const rank     = require('./lib/rank.js');
const archive  = require('./lib/archive.js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Feeds retired 2026-09 after failing on every scheduled run for weeks.
// Re-add only with a green result from `node tools/check-feeds.js <url>`:
//   bdnews24 widget feed        403   publisher blocks the runner
//   TBS News /rss               404
//   Daily Sun /rss              403
//   SMH /rss/politics.xml       404   national.xml still carries politics
//   SBS politics + environment  404   no working replacement found
//   Al Jazeera economy.xml      404   all.xml already covers it
//   AP News (3 feeds)           403   AP no longer serves public RSS
//   Financial Express /feed/    200   answers, parses 0 articles
//   DW rss_en_enviro            200   answers, parses 0 articles
// Retired 2026-09-14, after the first Feed Health run over them:
//   Dhaka Tribune /feed          403   blocks the runner
//   New Age /feed/rss.xml        403   blocks the runner
//   UNB /rss                     404   moved; no working path found
//   BTV /rss.xml                 TLS   self-signed certificate
// All four briefly came in through a Google News site: query instead. That
// worked, and was removed anyway: it costs the publisher's own article links
// (readers land on a news.google.com redirect) and every image, so the cards
// carry no art. Aggregating an aggregator is not what this reads. Their
// untried direct paths are in the Feed Health candidates box — if one answers,
// the source goes back in pointing at it, and at nothing else.
// Retired 2026-09-14, all three CNN feeds plus both alternates:
//   rss.cnn.com (5 URLs)        TLS   "socket disconnected before secure TLS
//                                     connection was established" — refused at
//                                     the handshake, not an HTTP status, so it
//                                     is the runner being blocked rather than a
//                                     wrong path. Global is already covered by
//                                     BBC, Al Jazeera, Guardian, NPR, France 24
//                                     and DW; routing CNN through Google News
//                                     would add image-less cards to a region
//                                     that does not need them.
// Retired 2026-09 for staleness: they answer 200 and parse cleanly, but their
// newest item is already outside the 30-day retention window, so every run
// fetched them and kept nothing.
//   thedailystar.net/frontpage/rss.xml  (newest item 1514d old)
//   thedailystar.net/bangladesh/rss.xml (newest item  207d old)
// Checked but not adopted, same reason:
//   tbsnews.net/rss.xml (1766d), sbs.com.au/news/feed (18d, dormant)
const REGIONS = {
  bd: {
    label: 'Bangladesh',
    dataFile: 'data-bd.json',
    translate: true,
    summaryPrompt: 'You are a concise news briefing editor covering Bangladesh.',
    sources: [
      { id: 'dailystar', name: 'The Daily Star', color: '#1a7a4a', url: 'https://www.thedailystar.net/business/rss.xml' },
      // Site-wide feed, so it carries the soft sections too. The article URL
      // names its section, which is a far better signal than keyword matching.
      { id: 'prothomalo',       name: 'Prothom Alo',       color: '#c0392b', url: 'https://en.prothomalo.com/feed/',
        excludeSections: ['entertainment', 'photo', 'lifestyle'] },
      // The one Bangla-language feed on the list. Its articles are translated
      // into English rather than out of it; `lang` is the fallback for a title
      // too short for detection to judge.
      { id: 'risingbd',         name: 'Rising BD',         color: '#0f7b6c', url: 'https://www.risingbd.com/rss/rss.xml',
        lang: 'bn' },
      // Amar Desh publishes at dailyamardesh.com, and /feed answers — 20
      // articles, freshest in the region. It came in through Google News for
      // one day because /rss.xml and /rss/rss.xml both 404 and no index listed
      // the right path; its own feed is strictly better, so the detour is over.
      { id: 'amardesh',         name: 'Amar Desh',         color: '#8c4a1f', url: 'https://www.dailyamardesh.com/feed',
        lang: 'bn' },
    ]
  },
  au: {
    label: 'Australia',
    dataFile: 'data-au.json',
    translate: true,
    topicFilter: true,
    summaryPrompt: 'You are a concise news briefing editor covering Australia.',
    sources: [
      { id: 'abcnews',        name: 'ABC News',              color: '#E64626', url: 'https://www.abc.net.au/news/feed/51892/rss.xml' },
      { id: 'abcnews',        name: 'ABC News',              color: '#E64626', url: 'https://www.abc.net.au/news/feed/1534/rss.xml' },
      { id: 'guardianau',     name: 'The Guardian AU',       color: '#052962', url: 'https://www.theguardian.com/australia-news/australian-politics/rss' },
      { id: 'guardianau',     name: 'The Guardian AU',       color: '#052962', url: 'https://www.theguardian.com/business/rss' },
      { id: 'guardianau',     name: 'The Guardian AU',       color: '#052962', url: 'https://www.theguardian.com/science/rss' },
      { id: 'guardianau',     name: 'The Guardian AU',       color: '#052962', url: 'https://www.theguardian.com/environment/rss' },
      { id: 'smh',            name: 'Sydney Morning Herald', color: '#0A5CA8', url: 'https://www.smh.com.au/rss/feed.xml' },
      { id: 'smh',            name: 'Sydney Morning Herald', color: '#0A5CA8', url: 'https://www.smh.com.au/rss/business.xml' },
      { id: 'smh',            name: 'Sydney Morning Herald', color: '#0A5CA8', url: 'https://www.smh.com.au/rss/national.xml' },
      { id: 'smh',            name: 'Sydney Morning Herald', color: '#0A5CA8', url: 'https://www.smh.com.au/rss/environment.xml' },
      { id: 'smh',            name: 'Sydney Morning Herald', color: '#0A5CA8', url: 'https://www.smh.com.au/rss/technology.xml' },
      { id: 'conversationau', name: 'The Conversation AU',   color: '#D8352A', url: 'https://theconversation.com/au/business/articles.atom' },
      { id: 'conversationau', name: 'The Conversation AU',   color: '#D8352A', url: 'https://theconversation.com/au/politics/articles.atom' },
      { id: 'conversationau', name: 'The Conversation AU',   color: '#D8352A', url: 'https://theconversation.com/au/technology/articles.atom' },
      { id: 'conversationau', name: 'The Conversation AU',   color: '#D8352A', url: 'https://theconversation.com/au/environment/articles.atom' },
    ]
  },
  global: {
    label: 'Global',
    dataFile: 'data-global.json',
    translate: true,
    topicFilter: true,
    summaryPrompt: 'You are a concise news briefing editor covering global affairs.',
    sources: [
      // The feed is on bbci.co.uk and every article is on bbc.co.uk, so the
      // article domain can't be derived from the feed URL the way it can for
      // every other source. linkDomains is how a source says so.
      { id: 'bbcnews',   name: 'BBC News',    color: '#BB1919', url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
        linkDomains: ['bbc.co.uk', 'bbc.com'] },
      { id: 'bbcnews',   name: 'BBC News',    color: '#BB1919', url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
        linkDomains: ['bbc.co.uk', 'bbc.com'] },
      { id: 'bbcnews',   name: 'BBC News',    color: '#BB1919', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
        linkDomains: ['bbc.co.uk', 'bbc.com'] },
      { id: 'aljazeera', name: 'Al Jazeera',  color: '#D2A02E', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
      { id: 'guardian',  name: 'The Guardian', color: '#052962', url: 'https://www.theguardian.com/world/rss' },
      { id: 'npr',       name: 'NPR',         color: '#E11B22', url: 'https://feeds.npr.org/1001/rss.xml' },
      { id: 'npr',       name: 'NPR',         color: '#E11B22', url: 'https://feeds.npr.org/1006/rss.xml' },
      { id: 'france24',  name: 'France 24',   color: '#00558C', url: 'https://www.france24.com/en/rss' },
      { id: 'dwnews',    name: 'DW News',     color: '#002B55', url: 'https://rss.dw.com/rdf/rss-en-bus' },
      { id: 'dwnews',    name: 'DW News',     color: '#002B55', url: 'https://rss.dw.com/rdf/rss-en-eu' },
      { id: 'dwnews',    name: 'DW News',     color: '#002B55', url: 'https://rss.dw.com/xml/rss_en_science' },
    ]
  }
};

var regionArg = 'bd';
process.argv.forEach(function(arg, i) {
  if (arg === '--region' && process.argv[i+1]) regionArg = process.argv[i+1];
});
if (!REGIONS[regionArg]) { console.error('Unknown region:', regionArg); process.exit(1); }
var REGION = REGIONS[regionArg];
var SOURCES = REGION.sources;

var UNIQUE_SOURCES = [];
var seenIds = {};
SOURCES.forEach(function(s) {
  if (!seenIds[s.id]) { seenIds[s.id] = true; UNIQUE_SOURCES.push({ id: s.id, name: s.name, color: s.color }); }
});

var THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Guardrails for feed fetching. Every fetch this script makes is bounded by
// all three: who it may talk to, how long it may wait, and how much it will
// read before giving up.
var MAX_FEED_BYTES  = 8 * 1024 * 1024;
var MAX_HEAD_BYTES  = 8 * 1024;          // og:image lives in <head>; the body is waste
var FEED_TIMEOUT_MS = 15000;
var HEAD_TIMEOUT_MS = 10000;
var FEED_CONCURRENCY = 4;

// Derived from the feed list above: the set of URLs this script may fetch and
// the domains it may follow a link to. Built once, consulted on every request.
var POLICY = security.buildEgressPolicy(REGIONS);

// How many previously-failed translations to retry per run. Sized against the
// run cadence in .github/workflows/fetch-feeds.yml: at twice a day this keeps
// the backlog draining at roughly 400 articles a day.
var RETRY_PER_RUN = 200;

// Turning translate: true on for a region that already holds a month of
// articles queues the whole backlog in one go — Australia and Global carry
// roughly 1,700 and 1,300. Drain it newest-first over successive runs so no
// single run carries hours of API calls, and the articles readers see first
// are translated first.
var BACKFILL_PER_RUN = 300;

// Per feed URL. The runs are 12 hours apart and the busiest single-URL feeds
// (Prothom Alo, Al Jazeera all.xml) publish 30+ items in that window, so a cap
// of 30 would silently drop articles between runs.
var MAX_ITEMS_PER_FEED = 100;

// Topic matching, in three parts because one wrapped alternation can't serve
// all three. The previous single /\b(econom|politic|...)\b/i put a word
// boundary AFTER the alternation, so every prefix term in it — 105 of 120 —
// could never match: "econom" requires a boundary before the "y" of economy.
//
// Prefixes match any continuation: econom -> economy/economic/economics.
var TOPIC_PREFIX_RE = /\b(?:econom|business|financ|fiscal|inflation|recession|trade|tariff|market|stock|sharehold|invest|bank|budget|taxation|taxpayer|revenue|deficit|surplus|export|import|manufactur|industr|commodit|oil price|mining|agricultur|startup|merger|acquisit|regulat|subsid|currenc|forex|bankrupt|layoff|unemploy|wage|profit|earning|airline|tech giant|politic|elect|parliament|congress|senat|president|prime minister|governor|diplomac|sanction|legislat|lawmak|lawsuit|polic|reform|coalition|opposit|referendum|geopolit|summit|treaty|ceasefire|conflict|militar|weapon|nuclear|missile|invasion|occupied|siege|airstrike|warfare|wartime|scienc|research|discover|climate|environment|carbon|emission|renewable|energy|artificial intelligen|quantum|biotech|pharma|vaccin|genome|neurosci|physicist|astrono|biodiversit|sustainab|pandem|epidemic)/i;

// Whole words only: as prefixes these would catch taxi, billion, lawn, warden,
// spacious, shared, studio, bondage.
var TOPIC_WORD_RE = /\b(?:tax|taxes|bill|bills|law|laws|war|wars|job|jobs|study|studies|studied|space|shares|crude|debt|debts|bond|bonds|fossil|fossils|species|interest rate|interest rates|central bank|world bank)\b/i;

// Case-sensitive, or /i would match the ordinary words "un", "eu", "ai", "who".
var TOPIC_ACRONYM_RE = /\b(?:GDP|IPO|NATO|ASEAN|WHO|IMF|WTO|G7|G20|NASA|CRISPR|UN|EU|AI)\b/;

// Publishers put the section in the article path: en.prothomalo.com/entertainment/...
function sectionOf(link) {
  var m = String(link || '').match(/^https?:\/\/[^/]+\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// What each source publishes in, for articles whose own title is too short for
// detection to have an opinion.
var SOURCE_LANG = {};
SOURCES.forEach(function(s) { if (s.lang) SOURCE_LANG[s.id] = s.lang; });

var EXCLUDED_SECTIONS = {};
SOURCES.forEach(function(s) {
  if (s.excludeSections) {
    EXCLUDED_SECTIONS[s.id] = (EXCLUDED_SECTIONS[s.id] || []).concat(s.excludeSections);
  }
});

function inExcludedSection(article) {
  var excluded = EXCLUDED_SECTIONS[article.sourceId];
  return !!excluded && excluded.indexOf(sectionOf(article.link)) !== -1;
}

function matchesTopic(article) {
  var text = (article.title || '') + ' ' + (article.desc || '');
  return TOPIC_PREFIX_RE.test(text) || TOPIC_WORD_RE.test(text) || TOPIC_ACRONYM_RE.test(text);
}

function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  var t = Date.parse(str);
  if (!isNaN(t)) return t;
  str = str.replace(/\s*\([^)]+\)\s*$/, '');
  t = Date.parse(str);
  if (!isNaN(t)) return t;
  str = str.replace(/\bGMT\b/, '+0000').replace(/\bUTC\b/, '+0000')
           .replace(/\bBST\b/, '+0600').replace(/\bIST\b/, '+0530');
  t = Date.parse(str);
  if (!isNaN(t)) return t;
  return null;
}

function isRecent(pubDate) {
  var t = parseDate(pubDate);
  if (!t) return true;
  return (Date.now() - t) < THIRTY_DAYS_MS;
}

function resolveLocation(loc, from) {
  try { return new URL(String(loc), from).href; } catch (e) { return ''; }
}

// The one place this script opens a socket.
//
// https only, no embedded credentials, no address literals, no private names —
// that is parseSafeUrl's job and it runs on the first URL and on every redirect
// target, so a 302 cannot walk the runner onto a network the first check would
// have refused. Redirects are off unless the caller passes allowRedirect, and
// even then each hop has to satisfy it: publishers do move feeds, but only
// ever to themselves.
//
// opts: { allowRedirect, maxBytes, timeoutMs, maxRedirects }
function fetchUrl(reqUrl, opts, redirects) {
  opts = opts || {};
  var allowRedirect = opts.allowRedirect || null;
  var maxBytes  = opts.maxBytes  || MAX_FEED_BYTES;
  var timeoutMs = opts.timeoutMs || FEED_TIMEOUT_MS;
  var maxHops   = opts.maxRedirects == null ? 3 : opts.maxRedirects;
  redirects = redirects || 0;

  return new Promise(function(resolve, reject) {
    if (redirects > maxHops) return reject(new Error('Too many redirects'));
    var safe = security.parseSafeUrl(reqUrl);
    if (!safe) return reject(new Error('Refused by egress policy: ' + String(reqUrl).slice(0, 120)));

    var req = https.get(safe.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,*/*',
      },
      timeout: timeoutMs
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!allowRedirect) return reject(new Error('Redirect refused (HTTP ' + res.statusCode + ')'));
        var next = resolveLocation(res.headers.location, safe.href);
        if (!allowRedirect(next)) {
          return reject(new Error('Redirect refused by egress policy: ' + String(next).slice(0, 120)));
        }
        return fetchUrl(next, opts, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      var data = ''; res.setEncoding('utf8');
      res.on('data', function(c) {
        data += c;
        if (data.length > maxBytes) { req.destroy(); reject(new Error('Response larger than ' + maxBytes + ' bytes')); }
      });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
  });
}

// A configured feed: the URL has to be one of the exact strings in the source
// list, and a redirect may only land on a domain that list already covers.
function fetchFeedUrl(reqUrl) {
  if (!security.isAllowedFeedUrl(reqUrl, POLICY)) {
    return Promise.reject(new Error('Not a configured feed URL: ' + String(reqUrl).slice(0, 120)));
  }
  return fetchUrl(reqUrl, {
    allowRedirect: function(u) { return security.isAllowedArticleUrl(u, POLICY); },
    maxBytes: MAX_FEED_BYTES,
    timeoutMs: FEED_TIMEOUT_MS
  });
}

function isTransientHttp(err) {
  var m = String((err && err.message) || '');
  return /Timeout|HTTP (?:408|429|5\d\d)|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(m);
}

// One retry, because a lone 503 or dropped socket used to lose a source for
// the entire run. Permanent answers (403, 404) are not worth retrying.
async function fetchFeedWithRetry(reqUrl) {
  try {
    return await fetchFeedUrl(reqUrl);
  } catch (e) {
    if (!isTransientHttp(e)) throw e;
    await new Promise(function(r) { setTimeout(r, 1500); });
    return fetchFeedUrl(reqUrl);
  }
}

// Fetching an article page to read its og:image is the one request whose
// target comes out of feed content rather than the source list, so it is the
// tightest: the caller has already matched the host against the policy, and a
// redirect is refused outright rather than re-checked. A publisher that wants
// to move an article can serve the tag at the URL it published.
//
// Never rejects — a missing picture is not a failed run.
function fetchHead(reqUrl) {
  return fetchUrl(reqUrl, {
    allowRedirect: null,
    maxBytes: MAX_HEAD_BYTES,
    timeoutMs: HEAD_TIMEOUT_MS
  }).catch(function() { return ''; });
}

function extractOgImage(html) {
  var m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
       || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1] : null;
}

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');   // last, so &amp;lt; unwraps one layer per pass
}

// Feeds escape their markup to varying depths: some send raw HTML, some send
// it entity-encoded, some do both. Decoding before stripping (and repeating)
// is what keeps <p>, <br> and href URLs out of the copy — decoding after a
// single strip, as this used to, turns &lt;p&gt; back into a live tag.
function stripTags(html) {
  var s = String(html || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (var i = 0; i < 3; i++) {
    var next = decodeEntities(s).replace(/<[^>]*>/g, ' ')
      .replace(/<[^>]*$/, ' ');   // descriptions get truncated mid-tag
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim();
}

function extractImg(block) {
  var ps = [/url="([^"]+\.(?:jpg|jpeg|png|webp|gif))/i, /<media:thumbnail[^>]+url="([^"]+)"/i, /<img[^>]+src="([^"]+)"/i];
  for (var i=0;i<ps.length;i++){var m=block.match(ps[i]);if(m)return m[1];}
  return null;
}

function getTag(block, tag) {
  var m = block.match(new RegExp('<'+tag+'[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</'+tag+'>', 'i'))
       || block.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>', 'i'));
  return m ? m[1].trim() : '';
}

// Two different questions, deliberately separated.
//
// A card is a link, so its href has to be a plain https URL on a public host —
// that is the check a javascript: or data: URL in a feed runs into, and an
// item that fails it is not a card and gets dropped. Whether the link is on a
// domain we *fetch* is a stricter question, asked separately in enrichImages:
// publishers do syndicate to each other, and a link we will show is not
// automatically a link we will open.
//
// The picture is optional, so a host outside the image allowlist costs the art
// and nothing else.
var droppedLinks = 0;
var droppedImageHosts = Object.create(null);

function sanitizeLink(raw) {
  var u = security.parseSafeUrl(raw);
  if (!u) { if (raw) droppedLinks++; return ''; }
  return u.href;
}

function sanitizeImage(raw, base) {
  if (!raw) return null;
  var abs = resolveLocation(raw, base);
  if (security.isAllowedImageUrl(abs, POLICY)) return abs;
  var host;
  try { host = new URL(abs).hostname; } catch (e) { host = '(unparseable)'; }
  droppedImageHosts[host] = (droppedImageHosts[host] || 0) + 1;
  return null;
}

function parseRSS(xml, source) {
  var items=[], re=/<item[^>]*>([\s\S]*?)<\/item>/gi, m;
  while((m=re.exec(xml))!==null && items.length<MAX_ITEMS_PER_FEED) {
    var b=m[1], title=stripTags(getTag(b,'title'));
    if(!title) continue;
    var link = sanitizeLink(getTag(b,'link')||getTag(b,'guid')||'');
    if(!link) continue;
    items.push({ title, link, desc: stripTags(getTag(b,'description')).slice(0,200), pubDate: getTag(b,'pubDate')||getTag(b,'dc:date')||'', img: sanitizeImage(extractImg(b), link), lang: lang.articleLang({ title: title }, source.lang), sourceId: source.id, sourceName: source.name, sourceColor: source.color });
  }
  return items;
}

function parseAtom(xml, source) {
  var items=[], re=/<entry[^>]*>([\s\S]*?)<\/entry>/gi, m;
  while((m=re.exec(xml))!==null && items.length<MAX_ITEMS_PER_FEED) {
    var b=m[1], title=stripTags(getTag(b,'title'));
    if(!title) continue;
    var lm=b.match(/<link[^>]+href="([^"]+)"/i)||b.match(/<link[^>]*>([^<]+)<\/link>/i);
    var link = sanitizeLink(lm?lm[1].trim():'');
    if(!link) continue;
    items.push({ title, link, desc: stripTags(getTag(b,'summary')||getTag(b,'content')).slice(0,200), pubDate: getTag(b,'published')||getTag(b,'updated')||'', img: sanitizeImage(extractImg(b), link), lang: lang.articleLang({ title: title }, source.lang), sourceId: source.id, sourceName: source.name, sourceColor: source.color });
  }
  return items;
}

function parseFeed(xml, source) {
  var a = parseRSS(xml, source);
  return a.length ? a : parseAtom(xml, source);
}

async function enrichImages(articles) {
  var candidates = articles.filter(function(a) { return !a.img && a.link; });
  var missing = candidates.filter(function(a) { return security.isAllowedArticleUrl(a.link, POLICY); });
  var offPolicy = candidates.length - missing.length;
  console.log('Fetching og:image for', missing.length, 'articles'
    + (offPolicy ? ' (' + offPolicy + ' skipped: link outside the allowed domains)' : '') + '...');

  var rejectedHosts = Object.create(null);
  var BATCH = 5;
  for (var i=0; i<missing.length; i+=BATCH) {
    await Promise.all(missing.slice(i,i+BATCH).map(async function(a) {
      var html = await fetchHead(a.link);
      var img = extractOgImage(html);
      if (!img) return;
      var abs = resolveLocation(img, a.link);
      if (security.isAllowedImageUrl(abs, POLICY)) { a.img = abs; return; }
      try { rejectedHosts[new URL(abs).hostname] = (rejectedHosts[new URL(abs).hostname] || 0) + 1; }
      catch (e) { rejectedHosts['(unparseable)'] = (rejectedHosts['(unparseable)'] || 0) + 1; }
    }));
  }
  reportRejectedImageHosts(rejectedHosts, 'og:image');
}

// Naming the host is the whole point: a publisher moving to a new CDN shows up
// here as one line, and the fix is one entry in IMAGE_DOMAINS.
function reportRejectedImageHosts(hosts, label) {
  var names = Object.keys(hosts);
  if (!names.length) return;
  console.warn('Dropped ' + label + ' from ' + names.length + ' host(s) not in the image allowlist'
    + ' — cards fall back to the placeholder. Add to IMAGE_DOMAINS in lib/security.js if these are wanted:');
  names.sort(function(a,b){ return hosts[b]-hosts[a]; })
       .forEach(function(h) { console.warn('  -', h, '(' + hosts[h] + ')'); });
}

function claudeComplete(systemPrompt, userPrompt, maxTokens) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, function(res) {
      var data = ''; res.setEncoding('utf8');
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) {
          return reject(new Error('Claude API error (' + res.statusCode + '): ' + data.slice(0, 300)));
        }
        try {
          var json = JSON.parse(data);
          if (json.type === 'error') {
            return reject(new Error('Claude API: ' + (json.error && json.error.message || data.slice(0, 300))));
          }
          if (!json.content || !json.content[0] || !json.content[0].text) {
            return reject(new Error('Claude API returned empty content'));
          }
          resolve(json.content[0].text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Claude API timeout')); });
    req.write(body);
    req.end();
  });
}

// Set when the API itself can't serve us — exhausted credit, a bad key, rate
// limits, server faults, timeouts. None of those are the article's fault, so
// they must never be recorded against it as a permanent failure, and there is
// no point firing hundreds more requests once one of them comes back.
var apiUnavailable = false;

function isApiUnavailable(err) {
  var m = String((err && err.message) || '');
  if (/credit balance|rate limit|overloaded|Internal server error/i.test(m)) return true;
  if (/Claude API error \((?:401|403|408|429|5\d\d)\)/.test(m)) return true;
  if (/timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(m)) return true;
  return false;
}

// How many stories the briefing covers. Three is the floor below which it is
// not a briefing; five is what fits in the minute a reader actually gives it.
var BRIEFING_STORIES = 5;

// How many ranked stories get a "why this matters" line. The page shows the
// top of the feed first and most readers never reach the end of it, so the
// line is bought for the part of the feed that is read, in one call rather
// than one per story.
var WHY_STORIES = 12;

// What the model is shown about a story: the lead headline, and the other
// publishers' headlines as corroboration. Their disagreements are the useful
// part — the same event described three ways is more information than one
// description repeated.
function storyBrief(story, index) {
  var lines = story.members.slice(0, 4).map(function (m) {
    var title = m.lang === 'bn' && typeof m.titleEn === 'string' && m.titleEn ? m.titleEn : m.title;
    return '   - ' + m.sourceName + ': ' + title;
  });
  return '[' + (index + 1) + '] id=' + story.id + ' (' + story.sourceIds.length + ' source'
    + (story.sourceIds.length === 1 ? '' : 's') + ', topic: ' + story.topic + ')\n' + lines.join('\n');
}

function parseJsonBlock(raw) {
  var clean = String(raw).replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  var startObj = clean.indexOf('{'), startArr = clean.indexOf('[');
  var start = startArr !== -1 && (startObj === -1 || startArr < startObj) ? startArr : startObj;
  var end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON found in response');
  return JSON.parse(clean.slice(start, end + 1));
}

// The briefing. Not a summary of the feed — an editor's account of the few
// things that happened, each one answering the three questions a reader has:
// what happened, why it matters, and what to watch next.
//
// The model is given ranked, deduplicated stories rather than a list of
// headlines, which is the whole reason this can be written at all: asked to
// summarise forty headlines it produced forty headlines' worth of throat
// clearing, because it had no way to know which five mattered.
async function generateBriefing(stories) {
  if (!ANTHROPIC_API_KEY || apiUnavailable) return null;
  var top = stories.slice(0, BRIEFING_STORIES);
  if (top.length < security.BRIEFING_MIN_ITEMS) {
    console.log('Only', top.length, 'ranked stories — not enough for a briefing');
    return null;
  }
  console.log('Writing the briefing for', REGION.label, 'over', top.length, 'stories...');
  try {
    var raw = await claudeComplete(
      REGION.summaryPrompt
      + ' You write the morning briefing an analyst reads before anything else.'
      + ' Respond ONLY with valid JSON, no markdown, no preamble.',
      'These are today\'s most significant stories from ' + REGION.label + ' news sources, already ranked'
      + ' and deduplicated. Each one lists how the publishers covering it described it.\n\n'
      + top.map(storyBrief).join('\n\n') + '\n\n'
      + 'Return a JSON array of exactly ' + top.length + ' objects, one per story, in the order given:\n'
      + '[{"id": "the id given above", '
      + '"headline": "a short factual headline, under 12 words", '
      + '"what": "1-2 sentences on what actually happened", '
      + '"why": "one sentence on why it matters — the concrete consequence, for whom", '
      + '"watch": "one sentence on what to watch next, or an empty string if there is no clear next step"}]\n\n'
      + 'Write only what the headlines support. Where they disagree, say so. Do not speculate beyond them,'
      + ' do not repeat the headline back as the "what", and do not use markdown.',
      2000
    );
    var parsed = parseJsonBlock(raw);
    // The model reads headlines written by other people, so its answer is
    // untrusted input like any other. A briefing that is not the declared
    // shape is a failed call, and the previous one stays on the page.
    var valid = security.validateBriefing(parsed);
    if (!valid) {
      console.error('Briefing rejected by validation (' + String(raw).length + ' chars)');
      return null;
    }
    // An id the model echoed correctly links the item to its story; one it
    // invented or dropped is filled in by position, which is the order the
    // stories were given in.
    var allowed = {};
    top.forEach(function (st) { allowed[st.id] = true; });
    valid.forEach(function (item, i) {
      if (!item.id || !allowed[item.id]) item.id = top[i] ? top[i].id : '';
    });
    return valid;
  } catch (e) {
    console.error('Briefing failed:', e.message);
    if (isApiUnavailable(e)) apiUnavailable = true;
    return null;
  }
}

// One sentence per story on the consequence, for the top of the feed. Asked
// for in a single call keyed by story id, so a story that already has a line
// from a previous run is never paid for twice.
async function generateWhyLines(stories) {
  if (!ANTHROPIC_API_KEY || apiUnavailable || !stories.length) return null;
  console.log('Writing "why this matters" for', stories.length, 'stories...');
  try {
    var raw = await claudeComplete(
      REGION.summaryPrompt
      + ' You explain consequences in one sentence. Respond ONLY with valid JSON, no markdown.',
      'For each story below, write one sentence on why it matters — the concrete consequence and for whom.'
      + ' Be specific ("this raises borrowing costs for exporters"), never generic ("this is an important'
      + ' development"). Write only what the headlines support.\n\n'
      + stories.map(storyBrief).join('\n\n') + '\n\n'
      + 'Return a JSON object mapping each story id to its sentence: {"' + stories[0].id + '": "...", ...}.'
      + ' Omit any story you cannot say something specific about.',
      2000
    );
    var valid = security.validateWhyMap(parseJsonBlock(raw), stories.map(function (s) { return s.id; }));
    if (!valid) console.error('"Why this matters" rejected by validation');
    return valid;
  } catch (e) {
    console.error('"Why this matters" failed:', e.message);
    if (isApiUnavailable(e)) apiUnavailable = true;
    return null;
  }
}

// Bangla for the briefing, translated rather than generated a second time so
// the two languages always describe the same stories in the same order.
async function translateBriefing(items) {
  if (!ANTHROPIC_API_KEY || apiUnavailable || !items || !items.length) return null;
  console.log('Translating the briefing to Bangla...');
  try {
    var raw = await claudeComplete(
      'You are a Bengali (Bangla) translator. Translate each field of the given news briefing into natural'
      + ' Bengali, preserving the JSON structure exactly. Respond ONLY with the translated JSON array,'
      + ' no markdown, no preamble.',
      JSON.stringify(items.map(function (it) {
        return { id: it.id, headline: it.headline, what: it.what, why: it.why, watch: it.watch };
      })),
      3000
    );
    var valid = security.validateBriefing(parseJsonBlock(raw));
    if (!valid || valid.length !== items.length) {
      console.error('Briefing translation rejected by validation');
      return null;
    }
    // Positional, not by id: the translation's job is the same items in the
    // same order, and trusting an id the translator may have rewritten would
    // let a mismatched pair through.
    valid.forEach(function (it, i) { it.id = items[i].id; });
    return valid;
  } catch (e) {
    console.error('Briefing translation failed:', e.message);
    if (isApiUnavailable(e)) apiUnavailable = true;
    return null;
  }
}

async function translateWhyLines(whyMap) {
  var ids = Object.keys(whyMap || {});
  if (!ANTHROPIC_API_KEY || apiUnavailable || !ids.length) return null;
  console.log('Translating', ids.length, '"why this matters" lines to Bangla...');
  try {
    var raw = await claudeComplete(
      'You are a Bengali (Bangla) translator. Translate each value of the given JSON object into natural'
      + ' Bengali, keeping every key exactly as given. Respond ONLY with the JSON object, no markdown.',
      JSON.stringify(whyMap),
      2000
    );
    var valid = security.validateWhyMap(parseJsonBlock(raw), ids);
    if (!valid) console.error('"Why this matters" translation rejected by validation');
    return valid;
  } catch (e) {
    console.error('"Why this matters" translation failed:', e.message);
    if (isApiUnavailable(e)) apiUnavailable = true;
    return null;
  }
}

// The plain-prose briefing the page fell back on before this one existed, and
// still falls back on: a reader on a cached copy of app.js, and anything
// consuming the data file for its `summary` field, gets the same account in
// the shape it expects. Built from the briefing already written rather than
// bought separately.
function summaryFromBriefing(items) {
  if (!items || !items.length) return null;
  return security.validateSummary(items.map(function (it) { return it.what; }).join(' '));
}

// Each article carries its own text in `title`/`desc` and the other language
// in `titleBn`/`descBn` or `titleEn`/`descEn` — whichever direction it needs.
// Never both, so nothing is stored twice and there is no question of which
// copy is authoritative.
var PROMPTS = {
  bn: {
    system: 'You are a Bengali (Bangla) translator. Translate the given English news text to Bengali. '
          + 'Respond ONLY with valid JSON, no markdown, no explanation.',
    title: 'Bengali translation of the title',
    desc:  'Bengali translation of the description (or empty string if no description)'
  },
  en: {
    system: 'You are a Bengali (Bangla) to English translator. Translate the given Bengali news text to natural English. '
          + 'Respond ONLY with valid JSON, no markdown, no explanation.',
    title: 'English translation of the title',
    desc:  'English translation of the description (or empty string if no description)'
  }
};

async function translateArticles(articles) {
  if (!ANTHROPIC_API_KEY || !articles.length) return;
  var intoBangla = articles.filter(function(a) { return lang.targetLang(a) === 'bn'; }).length;
  console.log('Translating', articles.length, 'articles (' + intoBangla + ' into Bangla, '
              + (articles.length - intoBangla) + ' into English)...');
  var BATCH = 5;
  for (var i=0; i<articles.length; i+=BATCH) {
    await Promise.all(articles.slice(i,i+BATCH).map(async function(a) {
      var want = lang.targetLang(a);
      var titleKey = lang.translatedField(a, 'title');
      var descKey  = lang.translatedField(a, 'desc');
      var prompt = PROMPTS[want];
      try {
        var result = await claudeComplete(
          prompt.system,
          'Title: '+a.title+'\nDescription: '+(a.desc||'')+'\n\n'
          + 'Return a JSON object with exactly these fields:\n'
          + '{"title": "' + prompt.title + '", '
          + '"desc": "' + prompt.desc + '"}'
        );
        var clean = result.replace(/^```[a-z]*\n?/i,'').replace(/```$/,'').trim();
        var start = clean.indexOf('{');
        var end   = clean.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object found in response');
        // Shape and content are both checked: the right keys, strings, within
        // length, no markup. Anything else is an unusable answer, which is
        // already a case this loop knows how to handle.
        var valid = security.validateTranslation(JSON.parse(clean.slice(start, end + 1)));
        if (!valid) throw new Error('Translation failed validation');
        a[titleKey] = valid.title;
        a[descKey]  = valid.desc;
      } catch(e) {
        console.error('  Translation into ' + want + ' failed for "' + a.title.slice(0,40) + '":', e.message);
        if (isApiUnavailable(e)) {
          apiUnavailable = true;   // leave the article untouched so it retries
        } else {
          a[titleKey] = false;     // the model answered, just not usably
          a[descKey]  = false;
        }
      }
    }));
    if (apiUnavailable) {
      console.error('  Anthropic API unavailable — stopping translation for this run; the remaining articles stay queued');
      break;
    }
    if (i+BATCH < articles.length) await new Promise(function(r){ setTimeout(r,500); });
  }
}

async function main() {
  console.log('Running fetch for region:', REGION.label, '(' + regionArg + ')');

  // A source URL the policy can't accept — cleartext, a port, credentials, an
  // address literal — would otherwise be quietly skipped on every run. Stop
  // before fetching anything: the data file on disk is still good, and a
  // half-built policy must never be the thing that publishes.
  if (POLICY.invalid.length) {
    throw new Error('Refusing to run: ' + POLICY.invalid.length + ' configured feed URL(s) rejected by the egress policy:\n  '
      + POLICY.invalid.join('\n  '));
  }
  console.log('Egress policy:', POLICY.feedUrls.size, 'feed URLs,',
              POLICY.linkDomains.size, 'link domains,', POLICY.imageDomains.size, 'image domains');
  if (!ANTHROPIC_API_KEY) console.warn('Warning: ANTHROPIC_API_KEY not set — AI summary and Bangla translations will be skipped');

  var dataFile = REGION.dataFile;

  // ── Load existing data ──
  var existingArticles = [];
  var existingByLink = {};
  var loadFile = fs.existsSync(dataFile) ? dataFile : null;
  if (loadFile) {
    try {
      var existing = JSON.parse(fs.readFileSync(loadFile,'utf8'));
      if (loadFile !== dataFile) console.log('Migrated existing articles from', loadFile);
      var beforePrune = (existing.articles || []).length;
      existingArticles = (existing.articles || [])
        .filter(function(a) { return isRecent(a.pubDate); })
        .filter(function(a) { return !inExcludedSection(a); })
        // Applied to stored articles too, so turning the filter on (or editing
        // the keywords) takes effect next run instead of over 30 days.
        .filter(function(a) { return !REGION.topicFilter || matchesTopic(a); })
        // Same for the link and image rules. A month of articles was written
        // before they existed, and the page renders the file rather than the
        // feed, so anything the rules would refuse today is refused now
        // instead of ageing out over the next thirty days.
        .filter(function(a) { a.link = sanitizeLink(a.link); return !!a.link; })
        .map(function(a) { a.img = sanitizeImage(a.img, a.link); return a; });
      var pruned = beforePrune - existingArticles.length;
      var restamped = 0;
      existingArticles.forEach(function(a) {
        // Articles stored before the pipeline knew about direction have no
        // `lang`. Work it out from the text now, so a Bangla article stops
        // being treated as English needing a Bangla translation.
        var was = a.lang;
        a.lang = lang.articleLang(a, SOURCE_LANG[a.sourceId]);
        if (was !== a.lang) restamped++;
        if (a.lang === 'bn') {
          // These hold a "translation" of Bangla into Bangla: the model was
          // asked to render Bangla text in Bangla and correctly returned it
          // unchanged. The article's own text is already in `title`, so this
          // is a duplicate, and clearing it is what queues the English
          // translation that was never made.
          delete a.titleBn;
          delete a.descBn;
        }
        if (REGION.translate) {
          var titleKey = lang.translatedField(a, 'title');
          var descKey  = lang.translatedField(a, 'desc');
          if (a[titleKey] === null) a[titleKey] = false;
          if (a[descKey]  === null) a[descKey]  = false;
        }
        existingByLink[a.link] = true;
      });
      console.log('Loaded', existingArticles.length, 'existing articles (' + pruned + ' pruned: stale, excluded section, or off-topic)');
      if (restamped) console.log('  Re-stamped the language of', restamped, 'stored article(s)');
    } catch(e) { console.warn('Could not read existing ' + loadFile + ':', e.message); }
  }

  // ── Fetch fresh articles from feeds ──
  // Fetched in parallel, but parsed and deduped in source order so a run's
  // output doesn't depend on which feed happened to answer first.
  var fetched = new Array(SOURCES.length);
  var nextSource = 0;
  await Promise.all(Array.from({ length: Math.min(FEED_CONCURRENCY, SOURCES.length) }, async function () {
    while (nextSource < SOURCES.length) {
      var idx = nextSource++;
      var source = SOURCES[idx];
      try {
        fetched[idx] = { source: source, xml: await fetchFeedWithRetry(source.url) };
      } catch (e) {
        fetched[idx] = { source: source, error: e.message };
      }
    }
  }));

  var freshArticles = [], seenLinks = Object.assign({}, existingByLink), failedSources = [];
  fetched.forEach(function (result) {
    var source = result.source;
    if (result.error) {
      console.error('Failed:', source.name, '-', source.url, '-', result.error);
      failedSources.push(source.name + ' (' + result.error + ')');
      return;
    }
    var parsed = parseFeed(result.xml, source)
      .filter(function(a){ return isRecent(a.pubDate); })
      .filter(function(a){ return !inExcludedSection(a); })
      .filter(function(a){
        if (seenLinks[a.link]) return false;
        seenLinks[a.link] = true;
        return true;
      });
    var articles = REGION.topicFilter ? parsed.filter(matchesTopic) : parsed;
    var filtered = parsed.length - articles.length;
    console.log('Fetched:', source.name, '-', articles.length, 'new articles' + (filtered ? ' (' + filtered + ' off-topic filtered)' : ''));
    freshArticles = freshArticles.concat(articles);
  });

  await enrichImages(freshArticles);

  if (REGION.translate) {
    // Which field is missing depends on which way the article needs to go, so
    // "needs translation" is asked per article rather than by one fixed key.
    var backlog = existingArticles
      .filter(function(a) { return a[lang.translatedField(a, 'title')] === undefined; })
      .sort(function(a,b){ return (parseDate(b.pubDate)||0)-(parseDate(a.pubDate)||0); });
    var needsTranslation = backlog.slice(0, BACKFILL_PER_RUN);
    // Previously-failed articles used to be skipped forever, so a single API
    // outage stranded every article it touched. Drain them a batch per run.
    var failedTranslation = existingArticles.filter(function(a) { return a[lang.translatedField(a, 'title')] === false; });
    var retrying = failedTranslation.slice(0, RETRY_PER_RUN);
    console.log(freshArticles.length, 'new articles,', backlog.length, 'existing need translation',
                '(' + needsTranslation.length + ' this run),',
                failedTranslation.length, 'previously failed (' + retrying.length + ' retried this run)');
    await translateArticles(freshArticles.concat(needsTranslation, retrying));
  } else {
    console.log(freshArticles.length, 'new articles (translation disabled for', REGION.label, ')');
  }

  // ── Merge: new articles + existing ──
  var allArticles = freshArticles.concat(existingArticles);
  allArticles.sort(function(a,b){ return (parseDate(b.pubDate)||0)-(parseDate(a.pubDate)||0); });

  // ── Group the articles into stories ──
  //
  // Five publishers covering one cabinet decision is one story. Clustering
  // runs over the whole retained month rather than just this run's arrivals,
  // because a story that broke yesterday and is still being covered today has
  // members on both sides of that line.
  var now = Date.now();
  var clusters = cluster.clusterArticles(allArticles, { parseDate: parseDate });
  var ranked = rank.rankStories(clusters, now, parseDate);
  var multiSource = ranked.filter(function (st) { return st.sourceIds.length > 1; });
  console.log('Clustered', allArticles.length, 'articles into', ranked.length, 'stories ('
    + multiSource.length + ' carried by more than one source)');

  // Every article learns which story it belongs to and what that story scored,
  // so the page can order the feed by importance and show one card per story
  // instead of five. `lead` is the story's freshest telling — the one the card
  // links to.
  ranked.forEach(function (st) {
    st.members.forEach(function (m) {
      m.clusterId = st.id;
      m.score = Math.round(st.score * 1000) / 1000;
      m.topic = st.topic;
    });
  });

  // Which stories get a record of their own in the data file. Writing one for
  // all ~1,300 clusters would be a third of the file spent restating what the
  // articles already carry; the page only needs a record where it has
  // something extra to show — the members to collapse into one card, or a
  // "why this matters" line, which is bought for the top of the feed.
  //
  // The test is members, not sources: four Sydney Morning Herald pieces on one
  // shooting are four cards the page should show as one, and they are not
  // corroboration. Only the second test decides what the card says about
  // sources; this one decides whether the story is collapsible at all.
  var storyCap = Math.max(WHY_STORIES, BRIEFING_STORIES);
  var published = ranked.filter(function (st, i) { return st.members.length > 1 || i < storyCap; });

  // ── Briefing and "why this matters" ──
  var stored = {};
  try { stored = JSON.parse(fs.readFileSync(dataFile, 'utf8')) || {}; } catch (e) {}
  var storedBriefing   = Array.isArray(stored.briefing)   ? stored.briefing   : null;
  var storedBriefingBn = Array.isArray(stored.briefingBn) ? stored.briefingBn : null;

  // A story's "why this matters" is bought once and kept for as long as the
  // story is unchanged. A new publisher joining the story is a change: the
  // line was written against a smaller set of headlines and may no longer be
  // what the story is about.
  var storedWhy = Object.create(null), storedWhyBn = Object.create(null), storedSize = Object.create(null);
  (Array.isArray(stored.stories) ? stored.stories : []).forEach(function (st) {
    if (!st || !st.id) return;
    if (st.why)   storedWhy[st.id]   = st.why;
    if (st.whyBn) storedWhyBn[st.id] = st.whyBn;
    storedSize[st.id] = st.size || 0;
  });

  var briefing = storedBriefing, briefingBn = storedBriefingBn;
  if (freshArticles.length > 0 || !storedBriefing) {
    var generated = await generateBriefing(ranked);
    // A failed call must not wipe a good briefing off the page.
    if (generated) {
      briefing = generated;
      briefingBn = null;            // the stored translation describes the old one
    } else if (storedBriefing) {
      console.log('Briefing generation failed — keeping the previous one');
    }
  } else {
    console.log('No new articles — reusing the existing briefing');
  }

  // Retried every run until it lands, like the article translations.
  if (REGION.translate && briefing && !briefingBn) {
    briefingBn = await translateBriefing(briefing);
  }

  var whyCandidates = ranked.slice(0, WHY_STORIES);
  var whyNeeded = whyCandidates.filter(function (st) {
    return !storedWhy[st.id] || storedSize[st.id] !== st.members.length;
  });
  var freshWhy = whyNeeded.length ? await generateWhyLines(whyNeeded) : null;
  var whyMap = Object.create(null), whyBnMap = Object.create(null);
  whyCandidates.forEach(function (st) {
    var reused = !freshWhy || !freshWhy[st.id];
    var line = reused ? storedWhy[st.id] : freshWhy[st.id];
    if (!line) return;
    whyMap[st.id] = line;
    // The Bangla line only carries over with the English one it translates.
    if (reused && storedWhyBn[st.id]) whyBnMap[st.id] = storedWhyBn[st.id];
  });
  // Only worth a line when something actually happened: without an API key
  // nothing is asked for and nothing is reused, and "0 stories carry a line
  // (12 asked for)" reads as a failure rather than a feature being off.
  if (freshWhy || Object.keys(whyMap).length) {
    console.log(Object.keys(whyMap).length, 'stories carry a "why this matters" line ('
      + whyNeeded.length + ' asked for this run, the rest reused)');
  }

  if (REGION.translate) {
    var untranslatedWhy = Object.create(null);
    var pending = 0;
    Object.keys(whyMap).forEach(function (id) {
      if (whyBnMap[id]) return;
      untranslatedWhy[id] = whyMap[id];
      pending++;
    });
    if (pending) {
      var translatedWhy = await translateWhyLines(untranslatedWhy);
      if (translatedWhy) Object.keys(translatedWhy).forEach(function (id) { whyBnMap[id] = translatedWhy[id]; });
    }
  }

  // ── What changed since yesterday ──
  //
  // Compared against the last snapshot from a day before this one, never
  // against this morning's run: both of a day's runs write the same file, and
  // "unchanged since three hours ago" is true of almost everything and worth
  // saying about nothing.
  var today = archive.dayOf(Date.now());
  var previousSnapshot = archive.previousSnapshot(regionArg, today);
  var changes = archive.diffStories(ranked.slice(0, archive.ARCHIVE_STORIES), previousSnapshot);
  var dropped = archive.droppedFromBriefing(briefing, previousSnapshot);
  if (changes) {
    var counts = { new: 0, developing: 0, continuing: 0 };
    Object.keys(changes.stories).forEach(function (id) { counts[changes.stories[id].status]++; });
    console.log('Against the snapshot of', changes.since + ':', counts.new, 'new,',
                counts.developing, 'developing,', counts.continuing, 'unchanged;',
                dropped.length, 'off the briefing');
  } else {
    console.log('No earlier snapshot for', REGION.label, '— nothing to compare against this run');
  }

  var stories = published.map(function (st) {
    var record = {
      id:        st.id,
      lead:      st.members[0].link,
      size:      st.members.length,
      sourceIds: st.sourceIds,
      links:     st.members.map(function (m) { return m.link; }),
      topic:     st.topic,
      score:     Math.round(st.score * 1000) / 1000,
      first:     st.members[st.members.length - 1].pubDate,
      latest:    st.members[0].pubDate
    };
    if (whyMap[st.id])   record.why   = whyMap[st.id];
    if (whyBnMap[st.id]) record.whyBn = whyBnMap[st.id];
    // Absent rather than 'continuing' when there is no baseline: a field that
    // says "unchanged" and a field that says "we cannot know" must not look
    // the same to the page.
    var change = changes && changes.stories[st.id];
    if (change) {
      record.status = change.status;
      if (change.gained) record.gained = change.gained;
    }
    return record;
  });

  var output = {
    fetchedAt:  new Date().toISOString(),
    // Kept, and still the plain-prose account of the day: a browser holding a
    // cached app.js from before the briefing existed reads this field, and so
    // does anything else consuming the file. Derived from the briefing rather
    // than bought separately.
    summary:    summaryFromBriefing(briefing) || stored.summary || null,
    summaryBn:  summaryFromBriefing(briefingBn) || null,
    briefing:   briefing || null,
    briefingBn: briefingBn || null,
    sources:    UNIQUE_SOURCES,
    // What the "since yesterday" markers are measured against, named rather
    // than implied: a reader told a story is new deserves to know new since
    // when, and a stale archive would otherwise silently compare against last
    // week while the page said "yesterday".
    changedSince: changes ? changes.since : null,
    dropped:      dropped,
    stories:    stories,
    articles:   allArticles
  };

  fs.writeFileSync(dataFile, JSON.stringify(output, null, 2));

  // ── The snapshot ──
  //
  // Written after the data file, and only with a briefing in hand: a snapshot
  // whose briefing is null is a baseline that makes tomorrow's "what changed"
  // compare against nothing, which is worse than having no snapshot for the
  // day at all.
  if (briefing) {
    archive.writeSnapshot(archive.buildSnapshot({
      day: today, region: regionArg, fetchedAt: output.fetchedAt,
      briefing: briefing, briefingBn: briefingBn, stories: ranked
    }));
    var pruned = archive.prune(regionArg);
    archive.writeIndex(Object.keys(REGIONS));
    console.log('Archived', archive.ARCHIVE_STORIES, 'stories for', today
      + (pruned.length ? ' (pruned ' + pruned.length + ' snapshot(s) past the ' + archive.ARCHIVE_DAYS + '-day window)' : ''));
  } else {
    console.log('No briefing this run — no snapshot written for', today);
  }
  console.log('Done.', dataFile, 'now has', allArticles.length, 'articles (', freshArticles.length, 'new,', existingArticles.length, 'retained) in',
              ranked.length, 'stories,', stories.length, 'of them published with a record of their own');
  if (failedSources.length) {
    console.warn('WARNING:', failedSources.length, 'of', SOURCES.length, 'feeds failed this run:');
    failedSources.forEach(function(f) { console.warn('  -', f); });
    console.warn('Run `node tools/check-feeds.js` (or the Feed Health workflow) to confirm whether they are permanently dead.');
  }
  if (droppedLinks) {
    console.warn('NOTE:', droppedLinks, 'item(s) had no usable https link and were dropped.');
  }
  reportRejectedImageHosts(droppedImageHosts, 'feed images');
  if (apiUnavailable) {
    console.warn('NOTE: the Anthropic API was unavailable this run — summaries and translations were skipped and will be retried next run.');
  }
}

// Importable so tools/check-feeds.js can reuse the real source list and
// parser rather than keeping a second copy that drifts out of date.
module.exports = { REGIONS, POLICY, SOURCE_LANG, fetchUrl, fetchFeedUrl, parseFeed, stripTags, decodeEntities, parseDate,
                   sanitizeLink, sanitizeImage, parseJsonBlock, summaryFromBriefing, storyBrief,
                   BRIEFING_STORIES, WHY_STORIES, security, lang, cluster, rank, archive };

if (require.main === module) {
  main().catch(function(e){ console.error(e); process.exit(1); });
}
