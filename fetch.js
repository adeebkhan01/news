const https   = require('https');
const http    = require('http');
const url     = require('url');
const fs      = require('fs');

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
// Checked but not adopted, newest item already past the 30-day retention:
//   tbsnews.net/rss.xml (1766d), sbs.com.au/news/feed (18d, dormant)
const REGIONS = {
  bd: {
    label: 'Bangladesh',
    dataFile: 'data-bd.json',
    translate: true,
    summaryPrompt: 'You are a concise news briefing editor covering Bangladesh.',
    sources: [
      { id: 'dailystar', name: 'The Daily Star', color: '#1a7a4a', url: 'https://www.thedailystar.net/business/rss.xml' },
      { id: 'dailystar', name: 'The Daily Star', color: '#1a7a4a', url: 'https://www.thedailystar.net/frontpage/rss.xml' },
      { id: 'dailystar', name: 'The Daily Star', color: '#1a7a4a', url: 'https://www.thedailystar.net/bangladesh/rss.xml' },
      // Site-wide feed, so it carries the soft sections too. The article URL
      // names its section, which is a far better signal than keyword matching.
      { id: 'prothomalo',       name: 'Prothom Alo',       color: '#c0392b', url: 'https://en.prothomalo.com/feed/',
        excludeSections: ['entertainment', 'photo', 'lifestyle'] },
      { id: 'risingbd',         name: 'Rising BD',         color: '#0f7b6c', url: 'https://www.risingbd.com/rss/rss.xml' },
    ]
  },
  au: {
    label: 'Australia',
    dataFile: 'data-au.json',
    translate: false,
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
    translate: false,
    topicFilter: true,
    summaryPrompt: 'You are a concise news briefing editor covering global affairs.',
    sources: [
      { id: 'bbcnews',   name: 'BBC News',    color: '#BB1919', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { id: 'bbcnews',   name: 'BBC News',    color: '#BB1919', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
      { id: 'bbcnews',   name: 'BBC News',    color: '#BB1919', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
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

// Guardrails for feed fetching.
var MAX_FEED_BYTES  = 8 * 1024 * 1024;
var FEED_CONCURRENCY = 4;

// How many previously-failed translations to retry per run. Sized against the
// run cadence in .github/workflows/fetch-feeds.yml: at twice a day this keeps
// the backlog draining at roughly 400 articles a day.
var RETRY_PER_RUN = 200;

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
  if (loc.startsWith('http://') || loc.startsWith('https://')) return loc;
  var p = url.parse(from);
  if (loc.startsWith('//')) return p.protocol + loc;
  return p.protocol + '//' + p.host + (loc.startsWith('/') ? '' : '/') + loc;
}

function fetchUrl(reqUrl, redirects) {
  redirects = redirects || 0;
  return new Promise(function(resolve, reject) {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    var lib = reqUrl.startsWith('https') ? https : http;
    var req = lib.get(reqUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,*/*',
      },
      timeout: 15000
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchUrl(resolveLocation(res.headers.location, reqUrl), redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      var data = ''; res.setEncoding('utf8');
      res.on('data', function(c) {
        data += c;
        if (data.length > MAX_FEED_BYTES) { req.destroy(); reject(new Error('Feed larger than ' + MAX_FEED_BYTES + ' bytes')); }
      });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
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
    return await fetchUrl(reqUrl);
  } catch (e) {
    if (!isTransientHttp(e)) throw e;
    await new Promise(function(r) { setTimeout(r, 1500); });
    return fetchUrl(reqUrl);
  }
}

function fetchHead(reqUrl, redirects) {
  redirects = redirects || 0;
  return new Promise(function(resolve) {
    if (redirects > 3) return resolve('');
    var lib = reqUrl.startsWith('https') ? https : http;
    var req = lib.get(reqUrl, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0' }, timeout: 10000 }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        return fetchHead(resolveLocation(res.headers.location, reqUrl), redirects + 1).then(resolve);
      }
      var data = ''; res.setEncoding('utf8');
      res.on('data', function(c) { data += c; if (data.length > 8000) res.destroy(); });
      res.on('end',  function() { resolve(data); });
      res.on('close',function() { resolve(data); });
      res.on('error',function() { resolve(data); });
    });
    req.on('error',   function() { resolve(''); });
    req.on('timeout', function() { req.destroy(); resolve(''); });
  });
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

function parseRSS(xml, source) {
  var items=[], re=/<item[^>]*>([\s\S]*?)<\/item>/gi, m;
  while((m=re.exec(xml))!==null && items.length<MAX_ITEMS_PER_FEED) {
    var b=m[1], title=stripTags(getTag(b,'title'));
    if(!title) continue;
    items.push({ title, link: getTag(b,'link')||getTag(b,'guid')||'', desc: stripTags(getTag(b,'description')).slice(0,200), pubDate: getTag(b,'pubDate')||getTag(b,'dc:date')||'', img: extractImg(b), sourceId: source.id, sourceName: source.name, sourceColor: source.color });
  }
  return items;
}

function parseAtom(xml, source) {
  var items=[], re=/<entry[^>]*>([\s\S]*?)<\/entry>/gi, m;
  while((m=re.exec(xml))!==null && items.length<MAX_ITEMS_PER_FEED) {
    var b=m[1], title=stripTags(getTag(b,'title'));
    if(!title) continue;
    var lm=b.match(/<link[^>]+href="([^"]+)"/i)||b.match(/<link[^>]*>([^<]+)<\/link>/i);
    items.push({ title, link: lm?lm[1].trim():'', desc: stripTags(getTag(b,'summary')||getTag(b,'content')).slice(0,200), pubDate: getTag(b,'published')||getTag(b,'updated')||'', img: extractImg(b), sourceId: source.id, sourceName: source.name, sourceColor: source.color });
  }
  return items;
}

function parseFeed(xml, source) {
  var a = parseRSS(xml, source);
  return a.length ? a : parseAtom(xml, source);
}

async function enrichImages(articles) {
  var missing = articles.filter(function(a) { return !a.img && a.link && a.link.startsWith('http'); });
  console.log('Fetching og:image for', missing.length, 'articles...');
  var BATCH = 5;
  for (var i=0; i<missing.length; i+=BATCH) {
    await Promise.all(missing.slice(i,i+BATCH).map(async function(a) {
      try { var html=await fetchHead(a.link); var img=extractOgImage(html); if(img) a.img=img; } catch(e) {}
    }));
  }
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

async function generatePageSummary(articles) {
  if (!ANTHROPIC_API_KEY || apiUnavailable) return null;
  console.log('Generating page summary for', REGION.label, '...');
  var titles = articles.slice(0,40).map(function(a,i){ return (i+1)+'. '+a.title; }).join('\n');
  try {
    return await claudeComplete(
      REGION.summaryPrompt + ' Write in plain prose, no bullet points, no markdown.',
      'Here are the top headlines from ' + REGION.label + ' news sources today:\n\n'+titles+'\n\nWrite a 3-4 sentence briefing summarising the key themes and most significant stories. Be direct and informative.'
    );
  } catch(e) {
    console.error('Page summary failed:', e.message);
    if (isApiUnavailable(e)) apiUnavailable = true;
    return null;
  }
}

// The briefing is written in English and translated, rather than generated
// twice, so the two languages always describe the same set of headlines.
async function translateSummary(text) {
  if (!ANTHROPIC_API_KEY || apiUnavailable || !text) return null;
  console.log('Translating the briefing to Bangla...');
  try {
    return await claudeComplete(
      'You are a Bengali (Bangla) translator. Translate the given English news briefing into natural Bengali. '
      + 'Respond with the translation only — no preamble, no quotation marks, no markdown.',
      text,
      1500
    );
  } catch (e) {
    console.error('Briefing translation failed:', e.message);
    if (isApiUnavailable(e)) apiUnavailable = true;
    return null;
  }
}

// Translate articles to Bangla
async function translateArticles(articles) {
  if (!ANTHROPIC_API_KEY || !articles.length) return;
  console.log('Translating', articles.length, 'articles to Bangla...');
  var BATCH = 5;
  for (var i=0; i<articles.length; i+=BATCH) {
    await Promise.all(articles.slice(i,i+BATCH).map(async function(a) {
      try {
        var result = await claudeComplete(
          'You are a Bengali (Bangla) translator. Translate the given English news text to Bengali. Respond ONLY with valid JSON, no markdown, no explanation.',
          'Title: '+a.title+'\nDescription: '+(a.desc||'')+'\n\n'
          + 'Return a JSON object with exactly these fields:\n'
          + '{"titleBn": "Bengali translation of the title", '
          + '"descBn": "Bengali translation of the description (or empty string if no description)"}'
        );
        var clean = result.replace(/^```[a-z]*\n?/i,'').replace(/```$/,'').trim();
        var start = clean.indexOf('{');
        var end   = clean.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object found in response');
        var parsed = JSON.parse(clean.slice(start, end + 1));
        a.titleBn = parsed.titleBn || null;
        a.descBn  = parsed.descBn  || '';
      } catch(e) {
        console.error('  Translation failed for "' + a.title.slice(0,40) + '":', e.message);
        if (isApiUnavailable(e)) {
          apiUnavailable = true;   // leave the article untouched so it retries
        } else {
          a.titleBn = false;       // the model answered, just not usably
          a.descBn  = false;
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
        .filter(function(a) { return !REGION.topicFilter || matchesTopic(a); });
      var pruned = beforePrune - existingArticles.length;
      existingArticles.forEach(function(a) {
        if (REGION.translate) {
          if (a.titleBn === null) a.titleBn = false;
          if (a.descBn === null)  a.descBn  = false;
        }
        existingByLink[a.link] = true;
      });
      console.log('Loaded', existingArticles.length, 'existing articles (' + pruned + ' pruned: stale, excluded section, or off-topic)');
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
    var needsTranslation = existingArticles.filter(function(a) { return a.titleBn === undefined; });
    // Previously-failed articles used to be skipped forever, so a single API
    // outage stranded every article it touched. Drain them a batch per run.
    var failedTranslation = existingArticles.filter(function(a) { return a.titleBn === false; });
    var retrying = failedTranslation.slice(0, RETRY_PER_RUN);
    console.log(freshArticles.length, 'new articles,', needsTranslation.length, 'existing need translation,',
                failedTranslation.length, 'previously failed (' + retrying.length + ' retried this run)');
    await translateArticles(freshArticles.concat(needsTranslation, retrying));
  } else {
    console.log(freshArticles.length, 'new articles (translation disabled for', REGION.label, ')');
  }

  // ── Merge: new articles + existing ──
  var allArticles = freshArticles.concat(existingArticles);
  allArticles.sort(function(a,b){ return (parseDate(b.pubDate)||0)-(parseDate(a.pubDate)||0); });

  // ── Page summary: refresh on new articles, or whenever we haven't got one ──
  var storedSummary = null, storedSummaryBn = null;
  try {
    var prev = JSON.parse(fs.readFileSync(dataFile,'utf8'));
    storedSummary   = prev.summary   || null;
    storedSummaryBn = prev.summaryBn || null;
  } catch(e) {}

  var pageSummary = storedSummary, pageSummaryBn = storedSummaryBn;
  if (freshArticles.length > 0 || !storedSummary) {
    var generated = await generatePageSummary(allArticles);
    // A failed call must not wipe a good summary off the page.
    if (generated) {
      pageSummary = generated;
      pageSummaryBn = null;   // the stored translation describes the old one
    } else if (storedSummary) {
      console.log('Summary generation failed — keeping the previous one');
    }
  } else {
    console.log('No new articles — reusing existing summary');
  }

  // Retried every run until it lands, like the article translations.
  if (REGION.translate && pageSummary && !pageSummaryBn) {
    pageSummaryBn = await translateSummary(pageSummary);
  }

  var output = {
    fetchedAt: new Date().toISOString(),
    summary:   pageSummary,
    summaryBn: pageSummaryBn || null,
    sources:   UNIQUE_SOURCES,
    articles:  allArticles
  };

  fs.writeFileSync(dataFile, JSON.stringify(output, null, 2));
  console.log('Done.', dataFile, 'now has', allArticles.length, 'articles (', freshArticles.length, 'new,', existingArticles.length, 'retained)');
  if (failedSources.length) {
    console.warn('WARNING:', failedSources.length, 'of', SOURCES.length, 'feeds failed this run:');
    failedSources.forEach(function(f) { console.warn('  -', f); });
    console.warn('Run `node tools/check-feeds.js` (or the Feed Health workflow) to confirm whether they are permanently dead.');
  }
  if (apiUnavailable) {
    console.warn('NOTE: the Anthropic API was unavailable this run — summaries and translations were skipped and will be retried next run.');
  }
}

// Importable so tools/check-feeds.js can reuse the real source list and
// parser rather than keeping a second copy that drifts out of date.
module.exports = { REGIONS, fetchUrl, parseFeed, stripTags, decodeEntities, parseDate };

if (require.main === module) {
  main().catch(function(e){ console.error(e); process.exit(1); });
}
