#!/usr/bin/env node
//
// Feed health check. Fetches every configured source (plus any URLs passed on
// the command line) and reports whether it still returns parseable, recent
// articles. Exits non-zero if a configured feed is dead, so it can gate a
// scheduled run or be dispatched by hand after editing the source list.
//
//   node tools/check-feeds.js                       # all configured feeds
//   node tools/check-feeds.js --region bd           # one region
//   node tools/check-feeds.js <url> <url> ...       # also try candidates
//
const { REGIONS, fetchUrl, parseFeed, parseDate } = require('../fetch.js');

const args = process.argv.slice(2);
let regionFilter = null;
const candidates = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--region') { regionFilter = args[++i]; continue; }
  if (args[i].startsWith('http')) candidates.push(args[i]);
}

const CONCURRENCY = 6;

function ageOf(articles) {
  const newest = articles.map(a => parseDate(a.pubDate)).filter(Boolean).sort((a, b) => b - a)[0];
  if (!newest) return 'no dates';
  const hours = (Date.now() - newest) / 36e5;
  if (hours < 48) return Math.round(hours) + 'h old';
  return Math.round(hours / 24) + 'd old';
}

async function check(entry) {
  const probe = { id: entry.id || 'candidate', name: entry.name || 'candidate', url: entry.url };
  try {
    const xml = await fetchUrl(entry.url);
    const articles = parseFeed(xml, probe);
    if (!articles.length) return { ...entry, ok: false, detail: 'parsed 0 articles' };
    return { ...entry, ok: true, detail: `${articles.length} articles, newest ${ageOf(articles)}` };
  } catch (e) {
    return { ...entry, ok: false, detail: e.message };
  }
}

async function runPool(entries) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) results.push(await check(entries[next++]));
  }));
  return results;
}

(async () => {
  const configured = [];
  for (const [key, region] of Object.entries(REGIONS)) {
    if (regionFilter && key !== regionFilter) continue;
    region.sources.forEach(s => configured.push({ region: key, id: s.id, name: s.name, url: s.url }));
  }
  const extras = candidates.map(url => ({ region: 'candidate', id: 'candidate', name: 'candidate', url }));

  const results = await runPool(configured.concat(extras));
  results.sort((a, b) => (a.region + a.name).localeCompare(b.region + b.name));

  let dead = 0;
  for (const r of results) {
    if (!r.ok && r.region !== 'candidate') dead++;
    console.log(
      `${r.ok ? 'ok  ' : 'DEAD'}  ${r.region.padEnd(9)} ${r.name.slice(0, 22).padEnd(22)} ${r.detail.slice(0, 46).padEnd(46)} ${r.url}`
    );
  }

  const live = results.filter(r => r.ok && r.region !== 'candidate').length;
  console.log(`\n${live} live, ${dead} dead of ${results.filter(r => r.region !== 'candidate').length} configured feeds`);
  if (extras.length) {
    const good = results.filter(r => r.region === 'candidate' && r.ok);
    console.log(`${good.length} of ${extras.length} candidate URLs usable`);
  }
  process.exit(dead ? 1 : 0);
})();
