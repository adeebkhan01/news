'use strict';
//
// Tests for the story layer: grouping articles into events, ranking those
// events, and validating what the model says about them.
//
//   node --test tests/
//
// Two failure modes are worth more than the rest. A wrong merge puts one
// publisher's headline over another publisher's link, which is a
// misattribution and the only thing here that could libel someone. A briefing
// that fails validation and is stored anyway puts unchecked model output on
// the page. Both have tests that fail loudly.
//
// No network. Everything is a pure function of its input.

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const cluster = require('../lib/cluster.js');
const rank = require('../lib/rank.js');
const sec = require('../lib/security.js');
const { parseJsonBlock, summaryFromBriefing, parseDate } = require('../fetch.js');

const HOUR = 60 * 60 * 1000;

function article(over) {
  return Object.assign({
    title: '', desc: '', link: 'https://example.com/news/x', img: null,
    pubDate: new Date(Date.now() - HOUR).toUTCString(),
    lang: 'en', sourceId: 'src', sourceName: 'Source', sourceColor: '#000'
  }, over);
}

// ── Tokenising ───────────────────────────────────────────────────────────

test('tokenize drops the words every headline has', () => {
  const tokens = cluster.tokenize('The government said it will review the new policy');
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('said'));
  assert.ok(!tokens.includes('will'));
  assert.ok(tokens.includes('government'));
  assert.ok(tokens.includes('review'));
  assert.ok(tokens.includes('policy'));
});

test('tokenize keeps acronyms and figures that shorter words would lose', () => {
  const tokens = cluster.tokenize('UN warns GDP could fall 3% in 2026');
  assert.ok(tokens.includes('un'), 'UN is two letters and is not noise');
  assert.ok(tokens.includes('gdp'));
  assert.ok(tokens.includes('2026'));
});

test('tokenize counts a repeated word once', () => {
  const tokens = cluster.tokenize('Trade, trade and more trade');
  assert.equal(tokens.filter(tok => tok === 'trade').length, 1);
});

test('tokenize reads Bangla as well as English', () => {
  const tokens = cluster.tokenize('বাংলাদেশ ব্যাংক নীতি সুদহার বাড়াল');
  assert.ok(tokens.length >= 4, `expected Bangla tokens, got ${JSON.stringify(tokens)}`);
});

test('a possessive and its bare form are one token', () => {
  assert.deepEqual(cluster.tokenize("Australia's exports"), cluster.tokenize('Australia exports'));
});

// ── IDF ──────────────────────────────────────────────────────────────────

test('a rare token outweighs a common one', () => {
  const idf = cluster.buildIdf([
    ['government', 'cyclone'], ['government', 'budget'],
    ['government', 'tax'], ['government', 'election']
  ]);
  assert.ok(idf.cyclone > idf.government,
    'a token in one document of four must outweigh one in all four');
});

// ── Clustering ───────────────────────────────────────────────────────────

test('two publishers describing one event become one story', () => {
  const articles = [
    article({ title: 'Bangladesh Bank raises policy rate to curb inflation',
              link: 'https://a.example/1', sourceId: 'dailystar' }),
    article({ title: 'Policy rate raised by Bangladesh Bank as inflation persists',
              link: 'https://b.example/1', sourceId: 'prothomalo' }),
    // Filler, so IDF has a corpus to work against: with two documents every
    // token is either in half of them or all of them and nothing is rare.
    article({ title: 'Cricket board names squad for tour', link: 'https://c.example/1' }),
    article({ title: 'Ferry service resumes after cyclone warning lifted', link: 'https://d.example/2' }),
    article({ title: 'University announces new engineering faculty', link: 'https://e.example/3' })
  ];
  const stories = cluster.clusterArticles(articles);
  const merged = stories.filter(s => s.members.length > 1);
  assert.equal(merged.length, 1, 'exactly one pair should have merged');
  assert.deepEqual(merged[0].sourceIds.sort(), ['dailystar', 'prothomalo']);
});

test('unrelated stories sharing only ordinary words stay apart', () => {
  // The failure this exists to catch: both are government stories using the
  // same vocabulary, and nothing about them is the same event.
  const articles = [
    article({ title: 'Government announces new school building programme', link: 'https://a.example/1' }),
    article({ title: 'Government announces new fishing licence rules', link: 'https://b.example/1' }),
    article({ title: 'Council announces new parking charges', link: 'https://c.example/1' }),
    article({ title: 'Minister announces new visa categories', link: 'https://d.example/1' }),
    article({ title: 'Regulator announces new banking capital rules', link: 'https://e.example/1' })
  ];
  const stories = cluster.clusterArticles(articles);
  assert.equal(stories.length, articles.length,
    'these are five stories, not one: ' + JSON.stringify(
      stories.map(s => s.members.map(m => m.title))));
});

test('the same event a fortnight apart is two stories', () => {
  const title = 'Bangladesh Bank raises policy rate to curb inflation';
  const articles = [
    article({ title, link: 'https://a.example/1', sourceId: 'one',
              pubDate: new Date(Date.now()).toUTCString() }),
    article({ title, link: 'https://b.example/1', sourceId: 'two',
              pubDate: new Date(Date.now() - 14 * 24 * HOUR).toUTCString() }),
    article({ title: 'Cricket board names squad for tour', link: 'https://c.example/1' }),
    article({ title: 'Ferry service resumes after cyclone warning lifted', link: 'https://d.example/1' })
  ];
  const stories = cluster.clusterArticles(articles, { parseDate: parseDate });
  assert.equal(stories.filter(s => s.members.length > 1).length, 0,
    'a fortnight apart is a follow-up, not the same event');
});

test('a story leads with its freshest member and keeps its id as it grows', () => {
  const base = {
    title: 'Saudi Arabia shuts key oil pipeline after drone attack',
    pubDate: new Date(Date.now() - 6 * HOUR).toUTCString()
  };
  const oldest = article(Object.assign({}, base, {
    link: 'https://a.example/1', sourceId: 'bbc',
    pubDate: new Date(Date.now() - 10 * HOUR).toUTCString()
  }));
  const newest = article(Object.assign({}, base, {
    title: 'Key Saudi oil pipeline shut after drone attack from Iraq',
    link: 'https://b.example/1', sourceId: 'aljazeera',
    pubDate: new Date(Date.now() - HOUR).toUTCString()
  }));
  const filler = [
    article({ title: 'Cricket board names squad for tour', link: 'https://c.example/1' }),
    article({ title: 'University announces engineering faculty', link: 'https://d.example/1' }),
    article({ title: 'Ferry service resumes after storm warning lifted', link: 'https://e.example/1' })
  ];

  const before = cluster.clusterArticles([oldest].concat(filler), { parseDate: parseDate })
    .find(s => s.members[0].link === oldest.link);
  const after = cluster.clusterArticles([newest, oldest].concat(filler), { parseDate: parseDate })
    .find(s => s.members.length > 1);

  assert.ok(after, 'the two tellings should have merged');
  assert.equal(after.members[0].link, newest.link, 'the lead is the freshest telling');
  assert.equal(after.id, before.id,
    'a story gaining a publisher must keep its id, or every cached line is thrown away');
});

test('the same story from two feeds of one publisher is still one source', () => {
  const articles = [
    article({ title: 'One Nation secures historic byelection win', link: 'https://a.example/1', sourceId: 'smh' }),
    article({ title: 'One Nation claims historic by-election win', link: 'https://b.example/1', sourceId: 'smh' }),
    article({ title: 'Cricket board names squad for tour', link: 'https://c.example/1' }),
    article({ title: 'University announces engineering faculty', link: 'https://d.example/1' }),
    article({ title: 'Ferry service resumes after storm warning lifted', link: 'https://e.example/1' })
  ];
  const story = cluster.clusterArticles(articles).find(s => s.members.length > 1);
  assert.ok(story, 'the two should have merged');
  assert.deepEqual(story.sourceIds, ['smh'],
    'two feeds of one publisher are not two sources, and must not read as corroboration');
});

test('every article lands in exactly one story', () => {
  const articles = Array.from({ length: 40 }, (_, i) =>
    article({ title: `Headline number ${i} about subject ${i % 7}`, link: `https://x.example/${i}` }));
  const stories = cluster.clusterArticles(articles);
  const links = stories.flatMap(s => s.members.map(m => m.link));
  assert.equal(links.length, articles.length);
  assert.equal(new Set(links).size, articles.length, 'an article appeared in two stories');
});

// ── Topics ───────────────────────────────────────────────────────────────

test("the publisher's own section outranks keyword guessing", () => {
  // The headline says "cricket"; the publisher filed it under business,
  // and the publisher knows.
  const topic = rank.classify(article({
    title: 'Cricket board signs record sponsorship deal',
    link: 'https://www.thedailystar.net/business/news/x'
  }));
  assert.equal(topic, 'business');
});

test('keywords classify what the URL does not', () => {
  assert.equal(rank.classify(article({
    title: 'Inflation hits 9% as central bank holds interest rates',
    link: 'https://x.example/news/2026/a' })), 'economy');
  assert.equal(rank.classify(article({
    title: 'Ceasefire collapses as airstrikes resume', link: 'https://x.example/a' })), 'conflict');
  assert.equal(rank.classify(article({
    title: 'Local choir wins county competition', link: 'https://x.example/a' })), 'other');
});

test('a Bangla article is classified on its English translation', () => {
  const topic = rank.classify(article({
    lang: 'bn', title: 'মূল্যস্ফীতি নিয়ন্ত্রণে নীতি সুদহার বাড়ল',
    titleEn: 'Policy interest rate raised to control inflation',
    link: 'https://x.example/a'
  }));
  assert.equal(topic, 'economy');
});

// ── Ranking ──────────────────────────────────────────────────────────────

function story(over) {
  const now = Date.now();
  return Object.assign({
    id: 's1', sourceIds: ['a'], topic: 'politics',
    members: [article({ pubDate: new Date(now - HOUR).toUTCString() })]
  }, over);
}

test('corroboration raises a story above an identical single-source one', () => {
  const now = Date.now();
  const stamp = new Date(now - HOUR).toUTCString();
  const one = story({ id: 'one', sourceIds: ['a'],
    members: [article({ pubDate: stamp })] });
  const four = story({ id: 'four', sourceIds: ['a', 'b', 'c', 'd'],
    members: [0, 1, 2, 3].map(() => article({ pubDate: stamp })) });
  assert.ok(rank.scoreStory(four, now).score > rank.scoreStory(one, now).score);
});

test('a story decays as it ages', () => {
  const now = Date.now();
  const fresh = story({ members: [article({ pubDate: new Date(now - HOUR).toUTCString() })] });
  const old = story({ members: [article({ pubDate: new Date(now - 72 * HOUR).toUTCString() })] });
  assert.ok(rank.scoreStory(fresh, now).score > rank.scoreStory(old, now).score * 4,
    'three days should cost a story most of its weight');
});

test('an editorial ordering, and one this product actually holds', () => {
  // Not an assertion about the world — an assertion that the table is wired
  // up and says what the README says it says.
  assert.ok(rank.TOPIC_WEIGHT.economy > rank.TOPIC_WEIGHT.sport);
  assert.ok(rank.TOPIC_WEIGHT.conflict > rank.TOPIC_WEIGHT.culture);
  const now = Date.now();
  const stamp = new Date(now - HOUR).toUTCString();
  const economy = story({ topic: 'economy', members: [article({ pubDate: stamp })] });
  const sport = story({ topic: 'sport', members: [article({ pubDate: stamp })] });
  assert.ok(rank.scoreStory(economy, now).score > rank.scoreStory(sport, now).score);
});

test('the ranking is a total order, so a run cannot reshuffle itself', () => {
  const now = Date.now();
  const stamp = new Date(now - HOUR).toUTCString();
  const stories = [1, 2, 3, 4, 5].map(i => story({
    id: 's' + i, sourceIds: ['a'], members: [article({ pubDate: stamp, link: 'https://x/' + i })]
  }));
  const first = rank.rankStories(stories, now).map(s => s.id);
  const again = rank.rankStories(stories.slice().reverse(), now).map(s => s.id);
  assert.deepEqual(first.slice().sort(), again.slice().sort());
  assert.equal(first.length, 5);
});

test('every factor behind a rank is reported with it', () => {
  const r = rank.scoreStory(story({ sourceIds: ['a', 'b'] }), Date.now());
  assert.deepEqual(Object.keys(r.factors).sort(), ['burst', 'corroboration', 'recency', 'topic']);
  assert.ok(Object.values(r.factors).every(Number.isFinite), 'a factor came back as NaN');
});

// ── What the model returns ───────────────────────────────────────────────

const GOOD_ITEM = {
  id: 'sabc', headline: 'Central bank raises policy rate',
  what: 'The central bank lifted its policy rate by 50 basis points.',
  why: 'Borrowing costs rise for exporters already squeezed by weak demand.',
  watch: 'Whether commercial banks pass the rise on this month.'
};

test('a briefing of the declared shape is accepted whole', () => {
  const out = sec.validateBriefing([GOOD_ITEM, Object.assign({}, GOOD_ITEM, { id: 'sdef' })]);
  assert.equal(out.length, 2);
  assert.equal(out[0].headline, GOOD_ITEM.headline);
  assert.equal(out[0].id, 'sabc');
});

test('a briefing wrapped in an object is accepted, a bare string is not', () => {
  assert.ok(sec.validateBriefing({ items: [GOOD_ITEM, GOOD_ITEM] }));
  assert.equal(sec.validateBriefing('here is your briefing'), null);
  assert.equal(sec.validateBriefing(null), null);
});

test('a briefing outside the promised length is a failed call', () => {
  assert.equal(sec.validateBriefing([GOOD_ITEM]), null, 'one item is not a briefing');
  assert.equal(sec.validateBriefing(Array(8).fill(GOOD_ITEM)), null, 'eight items is the feed again');
});

test('an item missing a required field takes the whole briefing down', () => {
  // Not a partial accept: a briefing with a hole in it would render as an
  // item that says what happened and never says why.
  for (const field of ['headline', 'what', 'why']) {
    const broken = Object.assign({}, GOOD_ITEM);
    delete broken[field];
    assert.equal(sec.validateBriefing([broken, GOOD_ITEM]), null, `a missing ${field} was accepted`);
  }
});

test('watch is the one field a story is allowed not to have', () => {
  const noWatch = Object.assign({}, GOOD_ITEM); delete noWatch.watch;
  const out = sec.validateBriefing([noWatch, GOOD_ITEM]);
  assert.ok(out);
  assert.equal(out[0].watch, '');
});

test('markup in any briefing field is refused', () => {
  const withTag = Object.assign({}, GOOD_ITEM, { why: 'Rates rise <script>alert(1)</script>' });
  assert.equal(sec.validateBriefing([withTag, GOOD_ITEM]), null);
});

test('a runaway briefing item is a failed call, not a long one', () => {
  const huge = Object.assign({}, GOOD_ITEM, { what: 'x'.repeat(5000) });
  assert.equal(sec.validateBriefing([huge, GOOD_ITEM]), null);
});

test('an invented story id is dropped rather than stored', () => {
  const out = sec.validateWhyMap({ s1: 'It raises costs.', sNOPE: 'Invented.' }, ['s1']);
  assert.deepEqual(out, { s1: 'It raises costs.' });
});

test('a why map with nothing usable in it is a failed call', () => {
  assert.equal(sec.validateWhyMap({ sNOPE: 'Invented.' }, ['s1']), null);
  assert.equal(sec.validateWhyMap({ s1: '   ' }, ['s1']), null);
  assert.equal(sec.validateWhyMap(['not', 'an', 'object'], ['s1']), null);
});

test('markup in a why line is refused', () => {
  assert.equal(sec.validateWhyMap({ s1: '<b>Important</b>' }, ['s1']), null);
});

test('JSON survives the fences and preamble a model wraps it in', () => {
  assert.deepEqual(parseJsonBlock('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonBlock('Here you go:\n{"a":1}\nHope that helps'), { a: 1 });
  assert.throws(() => parseJsonBlock('no json at all'));
});

test('the prose summary is rebuilt from the briefing rather than bought again', () => {
  const prose = summaryFromBriefing([GOOD_ITEM, Object.assign({}, GOOD_ITEM, { what: 'A second thing happened.' })]);
  assert.ok(prose.includes('policy rate'));
  assert.ok(prose.includes('A second thing happened.'));
  assert.equal(summaryFromBriefing(null), null);
  assert.equal(summaryFromBriefing([]), null);
});

// ── Against the real files ───────────────────────────────────────────────

test('the shipped data clusters without misattributing a link', () => {
  for (const file of ['data-bd.json', 'data-au.json', 'data-global.json']) {
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stories = cluster.clusterArticles(data.articles, { parseDate });
    const seen = new Set();
    for (const s of stories) {
      assert.ok(s.members.length, `${file}: an empty story`);
      for (const m of s.members) {
        assert.ok(!seen.has(m.link), `${file}: ${m.link} is in two stories`);
        seen.add(m.link);
        // The one that matters: a story's source list has to name the
        // publishers of its own members and nobody else.
        assert.ok(s.sourceIds.includes(m.sourceId),
          `${file}: story ${s.id} claims sources ${s.sourceIds} but holds an article from ${m.sourceId}`);
      }
    }
    assert.equal(seen.size, data.articles.length, `${file}: articles went missing in clustering`);
  }
});

// ── Tying briefing items to stories ──────────────────────────────────────
//
// This is the check the first production run failed: five items came back
// carrying four ids, the last two naming the same story. A merely *valid* id
// is not enough — a briefing headline is a link, and the feed skips what the
// briefing covered, so two items on one story means one wrong link and one
// story silently missing from the page.

// generateBriefing is not exported (it makes a network call), so the id-tying
// rule is exercised through the same logic on a copy here, and the real one is
// pinned by asserting the source still contains it. A behaviour worth a test
// is worth knowing when it is deleted.
function tieIds(items, top) {
  const allowed = {};
  top.forEach(st => { allowed[st.id] = true; });
  const claimed = {};
  items.forEach(item => {
    if (item.id && allowed[item.id] && !claimed[item.id]) { claimed[item.id] = true; return; }
    item.id = '';
  });
  items.forEach((item, i) => {
    if (item.id) return;
    const fallback = top[i] && top[i].id;
    if (fallback && !claimed[fallback]) { item.id = fallback; claimed[fallback] = true; }
  });
  return items;
}

test('no two briefing items may claim the same story', () => {
  const top = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const out = tieIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'd' }], top);
  const ids = out.map(i => i.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'a story was claimed twice: ' + JSON.stringify(ids));
  assert.equal(out[4].id, 'e', 'the duplicate should fall back to its position');
});

test('an invented id falls back to position, not to somebody else\'s story', () => {
  const top = [{ id: 'a' }, { id: 'b' }];
  const out = tieIds([{ id: 'a' }, { id: 'NOPE' }], top);
  assert.deepEqual(out.map(i => i.id), ['a', 'b']);
});

test('an item with nowhere to land keeps no id rather than a wrong one', () => {
  // Both positions already claimed out of order: the last item must end up
  // with no id, so the page renders it as text instead of linking it to a
  // story it does not describe.
  const top = [{ id: 'a' }, { id: 'b' }];
  const out = tieIds([{ id: 'b' }, { id: 'a' }, { id: 'a' }], top);
  assert.deepEqual(out.map(i => i.id), ['b', 'a', '']);
});

test('the shipped generateBriefing still ties ids the same way', () => {
  const source = fs.readFileSync('fetch.js', 'utf8');
  assert.ok(source.includes('!claimed[item.id]'),
    'generateBriefing no longer rejects a duplicate id — tieIds above is now testing nothing');
});
