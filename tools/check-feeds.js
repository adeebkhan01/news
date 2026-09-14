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
const { REGIONS, fetchUrl, parseFeed, parseDate, security } = require('../fetch.js');

const args = process.argv.slice(2);
let regionFilter = null;
const candidates = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--region') { regionFilter = args[++i]; continue; }
  if (args[i].startsWith('http')) candidates.push(args[i]);
}

const CONCURRENCY = 6;
const STALE_DAYS = 30;   // matches the retention window in fetch.js

function newestAgeDays(articles) {
  const newest = articles.map(a => parseDate(a.pubDate)).filter(Boolean).sort((a, b) => b - a)[0];
  return newest == null ? null : (Date.now() - newest) / 864e5;
}

function ageOf(articles) {
  const days = newestAgeDays(articles);
  if (days == null) return 'no dates';
  return days < 2 ? Math.round(days * 24) + 'h old' : Math.round(days) + 'd old';
}

async function check(entry) {
  const probe = { id: entry.id || 'candidate', name: entry.name || 'candidate', url: entry.url };
  try {
    // The publishing pipeline may only fetch the exact URLs in the source
    // list. This tool exists to try URLs that are not on it yet, so it opts
    // into a wider policy — but only wider in one direction: still https only,
    // still no address literals or private names, still capped and timed out.
    // A candidate comes from a person typing it, not from feed content.
    const xml = await fetchUrl(entry.url, {
      allowRedirect: (u) => !!security.parseSafeUrl(u)
    });
    const articles = parseFeed(xml, probe);
    if (!articles.length) return { ...entry, ok: false, detail: 'parsed 0 articles' };
    const detail = `${articles.length} articles, newest ${ageOf(articles)}`;
    const days = newestAgeDays(articles);
    if (days != null && days > STALE_DAYS) {
      return { ...entry, ok: true, stale: true, detail: detail + ' — past retention' };
    }
    return { ...entry, ok: true, detail };
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

  let dead = 0, stale = 0;
  for (const r of results) {
    if (r.region !== 'candidate') {
      if (!r.ok) dead++;
      else if (r.stale) stale++;
    }
    const mark = !r.ok ? 'DEAD' : r.stale ? 'STALE' : 'ok';
    console.log(
      `${mark.padEnd(5)} ${r.region.padEnd(9)} ${r.name.slice(0, 22).padEnd(22)} ${r.detail.slice(0, 46).padEnd(46)} ${r.url}`
    );
  }

  const checked = results.filter(r => r.region !== 'candidate');
  const live = checked.filter(r => r.ok && !r.stale).length;
  console.log(`\n${live} live, ${stale} stale, ${dead} dead of ${checked.length} configured feeds`);
  if (extras.length) {
    const good = results.filter(r => r.region === 'candidate' && r.ok);
    console.log(`${good.length} of ${extras.length} candidate URLs usable`);
  }
  process.exit(dead ? 1 : 0);
})();
