const https = require('https');
const http  = require('http');
const url   = require('url');
const fs    = require('fs');

const SOURCES = [
  { id: 'ds-frontpage',     name: 'The Daily Star',    color: '#1a7a4a', url: 'https://www.thedailystar.net/frontpage/rss.xml' },
  { id: 'ds-bangladesh',    name: 'DS: Bangladesh',    color: '#1a7a4a', url: 'https://www.thedailystar.net/bangladesh/rss.xml' },
  { id: 'ds-business',      name: 'DS: Business',      color: '#1a7a4a', url: 'https://www.thedailystar.net/business/rss.xml' },
  { id: 'ds-sports',        name: 'DS: Sports',        color: '#1a7a4a', url: 'https://www.thedailystar.net/sports/rss.xml' },
  { id: 'ds-entertainment', name: 'DS: Entertainment', color: '#1a7a4a', url: 'https://www.thedailystar.net/entertainment/rss.xml' },
  { id: 'ds-lifestyle',     name: 'DS: Lifestyle',     color: '#1a7a4a', url: 'https://www.thedailystar.net/lifestyle/rss.xml' },
  { id: 'ds-opinion',       name: 'DS: Opinion',       color: '#1a7a4a', url: 'https://www.thedailystar.net/opinion/rss.xml' },
  { id: 'bdnews24',         name: 'bdnews24',          color: '#e05c1a', url: 'https://bdnews24.com/?widgetName=rssfeed&widgetId=1150&getXmlFeed=true' },
  { id: 'prothomalo',       name: 'Prothom Alo',       color: '#c0392b', url: 'https://en.prothomalo.com/feed/' },
  { id: 'newagebd',         name: 'New Age',           color: '#2980b9', url: 'https://www.newagebd.net/rss' },
  { id: 'financialexpress', name: 'Financial Express', color: '#8e44ad', url: 'https://thefinancialexpress.com.bd/feed/' },
  { id: 'independentbd',    name: 'The Independent',   color: '#16a085', url: 'https://theindependentbd.com/feed/' },
  { id: 'bangladeshtoday',  name: 'Bangladesh Today',  color: '#d35400', url: 'https://www.thebangladeshtoday.com/feed/' },
];

// Resolve a potentially-relative redirect Location against the originating URL
function resolveLocation(location, fromUrl) {
  if (location.startsWith('http://') || location.startsWith('https://')) {
    return location;
  }
  var parsed = url.parse(fromUrl);
  if (location.startsWith('//')) {
    return parsed.protocol + location;
  }
  return parsed.protocol + '//' + parsed.host + (location.startsWith('/') ? '' : '/') + location;
}

function fetchUrl(requestUrl, redirects) {
  redirects = redirects || 0;
  return new Promise(function(resolve, reject) {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    var lib = requestUrl.startsWith('https') ? https : http;
    var req = lib.get(requestUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      timeout: 15000
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var next = resolveLocation(res.headers.location, requestUrl);
        res.resume();
        return fetchUrl(next, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
  });
}

function stripTags(html) {
  return (html || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractImg(block) {
  var patterns = [
    /url="([^"]+\.(?:jpg|jpeg|png|webp|gif))/i,
    /<media:thumbnail[^>]+url="([^"]+)"/i,
    /<img[^>]+src="([^"]+)"/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = block.match(patterns[i]);
    if (m) return m[1];
  }
  return null;
}

function getTag(block, tag) {
  var m = block.match(new RegExp('<' + tag + '[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/' + tag + '>', 'i'))
       || block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1].trim() : '';
}

// Parse standard RSS feeds (items use <item> tags)
function parseRSS(xml, source) {
  var items = [];
  var re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  var m;
  while ((m = re.exec(xml)) !== null && items.length < 15) {
    var b = m[1];
    var title = stripTags(getTag(b, 'title'));
    if (!title) continue;
    items.push({
      title:       title,
      link:        getTag(b, 'link') || getTag(b, 'guid') || '',
      desc:        stripTags(getTag(b, 'description')).slice(0, 200),
      pubDate:     getTag(b, 'pubDate') || getTag(b, 'dc:date') || '',
      img:         extractImg(b),
      sourceId:    source.id,
      sourceName:  source.name,
      sourceColor: source.color,
    });
  }
  return items;
}

// Parse Atom feeds (items use <entry> tags)
function parseAtom(xml, source) {
  var items = [];
  var re = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  var m;
  while ((m = re.exec(xml)) !== null && items.length < 15) {
    var b = m[1];
    var title = stripTags(getTag(b, 'title'));
    if (!title) continue;
    // Atom uses <link href="..."/> or <link>url</link>
    var linkMatch = b.match(/<link[^>]+href="([^"]+)"/i) || b.match(/<link[^>]*>([^<]+)<\/link>/i);
    var link = linkMatch ? linkMatch[1].trim() : '';
    var desc = stripTags(getTag(b, 'summary') || getTag(b, 'content')).slice(0, 200);
    var pubDate = getTag(b, 'published') || getTag(b, 'updated') || '';
    items.push({
      title:       title,
      link:        link,
      desc:        desc,
      pubDate:     pubDate,
      img:         extractImg(b),
      sourceId:    source.id,
      sourceName:  source.name,
      sourceColor: source.color,
    });
  }
  return items;
}

function parseFeed(xml, source) {
  var articles = parseRSS(xml, source);
  if (!articles.length) articles = parseAtom(xml, source);
  return articles;
}

async function main() {
  var results = [];
  for (var i = 0; i < SOURCES.length; i++) {
    var source = SOURCES[i];
    try {
      console.log('Fetching:', source.name, '-', source.url);
      var xml = await fetchUrl(source.url);
      var articles = parseFeed(xml, source);
      console.log('  Got', articles.length, 'articles');
      results = results.concat(articles);
    } catch(e) {
      console.error('  Failed:', e.message);
    }
  }
  results.sort(function(a, b) { return new Date(b.pubDate) - new Date(a.pubDate); });
  var output = {
    fetchedAt: new Date().toISOString(),
    sources:   SOURCES.map(function(s) { return { id: s.id, name: s.name, color: s.color }; }),
    articles:  results
  };
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log('Done. Saved', results.length, 'articles to data.json');
}

main().catch(function(e) { console.error(e); process.exit(1); });
