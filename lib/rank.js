'use strict';
//
// Which stories matter, and what they are about.
//
// The feed used to be ordered by publication time, which answers "what came
// in last" rather than "what happened today". Those are different questions,
// and only the second one is worth a reader's morning. This module answers
// the second.
//
// Every factor here is structural — something the pipeline can observe about
// a story without being told. Deliberately absent is a per-publisher quality
// or trust score: there is no defensible basis for asserting that the SMH is
// worth 1.3 Daily Stars, and a number invented to look rigorous is worse than
// no number at all. What the pipeline *can* honestly observe is how many
// independent newsrooms judged the event worth covering, which is the
// corroboration factor below and is doing most of the work.

// ── Topics ───────────────────────────────────────────────────────────────
//
// Cheap and explainable: the publisher's own section from the URL path when
// it says something, keywords otherwise. This is a classification, not a
// judgement — "conflict" ranks above "sport" further down, and that ordering
// is the editorial claim, not this table.
var SECTION_TOPICS = {
  business: 'business', economy: 'economy', economics: 'economy', finance: 'business',
  markets: 'markets', money: 'business',
  politics: 'politics', government: 'politics', election: 'politics', elections: 'politics',
  world: 'world', international: 'world', 'australia-news': 'politics', 'us-news': 'world',
  technology: 'technology', tech: 'technology', science: 'science', environment: 'environment',
  climate: 'environment', health: 'health', sport: 'sport', sports: 'sport', football: 'sport',
  cricket: 'sport', entertainment: 'culture', culture: 'culture', lifestyle: 'culture',
  opinion: 'opinion', education: 'society', crime: 'society', law: 'society'
};

// Ordered: the first pattern that matches wins, so the narrower topics are
// listed before the broader ones. "Ceasefire talks hit the oil price" is a
// conflict story before it is a markets story.
var TOPIC_PATTERNS = [
  ['conflict',    /\b(?:war|wars|wartime|ceasefire|airstrike|airstrikes|missile|missiles|invasion|troops|militar\w*|insurgen\w*|militant\w*|hostage\w*|genocide|shelling|offensive|drone strike)\b/i],
  ['markets',     /\b(?:stock|stocks|shares|sharemarket|index|indices|bond|bonds|yield|yields|commodit\w*|crude|bullion|currenc\w*|forex|exchange rate|asx|dow|nasdaq|ftse|nikkei)\b/i],
  ['economy',     /\b(?:econom\w*|inflation|deflation|recession|gdp|unemploy\w*|interest rate|interest rates|central bank|monetary|fiscal|budget|deficit|surplus|tariff|tariffs|trade deficit|remittanc\w*|imf|world bank)\b/i],
  ['business',    /\b(?:compan\w*|business|businesses|firm|firms|profit|profits|earnings|revenue|merger|acquisition|takeover|ipo|startup|startups|layoff|layoffs|bankrupt\w*|export|exports|import|imports|factor\w*|manufactur\w*)\b/i],
  ['politics',    /\b(?:politic\w*|elect\w*|parliament|senate|congress|minister|president|prime minister|cabinet|governor|legislat\w*|referendum|coalition|opposition|polic\w*|sanction|sanctions|diplomat\w*|treaty|summit)\b/i],
  ['technology',  /\b(?:artificial intelligence|machine learning|software|semiconductor\w*|chipmaker|smartphone|cyber\w*|data breach|algorithm\w*|quantum|robot\w*|\bAI\b)/],
  ['science',     /\b(?:research\w*|scientist\w*|study finds|discover\w*|telescope|genome|physics|astronom\w*|neuroscien\w*|nasa|spacecraft)\b/i],
  ['environment', /\b(?:climate|emission\w*|carbon|renewable\w*|cyclone|flood\w*|drought|wildfire|bushfire|biodiversit\w*|pollution|heatwave|monsoon)\b/i],
  ['health',      /\b(?:health|hospital\w*|vaccin\w*|outbreak|pandemic|epidemic|disease|patients|dengue|cholera|pharma\w*)\b/i],
  ['society',     /\b(?:court|courts|lawsuit|verdict|police|arrest\w*|protest\w*|strike|strikes|school\w*|universit\w*|migrant\w*|refugee\w*|housing)\b/i],
  ['sport',       /\b(?:cricket|football|soccer|rugby|tennis|olympic\w*|world cup|match|batsman|goalkeeper|premier league|test series)\b/i]
];

// How much a topic contributes to a story's rank. This is an editorial
// position and nothing more: The Daily Digest is a current-affairs briefing,
// so a central-bank decision outranks a cricket result. Someone building a
// sports product would invert it, and should.
var TOPIC_WEIGHT = {
  conflict: 1.30, economy: 1.25, politics: 1.20, markets: 1.15, business: 1.10,
  world: 1.10, environment: 1.05, health: 1.05, science: 1.00, technology: 1.00,
  society: 0.95, culture: 0.75, opinion: 0.70, sport: 0.70, other: 0.90
};

// Publishers put the section in the article path: smh.com.au/politics/...
function sectionOf(link) {
  var m = String(link || '').match(/^https?:\/\/[^/]+\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function textOf(article) {
  var title = article.lang === 'bn' && typeof article.titleEn === 'string' && article.titleEn
    ? article.titleEn : article.title;
  var desc = article.lang === 'bn' && typeof article.descEn === 'string' && article.descEn
    ? article.descEn : article.desc;
  return String(title || '') + ' ' + String(desc || '');
}

function classify(article) {
  var section = SECTION_TOPICS[sectionOf(article.link)];
  if (section) return section;
  var text = textOf(article);
  for (var i = 0; i < TOPIC_PATTERNS.length; i++) {
    if (TOPIC_PATTERNS[i][1].test(text)) return TOPIC_PATTERNS[i][0];
  }
  return 'other';
}

// A story's topic is the one its members agree on most often. A tie goes to
// the heavier topic, so a story read as both "markets" and "economy" by
// different publishers is filed under the one that ranks higher — the same
// tie-break a desk editor would make.
function storyTopic(members) {
  var counts = Object.create(null);
  members.forEach(function (m) {
    var topic = m.topic || classify(m);
    counts[topic] = (counts[topic] || 0) + 1;
  });
  var best = 'other', bestCount = -1;
  Object.keys(counts).forEach(function (topic) {
    var n = counts[topic];
    if (n > bestCount || (n === bestCount && (TOPIC_WEIGHT[topic] || 0) > (TOPIC_WEIGHT[best] || 0))) {
      best = topic; bestCount = n;
    }
  });
  return best;
}

// ── Broker relevance (AU only) ──────────────────────────────────────────
//
// A separate axis from topic: "economy" already outranks "sport" for the
// general audience, but a rate story about US inflation is still not
// something an Australian mortgage broker's morning briefing should lead
// with over local lending news. This is deliberately narrow and additive —
// two tiers, not a spectrum — because a false negative here (a broker story
// scored 0) just drops out of a five-slot briefing silently, so precision
// matters more than recall.
//
// Two tiers: the strong list is unambiguously broker-specific (nothing else
// gets called "LMI" or "APRA"), the weak list is finance vocabulary that is
// broker-relevant only when it is *also* about the Australian home-lending
// market — "interest rate" alone is a global economy story as often as not.
var BROKER_STRONG_RE = /\b(?:mortgage\w*|home loan\w*|broker\w*|lend(?:er|ers|ing)|borrow(?:er|ers|ing)|refinanc\w*|APRA|ASIC|RBA|reserve bank|cash rate|LMI|lenders mortgage insurance|serviceability|offset account|redraw|stamp duty|first[\s-]home buyer\w*|non-bank lender\w*|aggregator\w*|macroprudential|responsible lending|construction finance)\b/i;
var BROKER_WEAK_RE = /\b(?:interest rate\w*|fixed rate\w*|variable rate\w*|property (?:market|price\w*)|house price\w*|housing (?:market|afford\w*)|auction clearance|credit polic\w*|net interest margin|bank\w* profit\w*)\b/i;

// 0 (drop it), 1 (weak — finance-adjacent) or 2 (strong — unambiguously a
// broker story). A story's text is every member's, not just the lead's: a
// story led by a generic "banks report earnings" headline can still be a
// mortgage story in its third paragraph, three publishers down.
function brokerRelevance(members) {
  var text = members.map(textOf).join(' ');
  if (BROKER_STRONG_RE.test(text)) return 2;
  if (BROKER_WEAK_RE.test(text)) return 1;
  return 0;
}

// Broker stories, most relevant first. Takes the region's already-ranked
// list (so recency/corroboration/burst are inherited rather than
// recomputed) and re-sorts to strong-relevance-first, breaking ties on the
// existing general-audience score; anything with no broker relevance at all
// is dropped rather than downweighted — a briefing slot given to an
// unrelated story defeats the point of a for-brokers mode.
function rankForBrokers(rankedStories) {
  return rankedStories
    .map(function (s) { return { story: s, relevance: brokerRelevance(s.members) }; })
    .filter(function (r) { return r.relevance > 0; })
    .sort(function (a, b) {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return b.story.score - a.story.score;
    })
    .map(function (r) { return r.story; });
}

// ── Ranking ──────────────────────────────────────────────────────────────

// Attention on a news story halves roughly over a working day. Long enough
// that this morning's lead survives until this evening's run, short enough
// that a three-day-old story does not hold the top of the page.
var HALF_LIFE_MS = 18 * 60 * 60 * 1000;

// Where corroboration stops adding much. The step from one source to two is
// the meaningful one — it is the difference between a claim and a confirmed
// event. Six sources instead of five says little extra, so the curve is
// logarithmic and this is its scale.
var CORROBORATION_BASE = 2;

function recencyFactor(latestMs, nowMs) {
  var age = Math.max(0, nowMs - latestMs);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

function corroborationFactor(sourceCount) {
  return 1 + Math.log(Math.max(1, sourceCount)) / Math.log(CORROBORATION_BASE);
}

// How concentrated the coverage is in time. Five outlets filing within six
// hours is a breaking event; the same five spread over three days is a
// running theme. The first belongs higher this morning.
function burstFactor(times, nowMs) {
  if (times.length < 2) return 1;
  var recent = times.filter(function (t) { return nowMs - t <= 24 * 60 * 60 * 1000; }).length;
  return 1 + 0.25 * (recent / times.length);
}

// Everything a story's position on the page rests on, returned alongside the
// number. The page does not show this today, but a rank nobody can explain is
// a rank nobody can debug — and "why is this the lead" is the first question
// anyone asks.
function scoreStory(story, nowMs, parseDate) {
  var times = story.members.map(function (m) {
    var t = parseDate ? parseDate(m.pubDate) : Date.parse(m.pubDate);
    return Number.isFinite(t) ? t : 0;
  }).filter(Boolean);
  var latest = times.length ? Math.max.apply(null, times) : 0;
  var topic = story.topic || storyTopic(story.members);

  var factors = {
    corroboration: corroborationFactor(story.sourceIds.length),
    recency:       recencyFactor(latest, nowMs),
    topic:         TOPIC_WEIGHT[topic] || TOPIC_WEIGHT.other,
    burst:         burstFactor(times, nowMs)
  };
  // Multiplicative, so a factor at its floor suppresses the story rather than
  // being outvoted: a week-old cricket round-up covered by four outlets
  // should not out-rank this morning's rate decision on volume alone.
  var score = factors.corroboration * factors.recency * factors.topic * factors.burst;
  return { score: score, topic: topic, factors: factors, latest: latest };
}

// Stories, most important first. Ties break on recency so the order is total
// and a run's output does not depend on object iteration order.
function rankStories(stories, nowMs, parseDate) {
  var scored = stories.map(function (s) {
    var r = scoreStory(s, nowMs, parseDate);
    return Object.assign({}, s, { score: r.score, topic: r.topic, factors: r.factors, latest: r.latest });
  });
  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.latest - a.latest;
  });
  return scored;
}

module.exports = {
  SECTION_TOPICS: SECTION_TOPICS,
  TOPIC_PATTERNS: TOPIC_PATTERNS,
  TOPIC_WEIGHT: TOPIC_WEIGHT,
  HALF_LIFE_MS: HALF_LIFE_MS,
  sectionOf: sectionOf,
  classify: classify,
  storyTopic: storyTopic,
  recencyFactor: recencyFactor,
  corroborationFactor: corroborationFactor,
  burstFactor: burstFactor,
  scoreStory: scoreStory,
  rankStories: rankStories,
  brokerRelevance: brokerRelevance,
  rankForBrokers: rankForBrokers
};
