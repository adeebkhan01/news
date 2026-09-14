'use strict';
//
// One event, many publishers.
//
// Five outlets covering the same cabinet decision is one story, not five
// cards. Grouping them is the difference between an RSS mirror and something
// that has read the feed: the reader sees the event once, with the fact that
// four other newsrooms confirmed it — which is itself the most useful thing
// on the card.
//
// The method is deliberately dull and offline: no model call, no embedding
// service, nothing that can fail halfway through a run or cost money per
// article. Titles are turned into IDF-weighted token vectors and compared by
// cosine similarity. IDF is what makes it work at all: "Bangladesh Bank
// raises policy rate" and "Policy rate raised by Bangladesh Bank" share the
// rare tokens, while two unrelated pieces sharing only "government" and
// "says" do not clear the bar, because those tokens are worth almost nothing
// in a corpus of news headlines.
//
// It is a heuristic, and it is tuned to under-merge. A story split in two
// reads as two stories, which is what the page does today. A wrong merge
// puts one publisher's headline over another publisher's link, which is a
// misattribution — much worse, and the reason for the corroboration rule and
// the second-rare-token requirement below.

// Words that appear in a large share of headlines and so carry no signal
// about *which* story this is. Kept short on purpose: IDF already discounts
// common words, and this list only has to catch the ones frequent enough to
// distort the vector norms.
var STOPWORDS = new Set(('a an the and or but if then than that this these those of in on at to for from by with '
  + 'as is are was were be been being has have had do does did will would can could may might must shall should '
  + 'it its it\'s he she they them his her their we our you your i me my not no nor so such about into over under '
  + 'after before during while when where who whom which what why how all any both each few more most other some '
  + 'up down out off again further once here there very just also new news says said say report reports reported '
  + 'amid amid’st live update updates latest video watch photos photo opinion analysis explainer').split(' '));

// Letters and digits in any script, so a Bangla headline tokenises as well as
// an English one. Apostrophes inside a word are kept — "australia's" and
// "australias" should not be two different tokens, and the trailing 's is
// stripped below.
//
// \p{M} is not decoration here. Bengali vowel signs are combining marks, not
// letters, so a class of \p{L}\p{N} alone splits বাংলাদেশ into ব, ল, দ, শ —
// five one-character tokens, every one of them below the minimum length, and
// a Bangla headline tokenises to nothing at all. Every Bangla story was its
// own cluster until this character class included marks.
var TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’]*/gu;

// A token has to be this long to count, unless it is all digits (a year, a
// figure) or an acronym the original text capitalised (AI, UN, GDP). Short
// lowercase fragments are noise.
var MIN_TOKEN_LEN = 3;

// How far apart two articles may be published and still be the same event.
// News cycles run longer than a day — a Sunday decision is still being
// covered on Tuesday — but a fortnight apart is a follow-up, not the same
// story, and merging those would put a stale headline on a fresh card.
var WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

// Cosine similarity over IDF-weighted tokens. Chosen by reading the merges it
// produces over the three real data files rather than derived from anything:
// at 0.42 it found 15 multi-source stories in a month of global news and
// missed obvious same-day duplicates; at 0.24 it began joining an analysis
// piece to the event it analysed. At 0.30 every merge across all three
// regions was the same event, which is the property worth protecting.
var THRESHOLD = 0.30;

// Two headlines about the same event share more than one distinctive word.
// A single shared rare token is a coincidence — one unusual surname, one
// place name — and this is what stops that coincidence becoming a merge.
var MIN_SHARED_TOKENS = 2;

// A shared token is only evidence if it is rare, and "rare" has to be read
// against the corpus rather than fixed: an absolute IDF floor is unreachable
// in a corpus of five documents, where the rarest possible token still
// appears in a fifth of them, so small inputs could never merge anything at
// all. The floor is expressed as the document frequency a shared token may
// have — a token in more than this share of the headlines says nothing about
// which story a headline is — and converted to an IDF at clustering time.
var MAX_SHARED_DF_RATIO = 0.15;

// ...with a floor, so a handful of articles still has a notion of rare.
var MAX_SHARED_DF_FLOOR = 2;

function minTopIdf(documentCount) {
  var maxDf = Math.max(MAX_SHARED_DF_FLOOR, Math.floor(documentCount * MAX_SHARED_DF_RATIO));
  return Math.log(1 + documentCount / maxDf);
}

// The text a headline is compared on. For a Bangla article the English
// translation is used when it exists, so a Bangla report and an English one
// about the same event can still meet — they share no characters otherwise.
function comparableText(article) {
  var title = article.lang === 'bn' && typeof article.titleEn === 'string' && article.titleEn
    ? article.titleEn : article.title;
  var desc = article.lang === 'bn' && typeof article.descEn === 'string' && article.descEn
    ? article.descEn : article.desc;
  // The description is included at a discount by being truncated: it helps
  // when two headlines are written very differently, and hurts when a feed
  // pads every item with the same boilerplate.
  return String(title || '') + ' ' + String(desc || '').slice(0, 160);
}

function tokenize(text) {
  var raw = String(text || '').match(TOKEN_RE) || [];
  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < raw.length; i++) {
    var word = raw[i];
    var isAcronym = word.length >= 2 && word === word.toUpperCase() && /[\p{Lu}]/u.test(word);
    var lower = word.toLowerCase().replace(/['’]s$/, '');
    if (!lower) continue;
    if (STOPWORDS.has(lower)) continue;
    if (lower.length < MIN_TOKEN_LEN && !isAcronym && !/^\d+$/.test(lower)) continue;
    // Each token counts once per article. Headlines are short enough that a
    // repeated word says nothing, and term frequency would let a title that
    // says "trade" three times dominate its own vector.
    if (seen[lower]) continue;
    seen[lower] = true;
    out.push(lower);
  }
  return out;
}

// Inverse document frequency across the articles being clustered, which is
// the right corpus: "cyclone" is rare in global news and unremarkable in a
// Bangladesh feed during the season, and the weighting should reflect that.
function buildIdf(tokenLists) {
  var df = Object.create(null);
  tokenLists.forEach(function (tokens) {
    tokens.forEach(function (tok) { df[tok] = (df[tok] || 0) + 1; });
  });
  var n = Math.max(1, tokenLists.length);
  var idf = Object.create(null);
  Object.keys(df).forEach(function (tok) {
    // +1 inside the log keeps a token appearing in every document at a small
    // positive weight rather than exactly zero, so a vector made entirely of
    // common words still has a norm and does not divide by zero.
    idf[tok] = Math.log(1 + n / df[tok]);
  });
  return idf;
}

function vectorFor(tokens, idf) {
  var vec = Object.create(null);
  var norm = 0;
  tokens.forEach(function (tok) {
    var w = idf[tok] || 0;
    if (!w) return;
    vec[tok] = w;
    norm += w * w;
  });
  return { weights: vec, norm: Math.sqrt(norm) };
}

// Cosine, plus the two pieces of evidence the caller needs to accept it: how
// many tokens were shared and how rare the rarest of them was.
function compare(a, b) {
  if (!a.norm || !b.norm) return { score: 0, shared: 0, topIdf: 0 };
  var small = Object.keys(a.weights).length <= Object.keys(b.weights).length ? a : b;
  var large = small === a ? b : a;
  var dot = 0, shared = 0, topIdf = 0;
  Object.keys(small.weights).forEach(function (tok) {
    var w = large.weights[tok];
    if (w === undefined) return;
    dot += small.weights[tok] * w;
    shared++;
    if (w > topIdf) topIdf = w;
  });
  return { score: dot / (a.norm * b.norm), shared: shared, topIdf: topIdf };
}

// A stable id for a story, derived from the link of its earliest member. It
// has to survive a run: the same story gaining a sixth publisher must keep
// the id it had, or every cached "why this matters" line is thrown away and
// re-bought from the model. The earliest member is the one part of a growing
// cluster that does not change.
function storyId(link) {
  var h = 2166136261;
  var s = String(link || '');
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 's' + h.toString(36);
}

function timeOf(article, parseDate) {
  var t = parseDate ? parseDate(article.pubDate) : Date.parse(article.pubDate);
  return Number.isFinite(t) ? t : 0;
}

// Greedy single-pass agglomeration, newest first.
//
// Every article is compared only against clusters that already contain one of
// its tokens — an inverted index, not because the corpus is huge but because
// the naive version is quadratic in articles and these files hold a month of
// them. The result is identical; only the work avoided differs.
//
// Newest-first matters for attribution: the first member of a cluster becomes
// its lead, and the freshest coverage is the one worth linking to.
function clusterArticles(articles, options) {
  var opts = options || {};
  var threshold = opts.threshold === undefined ? THRESHOLD : opts.threshold;
  var windowMs = opts.windowMs === undefined ? WINDOW_MS : opts.windowMs;
  var parseDate = opts.parseDate;

  var items = articles.map(function (a) {
    return { article: a, tokens: tokenize(comparableText(a)), time: timeOf(a, parseDate) };
  });
  var idf = buildIdf(items.map(function (i) { return i.tokens; }));
  var idfFloor = minTopIdf(Math.max(1, items.length));

  var order = items.slice().sort(function (x, y) { return y.time - x.time; });
  var clusters = [];
  var index = Object.create(null);   // token -> cluster indices that contain it

  order.forEach(function (item) {
    var vec = vectorFor(item.tokens, idf);

    var candidates = Object.create(null);
    item.tokens.forEach(function (tok) {
      var list = index[tok];
      if (!list) return;
      for (var i = 0; i < list.length; i++) candidates[list[i]] = true;
    });

    var bestIdx = -1, bestScore = 0;
    Object.keys(candidates).forEach(function (key) {
      var c = clusters[key];
      // The window is measured against the cluster's newest member, so a
      // story can grow forward day by day without any one pair ever being
      // more than the window apart.
      if (Math.abs(c.latest - item.time) > windowMs) return;
      var cmp = compare(vec, c.vec);
      if (cmp.score < threshold) return;
      if (cmp.shared < MIN_SHARED_TOKENS) return;
      if (cmp.topIdf < idfFloor) return;
      if (cmp.score > bestScore) { bestScore = cmp.score; bestIdx = Number(key); }
    });

    if (bestIdx === -1) {
      var created = {
        members: [item.article],
        times: [item.time],
        vec: vec,
        tokens: item.tokens.slice(),
        latest: item.time,
        earliest: item.time,
        earliestLink: item.article.link
      };
      clusters.push(created);
      var newIdx = clusters.length - 1;
      item.tokens.forEach(function (tok) {
        (index[tok] || (index[tok] = [])).push(newIdx);
      });
      return;
    }

    var c = clusters[bestIdx];
    c.members.push(item.article);
    c.times.push(item.time);
    if (item.time > c.latest) c.latest = item.time;
    if (item.time < c.earliest) { c.earliest = item.time; c.earliestLink = item.article.link; }
    // The cluster's vector absorbs the new member's tokens at their existing
    // weight rather than being averaged. A story described three slightly
    // different ways should be reachable by all three descriptions.
    var changed = [];
    item.tokens.forEach(function (tok) {
      if (c.vec.weights[tok] !== undefined) return;
      var w = idf[tok] || 0;
      if (!w) return;
      c.vec.weights[tok] = w;
      c.tokens.push(tok);
      changed.push(tok);
    });
    c.vec.norm = Math.sqrt(Object.keys(c.vec.weights).reduce(function (sum, tok) {
      return sum + c.vec.weights[tok] * c.vec.weights[tok];
    }, 0));
    changed.forEach(function (tok) { (index[tok] || (index[tok] = [])).push(bestIdx); });
  });

  return clusters.map(function (c) {
    // Members newest first, so members[0] is the lead: the freshest telling
    // of the story is the one the card links to.
    var members = c.members.slice().sort(function (x, y) {
      return timeOf(y, parseDate) - timeOf(x, parseDate);
    });
    var sourceIds = [];
    members.forEach(function (m) {
      if (sourceIds.indexOf(m.sourceId) === -1) sourceIds.push(m.sourceId);
    });
    return {
      id: storyId(c.earliestLink),
      members: members,
      sourceIds: sourceIds,
      latest: c.latest,
      earliest: c.earliest,
      tokens: c.tokens
    };
  });
}

module.exports = {
  STOPWORDS: STOPWORDS,
  WINDOW_MS: WINDOW_MS,
  THRESHOLD: THRESHOLD,
  MIN_SHARED_TOKENS: MIN_SHARED_TOKENS,
  MAX_SHARED_DF_RATIO: MAX_SHARED_DF_RATIO,
  minTopIdf: minTopIdf,
  comparableText: comparableText,
  tokenize: tokenize,
  buildIdf: buildIdf,
  vectorFor: vectorFor,
  compare: compare,
  storyId: storyId,
  clusterArticles: clusterArticles
};
