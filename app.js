'use strict';
let allArticles  = [];
let allSources   = [];
let activeFilter = 'all';
let activeTopic  = 'all';
let searchQuery  = '';
let loading      = false;
let langMode     = localStorage.getItem('news-lang') === 'bn' ? 'bn' : 'en';
let activeRegion = localStorage.getItem('news-region') || 'bd';
let searchTimer  = null;
let readLinks    = loadReadLinks();  // links the reader has already clicked into, this browser only
let briefingEn   = [];     // [{ id, headline, what, why, watch }]
let briefingBn   = [];
let briefFull    = false;  // the briefing's two depths: headline + why, or the whole item
let briefOpenSet = new Set();  // indices of items expanded one at a time, while briefFull is false
let storyById    = {};     // story id -> the record fetch.js published
let storyByLead  = {};     // the link of a story's freshest member -> that story
let articleByLink = {};    // link -> article, so a story can name its members
let feedOrder    = localStorage.getItem('news-order') === 'latest' ? 'latest' : 'top';
// AU only. 'general' or 'broker' — a different top-story selection and
// briefing over the same au articles, not a different region.
let briefMode    = localStorage.getItem('news-briefmode') === 'broker' ? 'broker' : 'general';
let dateScope    = localStorage.getItem('news-scope') === 'all' ? 'all' : 'today';
let changedSince = null;   // the date the "new"/"developing" markers are measured against
let droppedItems = [];     // stories that were on that day's briefing and are not on today's
let archiveDates = [];     // dates the current region's database has a snapshot for, newest first
let viewDate     = null;   // null is today's live data; a YYYY-MM-DD is an archived briefing
let archiveSnap  = null;   // the snapshot being viewed, when viewDate is set
let fetchedAt    = null;   // the Date, not a formatted string: the format is language-dependent
let SQL          = null;   // the sql.js module, loaded once and reused across region switches
let dbHandle     = null;   // the currently open sql.js Database — one region's whole database

const PAGE_SIZE = 24;

// Below the lead, the next few cards are given more weight than the rest.
// Twenty cards of identical size is a list, not a front page: the reader has
// to read all twenty to find out which one matters, which is exactly the work
// the ranking was supposed to do for them.
const SECONDARY_COUNT = 4;

// How many stories the ranked view shows before it stops.
//
// The feed holds a month — around 1,300 stories — and an infinite scroll over
// them is the instinct this product is supposed to resist: comprehensiveness
// is what an RSS reader already gives you, and it is why reading one takes
// all morning. Top stories is an answer to "what matters today", and past
// thirty the honest answer is "nothing else, and Latest has the rest".
const TOP_STORIES_SHOWN = 30;
let visibleArticles = [];
let renderedCount   = 0;
let featuredIndex   = -1;
let feedObserver    = null;
let feedIsCapped    = false;

// A browser-local reading history, not a synced account: the point is
// letting a returning reader see what's new since their last visit, and a
// month of clicked links is plenty for that without growing unbounded.
const READ_CAP = 500;

function loadReadLinks() {
  try { return new Set(JSON.parse(localStorage.getItem('news-read') || '[]')); }
  catch (e) { return new Set(); }
}

function markRead(link) {
  if (!link || readLinks.has(link)) return;
  readLinks.add(link);
  // Set iteration order is insertion order, so the first value is the oldest.
  if (readLinks.size > READ_CAP) readLinks.delete(readLinks.values().next().value);
  try { localStorage.setItem('news-read', JSON.stringify(Array.from(readLinks))); }
  catch (e) {}
}

// hasLang mirrors `translate` in fetch.js: it says the region's data file
// carries Bangla, not that every article in it does. A region whose backlog is
// still draining renders untranslated articles in English either way.
const REGION_CONFIG = {
  bd:     { mark: 'BD', flag: '\u{1F1E7}\u{1F1E9}', dbFile: 'data-bd.sqlite',     hasLang: true },
  au:     { mark: 'AU', flag: '\u{1F1E6}\u{1F1FA}', dbFile: 'data-au.sqlite',     hasLang: true },
  global: { mark: 'GL', flag: '\u{1F30F}',           dbFile: 'data-global.sqlite', hasLang: true },
  np:     { mark: 'NP', flag: '\u{1F1F3}\u{1F1F5}', dbFile: 'data-np.sqlite',     hasLang: true }
};

/* ── Language ──────────────────────────────────────────────────────────
   The page's own words are fixed, so they are translated once, here, and
   cost nothing at run time. Only the articles go through the model, and
   only once each, in whichever direction they need.

   Every key must exist in both dictionaries; a test asserts it, because a
   missing key would silently render English inside a Bangla page. */
const STRINGS = {
  en: {
    skipToHeadlines: 'Skip to headlines',
    switchLanguage:  'Switch language',
    themeDay:        'Day',
    themeNight:      'Night',
    fetching:        'Fetching',
    region:          'Region',
    regionBd:        'Bangladesh',
    regionAu:        'Australia',
    regionGlobal:    'Global',
    regionNp:        'Nepal',
    search:          'Search',
    filterHeadlines: 'Filter headlines',
    clearSearch:     'Clear search',
    filterBySource:  'Filter by source',
    allSources:      'All sources',
    filterByTopic:   'Filter by topic',
    allTopics:       'All topics',
    whatHappened:    'What happened',
    whyItMatters:    'Why this matters',
    whatToWatch:     'What to watch',
    briefShowFull:   'Expand all',
    briefShowShort:  'Collapse all',
    readMore:        'Read more',
    showLess:        'Show less',
    orderTop:        'Top stories',
    orderLatest:     'Latest',
    dateScope:       'Date range',
    scopeToday:      'Today',
    scopeAll:        'All time',
    briefMode:       'Briefing mode',
    briefModeGeneral:'General',
    briefModeBroker: 'For brokers',
    briefBrokerEmptyTitle: 'No broker briefing yet',
    briefBrokerEmptyBody:  'This region’s next scheduled update will include one.',
    coveredBy:       'Covered by {n} sources',
    sourceCount:     '{n} sources',
    sourceCountParen:'({n} sources)',
    droppedHeading:  'Off the briefing since {date}',
    archive:         'Archive',
    archiveOlder:    'Older',
    archiveNewer:    'Newer',
    archiveToday:    'Today',
    archiveBackToToday:'Back to today',
    archiveViewing:  'Archived briefing \u00B7 {date}',
    archiveStories:  'Top stories on {date}',
    archiveMissing:  'No briefing was archived for {date}.',
    archiveHint:     'The archive keeps each day\u2019s briefing and its top stories, not the full feed.',
    singleSource:    'Single-source report',
    alsoReported:    'Also reported by',
    runningFor:      'running {n}h, first filed {from}',
    reportCount:     '{n} reports',
    reportCountOne:  '{n} report',
    headlines:       'Headlines',
    latest:          'Latest',
    backToTop:       'Back to top',
    statusLive:      'Live',
    statusLoading:   'Loading',
    statusFailed:    'Failed',
    articleCount:    '{n} articles',
    articleCountOne: '{n} article',
    leadStory:       'Lead story',
    readArrow:       'Read \u2192',
    noImage:         'No image \u00B7 {source}',
    imageUnavailable:'Image unavailable',
    untitled:        'Untitled',
    unknownSource:   'Unknown',
    shownOfTotal:    '{n} / {total} shown',
    endOfFeed:       'End of feed \u00B7 {n} shown',
    endOfTop:        'That is the day \u00B7 top {n} stories \u00B7 everything else in',
    emptyTitle:      'Nothing here yet',
    emptySearch:     'No headlines match \u201C{query}\u201D. Widen the term or clear the filter.',
    emptySource:     'This source has published nothing in the retained window. Pick another source or region.',
    emptyToday:      'Nothing published today yet. Switch to All time to see the full retained window.',
    emptyTopic:      'Nothing tagged {topic} in this window. Pick another topic, source, or region.',
    errorTitle:      'No data file',
    errorBody:       '{file} did not load: {message}.',
    errorHint:       'Run the Fetch RSS Feeds workflow in Actions, then reload.',
    fetchedAt:       'Fetched {time}',
    justNow:         'just now',
    minutesAgo:      '{n}m ago',
    hoursAgo:        '{n}h ago',
    daysAgo:         '{n}d ago',
    siteTitle:       'AK\u2019s Daily Digest \u2014 {region}',
    footerRegions:   'AK\u2019s Daily Digest \u2014 Bangladesh, Australia, Nepal, Global',
    footerRefresh:   'Refreshed twice daily via GitHub Actions',
    footerLast:      'Refreshed twice daily via GitHub Actions \u2014 last {time}'
  },
  bn: {
    skipToHeadlines: 'শিরোনামে যান',
    switchLanguage:  'ভাষা বদলান',
    themeDay:        'দিন',
    themeNight:      'রাত',
    fetching:        'আনা হচ্ছে',
    region:          'অঞ্চল',
    regionBd:        'বাংলাদেশ',
    regionAu:        'অস্ট্রেলিয়া',
    regionGlobal:    'বিশ্ব',
    regionNp:        'নেপাল',
    search:          'খোঁজ',
    filterHeadlines: 'শিরোনাম ছাঁকুন',
    clearSearch:     'খোঁজ মুছুন',
    filterBySource:  'উৎস অনুযায়ী ছাঁকুন',
    allSources:      'সব উৎস',
    filterByTopic:   'বিষয় অনুযায়ী ছাঁকুন',
    allTopics:       'সব বিষয়',
    whatHappened:    'যা ঘটেছে',
    whyItMatters:    'কেন গুরুত্বপূর্ণ',
    whatToWatch:     'যা লক্ষ্য রাখবেন',
    briefShowFull:   'সব বিস্তারিত',
    briefShowShort:  'সব সংক্ষিপ্ত',
    readMore:        'আরও পড়ুন',
    showLess:        'কম দেখান',
    orderTop:        'প্রধান খবর',
    orderLatest:     'সর্বশেষ',
    dateScope:       'সময়সীমা',
    scopeToday:      'আজ',
    scopeAll:        'সর্বকাল',
    briefMode:       'সারসংক্ষেপ মোড',
    briefModeGeneral:'সাধারণ',
    briefModeBroker: 'ব্রোকারদের জন্য',
    briefBrokerEmptyTitle: 'ব্রোকার সারসংক্ষেপ এখনো নেই',
    briefBrokerEmptyBody:  'এই অঞ্চলের পরবর্তী নির্ধারিত আপডেটে এটি থাকবে।',
    coveredBy:       '{n}টি উৎসে প্রকাশিত',
    sourceCount:     '{n}টি উৎস',
    sourceCountParen:'({n}টি উৎস)',
    droppedHeading:  '{date} থেকে সারসংক্ষেপের বাইরে',
    archive:         'আর্কাইভ',
    archiveOlder:    'আগের',
    archiveNewer:    'পরের',
    archiveToday:    'আজ',
    archiveBackToToday:'আজকে ফিরে যান',
    archiveViewing:  'আর্কাইভ করা সারসংক্ষেপ \u00B7 {date}',
    archiveStories:  '{date} তারিখের প্রধান খবর',
    archiveMissing:  '{date} তারিখের জন্য কোনো সারসংক্ষেপ সংরক্ষিত হয়নি।',
    archiveHint:     'আর্কাইভে প্রতিদিনের সারসংক্ষেপ ও প্রধান খবর থাকে, পুরো ফিড নয়।',
    singleSource:    'একটি উৎসের খবর',
    alsoReported:    'আরও প্রকাশ করেছে',
    runningFor:      '{n} ঘণ্টা ধরে, প্রথম প্রকাশ {from}',
    reportCount:     '{n}টি প্রতিবেদন',
    reportCountOne:  '{n}টি প্রতিবেদন',
    headlines:       'শিরোনাম',
    latest:          'সর্বশেষ',
    backToTop:       'উপরে ফিরুন',
    statusLive:      'সরাসরি',
    statusLoading:   'লোড হচ্ছে',
    statusFailed:    'ব্যর্থ',
    articleCount:    '{n}টি নিবন্ধ',
    articleCountOne: '{n}টি নিবন্ধ',
    leadStory:       'প্রধান খবর',
    readArrow:       'পড়ুন \u2192',
    noImage:         'ছবি নেই \u00B7 {source}',
    imageUnavailable:'ছবি পাওয়া যায়নি',
    untitled:        'শিরোনামহীন',
    unknownSource:   'অজানা',
    shownOfTotal:    '{n} / {total} দেখানো হয়েছে',
    endOfFeed:       'ফিডের শেষ \u00B7 {n}টি দেখানো হয়েছে',
    endOfTop:        'আজকের খবর শেষ \u00B7 শীর্ষ {n}টি \u00B7 বাকি সব দেখুন',
    emptyTitle:      'এখানে এখনও কিছু নেই',
    emptySearch:     '\u201C{query}\u201D-এর সঙ্গে কোনো শিরোনাম মেলেনি। শব্দটি বড় করুন বা ছাঁকনি মুছুন।',
    emptySource:     'এই উৎস সংরক্ষিত সময়সীমার মধ্যে কিছু প্রকাশ করেনি। অন্য উৎস বা অঞ্চল বেছে নিন।',
    emptyToday:      'আজ এখনও কিছু প্রকাশিত হয়নি। পুরো সংরক্ষিত সময়সীমা দেখতে সর্বকাল-এ যান।',
    emptyTopic:      'এই সময়সীমায় {topic} বিষয়ে কিছু নেই। অন্য বিষয়, উৎস বা অঞ্চল বেছে নিন।',
    errorTitle:      'কোনো ডেটা ফাইল নেই',
    errorBody:       '{file} লোড হয়নি: {message}।',
    errorHint:       'Actions-এ Fetch RSS Feeds ওয়ার্কফ্লো চালান, তারপর পৃষ্ঠাটি রিলোড করুন।',
    fetchedAt:       'সংগৃহীত {time}',
    justNow:         'এইমাত্র',
    minutesAgo:      '{n} মিনিট আগে',
    hoursAgo:        '{n} ঘণ্টা আগে',
    daysAgo:         '{n} দিন আগে',
    siteTitle:       'AK-এর ডেইলি ডাইজেস্ট \u2014 {region}',
    footerRegions:   'AK-এর ডেইলি ডাইজেস্ট \u2014 বাংলাদেশ, অস্ট্রেলিয়া, নেপাল, বিশ্ব',
    footerRefresh:   'GitHub Actions-এ দিনে দুইবার হালনাগাদ',
    footerLast:      'GitHub Actions-এ দিনে দুইবার হালনাগাদ \u2014 সর্বশেষ {time}'
  }
};

// Publishers' own names, as a Bangla reader would see them in print. Kept out
// of the data files so a rename is one edit here rather than a refetch.
//
// A retired source keeps its entry: its articles stay in the data file for the
// 30-day retention window, and they still need a name while they age out.
const SOURCE_NAMES_BN = {
  dailystar: 'দ্য ডেইলি স্টার', prothomalo: 'প্রথম আলো',   risingbd: 'রাইজিংবিডি',
  dhakatribune: 'ঢাকা ট্রিবিউন', newage: 'নিউ এজ',          unb: 'ইউএনবি',
  amardesh: 'আমার দেশ',         btv: 'বিটিভি',
  abcnews: 'এবিসি নিউজ',        guardianau: 'দ্য গার্ডিয়ান অস্ট্রেলিয়া',
  smh: 'সিডনি মর্নিং হেরাল্ড',   conversationau: 'দ্য কনভারসেশন অস্ট্রেলিয়া',
  bbcnews: 'বিবিসি নিউজ',       aljazeera: 'আল জাজিরা',    guardian: 'দ্য গার্ডিয়ান',
  npr: 'এনপিআর',                france24: 'ফ্রান্স ২৪',      dwnews: 'ডয়চে ভেলে',
  cnn: 'সিএনএন',                bloomberg: 'ব্লুমবার্গ',     pewresearch: 'পিউ রিসার্চ',
  kathmandupost: 'দ্য কাঠমান্ডু পোস্ট', himalayantimes: 'দ্য হিমালয়ান টাইমস',
  onlinekhabar: 'অনলাইনখবর'
};

const LOCALE = { en: 'en-GB', bn: 'bn-BD' };

// Interpolation is {name}, and every value is substituted as plain text — the
// result only ever reaches the page through textContent.
function t(key, vars) {
  let out = (STRINGS[langMode] && STRINGS[langMode][key]) || STRINGS.en[key] || key;
  if (vars) Object.keys(vars).forEach(k => { out = out.split('{' + k + '}').join(String(vars[k])); });
  return out;
}

// Bengali numerals when the page is in Bangla, grouped the way the locale
// groups them.
function num(n) {
  try { return Number(n).toLocaleString(LOCALE[langMode]); }
  catch (e) { return String(n); }
}

function regionLabel(id) {
  return t(id === 'bd' ? 'regionBd' : id === 'au' ? 'regionAu' : id === 'np' ? 'regionNp' : 'regionGlobal');
}

function sourceLabel(article) {
  if (langMode === 'bn') {
    const bn = SOURCE_NAMES_BN[article.sourceId];
    if (bn) return bn;
  }
  return article.sourceName || t('unknownSource');
}

// The article's own text, or its translation, whichever matches the selected
// language — falling back to whatever exists rather than showing nothing.
// `false` in a translated field means the model answered unusably.
function pick(article, field) {
  const own = article.lang || 'en';
  if (langMode === own) return article[field] || '';
  const other = article[field + (langMode === 'bn' ? 'Bn' : 'En')];
  return (typeof other === 'string' && other) ? other : (article[field] || '');
}

// An archived story's headline in the selected language — same fallback
// logic as pick(), applied to snapshot_stories rows instead of articles.
function archiveHeadline(st) {
  const own = st.lang || 'en';
  if (langMode === own) return st.headline || '';
  const other = langMode === 'bn' ? st.headlineBn : st.headlineEn;
  return other || st.headline || '';
}

// Which language pick() actually returned, which is not always the one
// selected: a Bangla article with no English translation yet stays Bangla.
function shownLang(article) {
  const own = article.lang || 'en';
  if (langMode === own) return own;
  const other = article['title' + (langMode === 'bn' ? 'Bn' : 'En')];
  return (typeof other === 'string' && other) ? langMode : own;
}

/* ── Theme ── */
// Which question the feed is answering: what matters today, or what came in
// last. Both are legitimate and the reader gets to choose, but only one can be
// the default, and "what matters" is the product.
function setFeedOrder(order) {
  feedOrder = order === 'latest' ? 'latest' : 'top';
  localStorage.setItem('news-order', feedOrder);
  renderArticles();
}

// Today vs the whole retention window. A "Daily Digest" whose front page
// quietly draws from a month of stories is answering a question the reader
// didn't ask — this is the explicit choice between the two.
function setDateScope(scope) {
  dateScope = scope === 'all' ? 'all' : 'today';
  localStorage.setItem('news-scope', dateScope);
  applyDateScope();
  renderArticles();
}

function applyDateScope() {
  document.querySelectorAll('#scope-switch .scope-btn').forEach(btn => {
    const on = btn.dataset.scope === dateScope;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// Today's articles, by the same UTC calendar day daysForRegion uses to
// decide what counts as "today" for the archive nav — one definition of
// the boundary, not two that can quietly drift apart.
function isFromToday(pubDate) {
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function applyThemeLabel() {
  // The button names what it will do, so no icon has to be invented.
  document.getElementById('theme-label').textContent =
    t(document.documentElement.getAttribute('data-theme') === 'night' ? 'themeDay' : 'themeNight');
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'night' ? 'day' : 'night';

  root.classList.add('theme-switch');
  root.setAttribute('data-theme', next);
  applyThemeLabel();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.remove('theme-switch');
    localStorage.setItem('news-theme', next);
  }));
}
applyThemeLabel();

/* Status is always a glyph and a colour, never colour alone. */
const STATUS_GLYPH = { ok: '\u25CF', warn: '\u25B2', err: '\u2715' };
const STATUS_WORD  = { ok: 'statusLive', warn: 'statusLoading', err: 'statusFailed' };

// The kind is kept rather than the rendered words, because the language can
// change after the status was set and the line has to be able to say the same
// thing again in the other one. Storing "Live" would have left it in English
// on a Bangla page — which is exactly what it did.
let statusKind = 'warn';
let statusDetail = () => '';

function setStatus(kind, detail) {
  statusKind = kind;
  statusDetail = detail || (() => '');
  renderStatus();
}

function renderStatus() {
  const strip = document.getElementById('status-strip');
  strip.className = 'status-strip' + (statusKind === 'ok' ? '' : ' ' + statusKind);
  strip.textContent = STATUS_GLYPH[statusKind] + ' ' + t(STATUS_WORD[statusKind]);
  // When everything is fine the detail is the region name, which the selected
  // tab, the masthead and the briefing panel all already say. It earns its
  // place only when it is telling you something you cannot see: what is
  // loading, or what failed.
  const detail = document.getElementById('status-text');
  detail.textContent = statusDetail();
  detail.hidden = statusKind === 'ok';
}

/* ── Helpers ── */
// Older data files were written before the feed parser learned to decode
// entities before stripping, so they still carry <p>, <br> and href URLs in
// the copy. Clean it at render time too, rather than waiting on a refetch.
function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function plainText(str) {
  let s = String(str == null ? '' : str);
  for (let i = 0; i < 3; i++) {
    const next = decodeEntities(s).replace(/<[^>]*>/g, ' ')
      .replace(/<[^>]*$/, ' ');   // descriptions get truncated mid-tag
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim();
}

// fetch.js refuses anything but https before it writes the data file, so this
// is the second of two independent checks rather than the only one. It returns
// the URL unescaped: everything downstream sets it with setAttribute, which
// does not re-parse it as markup.
function safeURL(url) {
  const raw = String(url || '').trim();
  return /^https:\/\//i.test(raw) ? raw : '';
}

// Article art is downloaded and committed by the fetch pipeline, not
// hotlinked from a publisher — so instead of an https:// check this matches
// the exact shape fetch.js writes (images/<region>/<40 hex chars>.<ext>),
// same-origin and nothing else. Anything that doesn't fit that shape (a
// leftover external URL on a row from before this existed, still working
// through the backfill queue) is treated as no image at all rather than
// requested.
function safeImagePath(path) {
  const raw = String(path || '').trim();
  return /^images\/[a-z]+\/[0-9a-f]{20,40}\.(?:jpg|jpeg|png|webp|gif)$/i.test(raw) ? raw : '';
}

// ── DOM helpers ──────────────────────────────────────────────────────────
// Every string that reaches the page from a feed, from the model, or from an
// error goes through textContent. Not "escaped on the way into a template" —
// never turned into markup in the first place, so there is no escaping to get
// wrong and no template to forget.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Appends the text to a node, wrapping matches of the query in a <span>. The
// only element here is one this function creates itself; the feed's text is
// only ever a text node, so a headline containing markup stays a headline.
function appendHighlighted(parent, text, query) {
  const raw = String(text == null ? '' : text);
  if (!query) { parent.appendChild(document.createTextNode(raw)); return parent; }
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // split() on a capturing group puts the matches at the odd indices.
  raw.split(new RegExp('(' + pattern + ')', 'gi')).forEach((part, i) => {
    if (!part) return;
    parent.appendChild(i % 2 ? el('span', 'highlight', part) : document.createTextNode(part));
  });
  return parent;
}

function timeAgo(dateStr) {
  const at = Date.parse(dateStr);
  if (!at) return '';
  const diff = (Date.now() - at) / 1000;
  if (diff < 60)    return t('justNow');
  if (diff < 3600)  return t('minutesAgo', { n: num(Math.floor(diff / 60))    });
  if (diff < 86400) return t('hoursAgo',   { n: num(Math.floor(diff / 3600))  });
  return                   t('daysAgo',    { n: num(Math.floor(diff / 86400)) });
}

/* ── Language ── */
function toggleLang() {
  langMode = langMode === 'en' ? 'bn' : 'en';
  localStorage.setItem('news-lang', langMode);
  applyLanguage();
}

// Everything the page says, in the selected language. Static chrome comes from
// the markup's data-i18n keys; everything else is re-rendered, because the
// language decides not just the words but the numerals, the date format and
// which side of each article to show.
function applyLanguage() {
  document.documentElement.lang = langMode;

  const btn = document.getElementById('lang-toggle');
  btn.textContent = langMode === 'bn' ? 'English' : 'বাংলা';
  btn.setAttribute('lang', langMode === 'bn' ? 'en' : 'bn');
  btn.classList.toggle('bn', langMode === 'bn');
  btn.setAttribute('aria-label', t('switchLanguage'));

  document.querySelectorAll('[data-i18n]').forEach(node => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(node => {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  });
  document.querySelectorAll('[data-i18n-label]').forEach(node => {
    node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  });

  applyThemeLabel();
  applyDateScope();
  applyArchiveChrome();
  applyRegionChrome();
  renderStatus();
  renderProvenance();
  buildFilterBar();
  buildTopicBar();
  renderArticles();
  showHeadlines(allArticles);
  renderSummary();
}

// An archive date is a plain YYYY-MM-DD, not an instant: parsed as UTC and
// rendered without a time, so "13 September" does not become the 12th for a
// reader west of Greenwich.
function formatDay(iso) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return String(iso);
  // The year is not optional here. An archive that can hold a hundred and
  // twenty days spans a new year, and "1 January" alone names two days.
  return d.toLocaleDateString(LOCALE[langMode],
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// hour12 is forced off: bn-BD otherwise renders a 12-hour clock with a Latin
// "AM", which belongs to neither language, and the two views disagree on the
// same instant.
function formatFetched() {
  const locale = LOCALE[langMode];
  return fetchedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
    + ' \u00B7 ' + fetchedAt.toLocaleDateString(locale, { day: '2-digit', month: 'short' });
}

// The fetch time in three places, formatted for the selected language. Kept
// together because they all go stale the moment the language changes.
function renderProvenance() {
  const when = fetchedAt ? formatFetched() : '';
  document.getElementById('last-updated').textContent = when ? t('fetchedAt', { time: when }) : '\u2014';
  document.getElementById('latest-provenance').textContent = when;
  document.getElementById('foot-provenance').textContent =
    when ? t('footerLast', { time: when }) : t('footerRefresh');
  return when;
}

/* ── Region ── */
function switchRegion(regionId, el) {
  if (regionId === activeRegion) return;
  activeRegion = regionId;
  localStorage.setItem('news-region', regionId);
  applyRegionChrome();

  document.querySelectorAll('.region-link').forEach(c => {
    c.setAttribute('aria-selected', c === el ? 'true' : 'false');
  });

  activeFilter = 'all';
  activeTopic = 'all';
  clearSearch();
  // A date archived for one region need not exist for another, and silently
  // showing a different day under a new flag would be the worst of both. The
  // region switch returns to live.
  viewDate = null;
  archiveSnap = null;
  syncLocation();
  loadData();
}

function applyRegionChrome() {
  const cfg = REGION_CONFIG[activeRegion];
  // The region-strip's own active state (set in switchRegion and at boot)
  // already names the region in full — nothing left for the wordmark to
  // repeat.
  document.title = t('siteTitle', { region: regionLabel(activeRegion) });

  const langBtn = document.getElementById('lang-toggle');
  langBtn.hidden = !cfg.hasLang;
  if (!cfg.hasLang && langMode !== 'en') {
    langMode = 'en';
    localStorage.setItem('news-lang', langMode);
    applyLanguage();
  }

  applyBriefModeChrome();
}

// The general/for-brokers toggle only exists on au — a mode of that
// region's briefing, not a feature every region carries. Hidden elsewhere
// rather than disabled, the same choice the language toggle already made
// for a region with nothing to translate.
function applyBriefModeChrome() {
  const toggle = document.getElementById('brief-mode-toggle');
  if (!toggle) return;
  toggle.hidden = activeRegion !== 'au';
  document.querySelectorAll('#brief-mode-toggle .brief-mode-btn').forEach(btn => {
    const on = btn.dataset.mode === briefMode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function setBriefMode(mode) {
  const next = mode === 'broker' ? 'broker' : 'general';
  if (next === briefMode) return;
  briefMode = next;
  localStorage.setItem('news-briefmode', briefMode);
  applyBriefModeChrome();
  const latest = queryLatestBriefing(briefMode);
  briefingEn = latest.en;
  briefingBn = latest.bn;
  briefOpenSet = new Set();
  renderSummary();
}

/* ── Search ── */
function onSearch(val) {
  document.getElementById('search-clear').style.display = val ? 'block' : 'none';
  document.getElementById('kbd-hint').style.display = val ? 'none' : '';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = val.trim();
    renderArticles();
  }, 140);
}

function clearSearch() {
  searchQuery = '';
  const input = document.getElementById('search-input');
  input.value = '';
  document.getElementById('search-clear').style.display = 'none';
  document.getElementById('kbd-hint').style.display = '';
  renderArticles();
}

document.addEventListener('keydown', e => {
  const input = document.getElementById('search-input');
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); input.focus(); input.select(); }
  if (e.key === 'Escape' && document.activeElement === input) { clearSearch(); input.blur(); }
});

/* ── Filters ──────────────────────────────────────────────────────────────
   A dropdown, not a permanently open row: closed it costs the one line the
   search field already sits on; open it is the same list of sources it
   always was, one click either way. */
function buildFilterBar() {
  const counts = {};
  allArticles.forEach(a => { counts[a.sourceId] = (counts[a.sourceId] || 0) + 1; });

  const menu = document.getElementById('sources-menu');
  menu.replaceChildren();

  const allBtn = el('button', 'source-option' + (activeFilter === 'all' ? ' active' : ''), t('allSources'));
  allBtn.type = 'button';
  allBtn.role = 'option';
  allBtn.setAttribute('aria-selected', activeFilter === 'all' ? 'true' : 'false');
  allBtn.dataset.source = 'all';
  menu.appendChild(allBtn);

  allSources.forEach(s => {
    const count = counts[s.id] || 0;
    if (!count) return;
    const btn = el('button', 'source-option' + (activeFilter === s.id ? ' active' : ''));
    btn.type = 'button';
    btn.role = 'option';
    btn.setAttribute('aria-selected', activeFilter === s.id ? 'true' : 'false');
    btn.dataset.source = s.id;
    btn.appendChild(document.createTextNode(sourceLabel({ sourceId: s.id, sourceName: s.name })));
    btn.appendChild(el('span', 'count', num(count)));
    menu.appendChild(btn);
  });

  renderSourcesTriggerLabel();
}

// The trigger names the current selection — "All sources", or the one
// publisher chosen — so the closed control still says what it is filtering
// to, rather than a neutral "Sources" that leaves the reader to open it to
// find out.
function renderSourcesTriggerLabel() {
  const label = document.getElementById('sources-trigger-label');
  if (activeFilter === 'all') { label.textContent = t('allSources'); return; }
  const source = allSources.find(s => s.id === activeFilter);
  label.textContent = source ? sourceLabel({ sourceId: source.id, sourceName: source.name }) : t('allSources');
}

function setFilter(id, optionEl) {
  activeFilter = id;
  document.querySelectorAll('#sources-menu .source-option').forEach(c => {
    c.classList.remove('active');
    c.setAttribute('aria-selected', 'false');
  });
  optionEl.classList.add('active');
  optionEl.setAttribute('aria-selected', 'true');
  renderSourcesTriggerLabel();
  closeSourcesMenu();
  renderArticles();
}

function toggleSourcesMenu(open) {
  const menu = document.getElementById('sources-menu');
  const trigger = document.getElementById('sources-trigger');
  const next = open == null ? menu.hidden : open;
  menu.hidden = !next;
  trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
}
function closeSourcesMenu() { toggleSourcesMenu(false); }

// The topic every article's own pipeline classification already carries
// (lib/rank.js's TOPIC_WEIGHT keys) — display case only, not translated:
// the classifier itself only ever writes these English words, the same way
// the archive's own topic label (see the story head below) has always shown
// them unlocalized.
const TOPIC_LABELS = {
  conflict: 'Conflict', economy: 'Economy', politics: 'Politics', markets: 'Markets',
  business: 'Business', world: 'World', environment: 'Environment', health: 'Health',
  science: 'Science', technology: 'Technology', society: 'Society', culture: 'Culture',
  opinion: 'Opinion', sport: 'Sport', other: 'Other'
};
function topicLabel(topic) { return TOPIC_LABELS[topic] || topic; }

function buildTopicBar() {
  const counts = {};
  allArticles.forEach(a => { if (a.topic) counts[a.topic] = (counts[a.topic] || 0) + 1; });

  const menu = document.getElementById('topics-menu');
  menu.replaceChildren();

  const allBtn = el('button', 'source-option' + (activeTopic === 'all' ? ' active' : ''), t('allTopics'));
  allBtn.type = 'button';
  allBtn.role = 'option';
  allBtn.setAttribute('aria-selected', activeTopic === 'all' ? 'true' : 'false');
  allBtn.dataset.topic = 'all';
  menu.appendChild(allBtn);

  Object.keys(TOPIC_LABELS).forEach(topic => {
    const count = counts[topic] || 0;
    if (!count) return;
    const btn = el('button', 'source-option' + (activeTopic === topic ? ' active' : ''));
    btn.type = 'button';
    btn.role = 'option';
    btn.setAttribute('aria-selected', activeTopic === topic ? 'true' : 'false');
    btn.dataset.topic = topic;
    btn.appendChild(document.createTextNode(topicLabel(topic)));
    btn.appendChild(el('span', 'count', num(count)));
    menu.appendChild(btn);
  });

  renderTopicsTriggerLabel();
}

function renderTopicsTriggerLabel() {
  const label = document.getElementById('topics-trigger-label');
  label.textContent = activeTopic === 'all' ? t('allTopics') : topicLabel(activeTopic);
}

function setTopicFilter(id, optionEl) {
  activeTopic = id;
  document.querySelectorAll('#topics-menu .source-option').forEach(c => {
    c.classList.remove('active');
    c.setAttribute('aria-selected', 'false');
  });
  optionEl.classList.add('active');
  optionEl.setAttribute('aria-selected', 'true');
  renderTopicsTriggerLabel();
  closeTopicsMenu();
  renderArticles();
}

function toggleTopicsMenu(open) {
  const menu = document.getElementById('topics-menu');
  const trigger = document.getElementById('topics-trigger');
  const next = open == null ? menu.hidden : open;
  menu.hidden = !next;
  trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
}
function closeTopicsMenu() { toggleTopicsMenu(false); }

/* ── Rendering ── */

// The publishers covering this article's story, other than the one being
// shown. Empty unless the data file published a record for the story, which
// it does whenever more than one source carried it.
function storyOf(a) {
  return (a.clusterId && storyById[a.clusterId]) || null;
}

function otherSources(a, story) {
  if (!story || !story.sourceIds) return [];
  return story.sourceIds.filter(id => id !== a.sourceId);
}

// One of the other newsrooms that covered this story, linked to its own
// telling. Its own function so that `link` here is unambiguously this
// member's URL, and so the safeURL check sits next to the assignment it
// guards rather than a dozen lines above it.
function sourceAnchor(member) {
  const link = safeURL(member.link);
  if (!link) return null;
  const anchor = el('a', 'source-link', sourceLabel(member));
  anchor.href = link;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

// What the other newsrooms said, and when the story ran. Each publisher's own
// headline rather than just its name: where two of them disagree, that
// disagreement is visible here and nowhere else on the page.
function storyDetail(article, story) {
  const box = el('div', 'story-detail');

  const span = storySpan(story);
  if (span) box.appendChild(el('p', 'story-span', span));

  const list = el('ul', 'story-sources');
  (story.links || []).forEach(memberLink => {
    const member = articleByLink[memberLink];
    if (!member) return;
    const row = el('li', 'story-source' + (member.link === article.link ? ' is-shown' : ''));
    row.appendChild(el('span', 'label', sourceLabel(member)));
    const anchor = sourceAnchor(member);
    if (anchor) {
      anchor.replaceChildren(document.createTextNode(pick(member, 'title') || t('untitled')));
      if (shownLang(member) === 'bn') anchor.lang = 'bn';
      row.appendChild(anchor);
    } else {
      row.appendChild(el('span', null, pick(member, 'title') || t('untitled')));
    }
    list.appendChild(row);
  });
  box.appendChild(list);
  return box;
}

// One line of provenance above the comparison: how many reports, from how
// many newsrooms, over how long.
//
// Reports and sources are counted separately because they differ and the
// difference matters — a publisher filing three times is not three
// newsrooms, and a list of three rows under a chip reading "2 sources" looks
// like an error until the line above it says why.
function storySpan(story) {
  const reports = (story.links || []).length;
  const sources = (story.sourceIds || []).length;
  if (!reports) return '';
  let line = t(reports === 1 ? 'reportCountOne' : 'reportCount', { n: num(reports) })
    + ' \u00B7 ' + t('sourceCount', { n: num(sources) });
  const first = Date.parse(story.first), latest = Date.parse(story.latest);
  const hours = Math.round((latest - first) / 3600000);
  // Omitted when everything landed within the hour: "0h" is not information.
  if (Number.isFinite(first) && Number.isFinite(latest) && hours >= 1) {
    line += ' \u00B7 ' + t('runningFor', { n: num(hours), from: timeAgo(story.first) || '\u2014' });
  }
  return line;
}

// A card used to be one big <a>. It cannot be any more: a card now carries
// links of its own — the other publishers who covered the story — and an
// anchor inside an anchor is not a thing a browser will render. The card is
// an <article>, the headline is the link, and the headline's ::after covers
// the card so the whole thing is still one click target. The source links sit
// above that overlay and keep their own clicks.
function cardElement(a, isFeatured, n, isSecondary) {
  const source = sourceLabel(a);
  const link   = safeURL(a.link);
  const img    = safeImagePath(a.img);
  const story  = storyOf(a);
  const others = otherSources(a, story);

  const card = el('article', 'card'
    + (isFeatured ? ' featured' : '')
    + (isSecondary ? ' secondary' : ''));
  card.dataset.n = String(n).padStart(2, '0');

  // Missing art gets the striped placeholder, captioned with what belongs there.
  if (img) {
    const wrap = el('div', 'thumb');
    const pic = document.createElement('img');
    pic.alt = '';
    pic.loading = 'lazy';
    pic.decoding = 'async';
    // A listener rather than an onerror attribute: the CSP no longer allows an
    // inline handler, and this one cannot be confused with feed content.
    //
    // One retry before giving up: a hotlinked image failing once is often a
    // transient hiccup on the publisher's CDN — a connection reset, a
    // momentary blip under the burst of a page load fetching dozens of
    // images at once — not a permanently dead link. Re-requesting a couple
    // of seconds later catches that case; only a second failure gets the
    // placeholder.
    let imgRetried = false;
    pic.addEventListener('error', () => {
      if (!imgRetried) {
        imgRetried = true;
        setTimeout(() => { pic.src = img; }, 2000);
        return;
      }
      wrap.className = 'thumb placeholder';
      wrap.replaceChildren(el('span', 'cap', t('imageUnavailable')));
    });
    pic.src = img;
    wrap.appendChild(pic);
    card.appendChild(wrap);
  } else {
    const wrap = el('div', 'thumb placeholder');
    wrap.appendChild(el('span', 'cap', t('noImage', { source: source })));
    card.appendChild(wrap);
  }

  const body = el('div', 'card-body');
  if (isFeatured) body.appendChild(el('span', 'lead-badge', t('leadStory')));

  const label = el('div', 'card-label');
  label.appendChild(el('span', 'label', source));
  // Corroboration, stated on the card rather than left for the reader to
  // notice: how many independent newsrooms carried this, and — when only one
  // did — that nobody else has confirmed it.
  //
  // When there are others, the count is also the way in: it opens the
  // comparison rather than the card carrying a list of publishers nobody
  // asked for. One control, two jobs, no extra row.
  let detailToggle = null;
  if (others.length) {
    detailToggle = el('button', 'corroborated is-toggle',
      t('sourceCount', { n: num(story.sourceIds.length) }));
    detailToggle.type = 'button';
    detailToggle.setAttribute('aria-expanded', 'false');
    label.appendChild(detailToggle);
  } else if (story) {
    label.appendChild(el('span', 'single-source', t('singleSource')));
  }
  body.appendChild(label);

  // lang on the element, not a guess from the page: an article with no
  // translation yet still renders in its own language, and the Bangla face
  // applies to exactly the text that is Bangla.
  const shown = shownLang(a);
  //
  // Three elements for one headline, and each one is load-bearing: the <a>
  // carries a ::after that covers the whole card (so the card is still one
  // click target), and that overlay would be clipped away by the line clamp
  // if the clamp lived on the anchor or the heading rather than on the span
  // inside it.
  const title = el('h2', 'card-title');
  const titleLink = el('a', 'card-link');
  titleLink.href = link || '#';
  if (link) { titleLink.target = '_blank'; titleLink.rel = 'noopener noreferrer'; }
  if (shown === 'bn') titleLink.lang = 'bn';
  if (link && readLinks.has(link)) titleLink.classList.add('is-read');
  if (link) titleLink.addEventListener('click', () => {
    markRead(link);
    titleLink.classList.add('is-read');
  });
  const titleText = el('span', 'clamp');
  appendHighlighted(titleText, pick(a, 'title') || t('untitled'), searchQuery);
  titleLink.appendChild(titleText);
  title.appendChild(titleLink);
  body.appendChild(title);

  // No "why this matters" line here any more. It lived on every card for two
  // rounds and never earned its place: the top stories already carry the
  // analysis in the briefing above, and repeating it card by card is the
  // per-item chrome a scanning reader is here to get past, not read. The
  // sentence itself is still bought and stored (story.why) — it is what the
  // briefing shows, and what a future story page would show in full.
  const descText = pick(a, 'desc');
  if (descText) {
    const desc = el('p', 'card-desc');
    if (shown === 'bn') desc.lang = 'bn';
    appendHighlighted(desc, descText, searchQuery);
    body.appendChild(desc);
  }

  // The comparison, behind the count. Closed it costs nothing; open it is the
  // thing an aggregator can do that a single masthead cannot — the same event
  // as four newsrooms chose to word it, and when they first and last filed.
  if (detailToggle) {
    const detail = storyDetail(a, story);
    detail.hidden = true;
    detailToggle.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      detailToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      detailToggle.classList.toggle('is-open', open);
    });
    body.appendChild(detail);
  }

  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', 'age', timeAgo(a.pubDate) || '\u2014'));
  meta.appendChild(el('span', null, t('readArrow')));
  body.appendChild(meta);

  card.appendChild(body);
  return card;
}

// One card per story, not per article.
//
// Only under "All sources" with no search term: filtering to a publisher
// means the reader asked for that publisher's own coverage, and a search has
// to be able to find any article, including one whose story is led by
// another. Outside those two cases, an article that is not its story's lead
// is the same event as a card already on the page.
function collapseToStories(articles) {
  return articles.filter(a => {
    const story = storyOf(a);
    if (!story || story.size <= 1) return true;
    return story.lead === a.link;
  });
}

// The stories the briefing has already covered, which the feed underneath
// therefore does not repeat. Five cards restating the five items directly
// above them was the single biggest thing standing between a reader and the
// sixth story of the day — and the briefing headlines link straight through,
// so nothing becomes unreachable by being left out here.
function briefedStoryIds() {
  const ids = new Set();
  if (!viewDate) briefingEn.forEach(item => { if (item.id) ids.add(item.id); });
  return ids;
}

function orderArticles(articles) {
  const byTime = (x, y) => (Date.parse(y.pubDate) || 0) - (Date.parse(x.pubDate) || 0);
  if (feedOrder === 'latest') return articles.slice().sort(byTime);
  // Importance first. An article with no score is one published before the
  // ranking existed, or one whose story the file did not record; it sorts
  // below everything scored rather than above it.
  return articles.slice().sort((x, y) => {
    const d = (y.score || 0) - (x.score || 0);
    return d !== 0 ? d : byTime(x, y);
  });
}

// The archive holds headlines, not articles, so an archived day is a list and
// not a card grid. Showing it as cards would promise art, descriptions and a
// live source breakdown that the snapshot deliberately does not carry.
function renderArchiveFeed() {
  const container = document.getElementById('feed-container');
  const stories = (archiveSnap && archiveSnap.stories) || [];

  document.getElementById('article-count').textContent =
    t(stories.length === 1 ? 'articleCountOne' : 'articleCount', { n: num(stories.length) });

  if (feedObserver) feedObserver.disconnect();
  visibleArticles = [];
  renderedCount = 0;

  // The briefing panel above already says this day has nothing archived;
  // saying it twice, in two boxes, reads as two separate problems.
  if (!stories.length) {
    container.replaceChildren();
    document.getElementById('article-count').textContent = '';
    return;
  }

  const list = el('ol', 'archive-list');
  stories.forEach(st => {
    const item = el('li', 'archive-item');
    const link = safeURL(st.lead);
    const anchor = el('a', 'archive-headline', archiveHeadline(st) || t('untitled'));
    anchor.href = link || '#';
    if (link) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
    item.appendChild(anchor);

    const meta = el('div', 'archive-meta');
    if (st.sourceIds && st.sourceIds.length > 1) {
      meta.appendChild(el('span', 'corroborated', t('coveredBy', { n: num(st.sourceIds.length) })));
    }
    if (st.topic) meta.appendChild(el('span', 'label', st.topic));
    if (meta.childElementCount) item.appendChild(meta);

    // `why` is always written in English and only ever translated into
    // Bangla (never the other way), unlike the headline — so this only
    // needs the one fallback direction.
    const why = langMode === 'bn' && st.whyBn ? st.whyBn : st.why;
    if (why) {
      const whyEl = el('p', 'card-why');
      whyEl.appendChild(el('span', 'why-label', t('whyItMatters')));
      whyEl.appendChild(document.createTextNode(why));
      item.appendChild(whyEl);
    }
    list.appendChild(item);
  });

  const head = el('div', 'archive-head');
  head.appendChild(el('span', 'label', t('archiveStories', { date: formatDay(viewDate) })));
  container.replaceChildren(head, list);
}

function renderArticles() {
  if (viewDate) return renderArchiveFeed();

  const container = document.getElementById('feed-container');
  const q = searchQuery.toLowerCase();

  let articles = activeFilter === 'all'
    ? allArticles
    : allArticles.filter(a => a.sourceId === activeFilter);

  if (activeTopic !== 'all') articles = articles.filter(a => a.topic === activeTopic);
  if (dateScope === 'today') articles = articles.filter(a => isFromToday(a.pubDate));

  if (q) {
    // Across every language the article carries, so a Bangla query finds an
    // English article that has been translated, and the other way round.
    articles = articles.filter(a =>
      ['title', 'desc', 'titleBn', 'descBn', 'titleEn', 'descEn']
        .some(f => typeof a[f] === 'string' && a[f].toLowerCase().includes(q))
    );
  }

  const collapsing = !q && activeFilter === 'all' && activeTopic === 'all';
  if (collapsing) articles = collapseToStories(articles);
  articles = orderArticles(articles);

  // Only in the ranked view: under Latest the question is "what came in", and
  // silently withholding the six most recent things because a briefing
  // mentioned them would be answering something else.
  if (collapsing && feedOrder === 'top') {
    const briefed = briefedStoryIds();
    if (briefed.size) articles = articles.filter(a => !briefed.has(a.clusterId));
  }

  // Only the ranked Today view is capped, and only when it is showing
  // everything: a search or a source filter is a question the reader asked,
  // and cutting its answer off at thirty would be answering a different one.
  // All time is the deliberate opposite of Today — its whole point is the
  // full retention window, uncapped, paged in as the reader scrolls.
  const capped = collapsing && feedOrder === 'top' && dateScope === 'today'
    && articles.length > TOP_STORIES_SHOWN;
  if (capped) articles = articles.slice(0, TOP_STORIES_SHOWN);

  document.getElementById('article-count').textContent =
    t(articles.length === 1 ? 'articleCountOne' : 'articleCount', { n: num(articles.length) });

  if (!articles.length) {
    visibleArticles = [];
    renderedCount = 0;
    if (feedObserver) feedObserver.disconnect();
    const body = q ? t('emptySearch', { query: searchQuery })
      : dateScope === 'today' ? t('emptyToday')
      : activeTopic !== 'all' ? t('emptyTopic', { topic: topicLabel(activeTopic) })
      : t('emptySource');
    container.replaceChildren(notice('notice', t('emptyTitle'), body));
    return;
  }

  // Only a page of cards is put in the DOM at a time — a feed can hold
  // thousands of articles, and rendering them all makes every subsequent
  // repaint (theme switch, filtering, scrolling) crawl.
  visibleArticles = articles;
  feedIsCapped = capped;
  // The lead is the top-ranked story, full stop — index 0, not "whichever
  // story happens to have a picture". Searching forward for the first
  // image-bearing story used to pick the *second* story when the top one
  // had none: the featured card carries grid-column:1/-1, so CSS Grid
  // pushed it to a new row rather than letting it share row one with the
  // card ahead of it, leaving row one a single narrow card followed by
  // empty columns and a wide gap before the sidebar. A top story with no
  // image gets the same placeholder every other image-less card gets — it
  // is a first-class fallback everywhere else on this page, and the hero
  // slot is no exception, let alone one that breaks the grid.
  //
  // Only in the ordering where "top" means anything: under "Latest" the
  // first card is merely the newest, which is not a lead and is not badged
  // as one. And not at all when a briefing is up: the briefing has already
  // taken the day's top stories, so the first card in the feed is the sixth
  // most important thing that happened. Giving that the largest box on the
  // page, under a badge reading "Lead story", is the page contradicting
  // itself.
  const briefingLeads = !viewDate && briefingEn.length > 0;
  featuredIndex = (collapsing && feedOrder === 'top' && !briefingLeads && articles.length) ? 0 : -1;
  renderedCount = 0;

  const grid = el('div', 'grid');
  grid.id = 'feed-grid';
  const sentinel = el('div', 'feed-sentinel');
  sentinel.id = 'feed-sentinel';
  const progress = el('span', 'label');
  progress.id = 'feed-progress';
  sentinel.appendChild(progress);
  container.replaceChildren(grid, sentinel);
  appendBatch();
  observeSentinel();
}

function appendBatch() {
  const grid = document.getElementById('feed-grid');
  if (!grid || renderedCount >= visibleArticles.length) return;

  const slice = visibleArticles.slice(renderedCount, renderedCount + PAGE_SIZE);
  const batch = document.createDocumentFragment();
  slice.forEach((a, i) => {
    const at = renderedCount + i;
    const isFeatured = at === featuredIndex;
    const isSecondary = featuredIndex !== -1 && !isFeatured && at <= featuredIndex + SECONDARY_COUNT;
    batch.appendChild(cardElement(a, isFeatured, at + 1, isSecondary));
  });
  grid.appendChild(batch);
  renderedCount += slice.length;

  const progress = document.getElementById('feed-progress');
  if (progress) progress.textContent =
    t('shownOfTotal', { n: num(renderedCount), total: num(visibleArticles.length) });

  if (renderedCount >= visibleArticles.length) {
    const sentinel = document.getElementById('feed-sentinel');
    if (sentinel) {
      const end = el('span', 'label', feedIsCapped
        ? t('endOfTop', { n: num(visibleArticles.length) })
        : t('endOfFeed', { n: num(visibleArticles.length) }));
      if (feedIsCapped) {
        const more = el('button', 'link-button', t('orderLatest'));
        more.type = 'button';
        more.addEventListener('click', () => setFeedOrder('latest'));
        sentinel.replaceChildren(end, more);
      } else {
        sentinel.replaceChildren(end);
      }
    }
    if (feedObserver) feedObserver.disconnect();
  }
}

function observeSentinel() {
  if (feedObserver) feedObserver.disconnect();
  const sentinel = document.getElementById('feed-sentinel');
  if (!sentinel || renderedCount >= visibleArticles.length) return;

  feedObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) appendBatch();
  }, { rootMargin: '600px 0px' });
  feedObserver.observe(sentinel);
}

function showSkeletons() {
  showBriefingSkeleton();
  const grid = el('div', 'loading-grid');
  for (let i = 0; i < 6; i++) {
    const card = el('div', 'skeleton');
    card.appendChild(el('div', 'skeleton-thumb'));
    const body = el('div', 'skeleton-body');
    ['w35', '', 'w85', 'w55'].forEach(w =>
      body.appendChild(el('div', 'skeleton-line' + (w ? ' ' + w : ''))));
    card.appendChild(body);
    grid.appendChild(card);
  }
  document.getElementById('feed-container').replaceChildren(grid);
}

// The briefing panel used to stay hidden while its data loaded, then appear
// from nothing once it arrived — the one jump on the page nothing else made,
// since every card already had a skeleton to hold its place. This gives it
// one too: a handful of lines at roughly the height five real items take, so
// the panel is on screen from first paint and does not shove the rest of the
// page down once the real briefing lands.
function showBriefingSkeleton() {
  const box = document.getElementById('page-summary');
  const body = document.getElementById('page-summary-text');
  body.className = 'brief-items';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 3; i++) {
    const item = el('div', 'brief-item skeleton-brief');
    item.dataset.n = String(i + 1).padStart(2, '0');
    item.appendChild(el('div', 'skeleton-line w85'));
    item.appendChild(el('div', 'skeleton-line w55'));
    frag.appendChild(item);
  }
  body.replaceChildren(frag);
  document.getElementById('summary-toggle').hidden = true;
  document.getElementById('brief-byline').hidden = true;
  document.getElementById('brief-change').hidden = true;
  document.getElementById('archive-nav').hidden = true;
  box.hidden = false;
}

// The one shape both the empty state and the load failure use.
function notice(className, heading, body) {
  const box = el('div', className);
  box.appendChild(el('h3', null, heading));
  box.appendChild(el('p', null, body));
  return box;
}

// The briefing in the selected language, falling back item by item rather
// than all or nothing: a Bangla translation that has not landed yet shows the
// English briefing instead of no briefing.
function briefingItems() {
  const en = viewDate ? ((archiveSnap && archiveSnap.briefing) || []) : briefingEn;
  const alt = viewDate ? ((archiveSnap && archiveSnap.briefingBn) || []) : briefingBn;
  const bn = langMode === 'bn' && alt.length === en.length && en.length > 0;
  return { items: bn ? alt : en, lang: bn ? 'bn' : 'en' };
}

// A briefing item's story, from whichever set is being shown. In archive mode
// the live story map describes today and would put today's source count on a
// headline from a week ago.
function storyForItem(id) {
  if (!id) return null;
  if (viewDate) {
    const stories = (archiveSnap && archiveSnap.stories) || [];
    return stories.find(st => st.id === id) || null;
  }
  return storyById[id] || null;
}

// One briefing item: the headline, and underneath it either the consequence
// alone or the full What happened / Why this matters / What to watch.
//
// The three labels are the point. An aggregator gives you a headline and
// leaves the reader to work out whether it changes anything; naming the
// question each sentence answers is what makes this a briefing.
function briefItemElement(item, n, full, itemLang, itemOpen) {
  const open = full || itemOpen;
  const wrap = el('article', 'brief-item');
  if (itemLang === 'bn') wrap.lang = 'bn';
  wrap.dataset.n = String(n).padStart(2, '0');

  // Headline and its metadata share one line. A source count and a
  // "developing" marker are four words between them; giving them a row of
  // their own cost more vertical space than the headline they describe, and
  // the briefing has to fit in a glance or it is not a briefing.
  const head = el('h3', 'brief-headline');
  const story = storyForItem(item.id);
  // The headline is the way in. Until it was a link, the briefing was a thing
  // you read and then went looking for underneath — which is exactly the
  // duplication that made the page twice as long as it needed to be.
  const link = story && safeURL(story.lead);
  if (link) {
    const anchor = el('a', 'brief-link' + (readLinks.has(link) ? ' is-read' : ''), item.headline);
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.addEventListener('click', () => {
      markRead(link);
      anchor.classList.add('is-read');
    });
    head.appendChild(anchor);
  } else {
    head.appendChild(document.createTextNode(item.headline));
  }
  if (story && story.sourceIds && story.sourceIds.length > 1) {
    head.appendChild(el('span', 'brief-sources', t('sourceCountParen', { n: num(story.sourceIds.length) })));
  }
  wrap.appendChild(head);

  // Compact is one sentence and no label: this is the briefing, every line in
  // it is why the story matters, and repeating that above each one is a row
  // of chrome per item. The labels come back in the full view, where there
  // are three different questions to tell apart.
  if (!open) {
    if (item.why) wrap.appendChild(el('p', 'brief-why', item.why));
    // Only while the whole briefing is still compact: once "Expand all" has
    // opened every item, a per-item toggle would just be a second control
    // for the same state the bottom button already carries.
    if (!full) wrap.appendChild(briefItemToggle(n, false));
    return wrap;
  }

  const dl = el('dl', 'brief-lines');
  [[t('whatHappened'), item.what], [t('whyItMatters'), item.why], [t('whatToWatch'), item.watch]]
    .forEach(([label, text]) => {
      if (!text) return;
      dl.appendChild(el('dt', null, label));
      dl.appendChild(el('dd', null, text));
    });
  wrap.appendChild(dl);
  if (!full) wrap.appendChild(briefItemToggle(n, true));
  return wrap;
}

// One item opened on its own, independent of "Expand all" — same muted
// "Read →" treatment as the bottom toggle, scoped to just this line.
function briefItemToggle(n, isOpen) {
  const btn = el('button', 'brief-item-toggle', t(isOpen ? 'showLess' : 'readMore'));
  btn.type = 'button';
  btn.dataset.itemIndex = String(n);
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  return btn;
}

function renderSummary() {
  const box = document.getElementById('page-summary');
  const body = document.getElementById('page-summary-text');
  const toggle = document.getElementById('summary-toggle');
  const byline = document.getElementById('brief-byline');
  const { items, lang: itemLang } = briefingItems();

  // A day with no snapshot is a fact about the archive, not a failure to
  // load: the pipeline writes no snapshot for a run that had no briefing.
  if (viewDate && !items.length) {
    body.classList.remove('brief-items', 'clamped');
    body.replaceChildren(notice('notice', t('archiveMissing', { date: formatDay(viewDate) }), t('archiveHint')));
    toggle.hidden = true;
    byline.textContent = t('archiveViewing', { date: formatDay(viewDate) });
    byline.hidden = false;
    document.getElementById('brief-change').hidden = true;
    box.hidden = false;
    return;
  }

  if (items.length) {
    body.removeAttribute('lang');
    body.classList.remove('clamped');
    body.classList.add('brief-items');
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const n = i + 1;
      frag.appendChild(briefItemElement(item, n, briefFull, itemLang, briefOpenSet.has(n)));
    });
    body.replaceChildren(frag);
    toggle.textContent = t(briefFull ? 'briefShowShort' : 'briefShowFull');
    toggle.setAttribute('aria-expanded', briefFull ? 'true' : 'false');
    toggle.classList.add('brief-depth');
    toggle.hidden = false;
    byline.textContent = viewDate ? t('archiveViewing', { date: formatDay(viewDate) }) : '';
    byline.hidden = !viewDate;
    box.hidden = false;
    renderChangeNote();
    return;
  }

  // Broker mode specifically: unlike "no API key" or "every attempt
  // failed", this is an expected, common state — the toggle existing before
  // the first au fetch since it shipped has generated a broker briefing at
  // all. Says so rather than leaving the toggle sitting above a silent gap,
  // which is what prompted this in the first place.
  if (!viewDate && activeRegion === 'au' && briefMode === 'broker') {
    body.classList.remove('brief-items', 'clamped');
    body.replaceChildren(notice('notice', t('briefBrokerEmptyTitle'), t('briefBrokerEmptyBody')));
    toggle.hidden = true;
    byline.hidden = true;
    document.getElementById('brief-change').hidden = true;
    box.hidden = false;
    return;
  }

  // Nothing to show: no briefing has ever been generated for this region
  // (no API key, or every attempt has failed so far). Hides the whole panel
  // rather than rendering an empty one.
  box.hidden = true;
}

// What was on yesterday's briefing and is not on today's — headlines only,
// not links, since this is the archive's wording from a day that has moved
// on, not today's coverage. The baseline date is stated inline rather than
// assumed to be yesterday, since a region whose archive has a gap compares
// against the last day it has.
function renderChangeNote() {
  const note = document.getElementById('brief-change');
  // Only in the full view, and only when there's something dropped to show —
  // an empty note with nothing but a baseline date to state is not worth a
  // reader's attention.
  if (viewDate || !changedSince || !briefFull || !droppedItems.length) {
    note.hidden = true; note.replaceChildren(); return;
  }

  const frag = document.createDocumentFragment();
  const list = el('ul', 'dropped-list');
  droppedItems.slice(0, 4).forEach(d => list.appendChild(el('li', null, d.headline)));
  frag.appendChild(el('span', 'label dropped-heading',
    t('droppedHeading', { date: formatDay(changedSince) })));
  frag.appendChild(list);
  note.replaceChildren(frag);
  note.hidden = false;
}

// The panel is hidden entirely whenever there is no briefing to show (see
// renderSummary), so this toggle only ever runs with items in hand — there
// is no second, prose-summary mode left to branch on.
function toggleSummary() {
  briefFull = !briefFull;
  // Expand all / Collapse all is the whole briefing moving as one; whatever
  // was opened item-by-item under the old state would otherwise reappear
  // the next time the reader steps back out of "Expand all".
  briefOpenSet.clear();
  renderSummary();
}

function toggleBriefItem(n) {
  if (briefOpenSet.has(n)) briefOpenSet.delete(n); else briefOpenSet.add(n);
  renderSummary();
}

function showHeadlines(articles) {
  const list = document.getElementById('headlines-list');
  if (!articles || !articles.length) { list.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  articles.slice(0, 6).forEach(a => {
    const link = safeURL(a.link);
    const item = el('li', 'headline-item');
    const anchor = el('a', 'headline-title', pick(a, 'title'));
    anchor.href = link || '#';
    if (shownLang(a) === 'bn') anchor.lang = 'bn';
    if (link) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
    item.appendChild(anchor);
    item.appendChild(el('span', 'headline-time', timeAgo(a.pubDate) || '\u2014'));
    frag.appendChild(item);
  });
  list.replaceChildren(frag);
}

/* ── Archive ──────────────────────────────────────────────────────────────
   Browsing it is a SQL query against the database already sitting in
   memory, not a separate fetch — the whole point of loading the region as
   one file is that every day within the retention window is already there.
   loadRegionDb populates archiveDates as part of opening the database; this
   module only reads that state back. */

// Today's own snapshot is excluded from the navigation. It exists — the run
// writes it — but the live view already shows that day, and an "Older" button
// that lands on the same date the page is already showing reads as a bug. A
// link straight to today's date still opens it; only the stepping skips it.
function daysForRegion() {
  const today = new Date().toISOString().slice(0, 10);
  return archiveDates.filter(d => d !== today);
}

// The address bar is the share link. A dated briefing someone can send to
// someone else has to survive being pasted, so the date and region live in
// the URL rather than only in memory.
function syncLocation() {
  const params = new URLSearchParams();
  params.set('region', activeRegion);
  if (viewDate) params.set('date', viewDate);
  const url = window.location.pathname + '?' + params.toString();
  window.history.replaceState({}, '', url);
}

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const region = params.get('region');
  if (region && REGION_CONFIG[region]) activeRegion = region;
  const date = params.get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) viewDate = date;
}

function queryArchiveSnapshot(date) {
  const rows = query('SELECT * FROM snapshot_stories WHERE date = ? ORDER BY position', [date]);
  if (!rows.length) return null;
  const briefing = queryBriefingFor(date);
  return {
    date, briefing: briefing.en, briefingBn: briefing.bn.length ? briefing.bn : null,
    stories: rows.map(r => ({
      id: r.story_id, headline: plainText(r.headline), lead: r.lead_link, size: r.size,
      sourceIds: JSON.parse(r.source_ids), topic: r.topic, score: r.score,
      why: r.why, whyBn: r.why_bn,
      lang: r.lang, headlineEn: plainText(r.headline_en), headlineBn: plainText(r.headline_bn)
    }))
  };
}

// No network at all: the whole region's database, history included, is
// already open in memory once loadRegionDb has run — opening a past day is a
// different query against the same file, not a different file.
function showDate(date) {
  viewDate = date || null;
  archiveSnap = viewDate ? queryArchiveSnapshot(viewDate) : null;
  syncLocation();
  applyArchiveChrome();
  renderSummary();
  renderArticles();
}

// One class on <body> rather than a dozen hidden flags: the controls that
// describe live data — the source chips, the ordering — have nothing to say
// about a day that is over, and CSS is where "this control does not apply
// here" belongs.
function applyArchiveChrome() {
  document.body.classList.toggle('archive-mode', !!viewDate);

  const nav = document.getElementById('archive-nav');
  const days = daysForRegion();
  if (!days.length) { nav.hidden = true; return; }
  nav.hidden = false;

  // days is newest first, so "older" is the next index along and "newer" is
  // the one before. With no date selected we are on today, which sits before
  // every archived day.
  const at = viewDate ? days.indexOf(viewDate) : -1;
  const older = at === -1 ? days[0] : days[at + 1];
  const newer = at <= 0 ? null : days[at - 1];

  const olderBtn = document.getElementById('archive-older');
  const newerBtn = document.getElementById('archive-newer');
  const dateBtn = document.getElementById('archive-date');
  // The arrows keep their fixed ‹ › glyphs; only their accessible names are
  // translated. The date button's own visible text does the talking — the
  // day itself when browsing, or "Today" when live, and either way it is
  // also the "back to today" action, doing what a separate button used to.
  olderBtn.setAttribute('aria-label', t('archiveOlder'));
  newerBtn.setAttribute('aria-label', t('archiveNewer'));
  dateBtn.textContent = viewDate ? formatDay(viewDate) : t('archiveToday');
  dateBtn.setAttribute('aria-label', viewDate ? t('archiveBackToToday') : t('archiveToday'));
  olderBtn.disabled = !older;
  newerBtn.disabled = !newer;
  dateBtn.disabled = !viewDate;
  olderBtn.dataset.date = older || '';
  newerBtn.dataset.date = newer || '';
}

/* ── Database ──────────────────────────────────────────────────────────────
   Everything the page reads — today's articles, every story, every day's
   briefing, and the full history back to the retention window — lives in one
   file per region, fetched whole and queried client-side with sql.js. Making
   it work is one contract: whatever Node's own node:sqlite wrote, this has to
   open and read back exactly, with no export step and nothing kept in sync
   by hand between the write side and this one. */

// Loaded once; every region switch reuses the same wasm module and only
// fetches a new database file.
async function ensureSqlJs() {
  if (SQL) return SQL;
  // locateFile's `name` argument is whatever the glue file's own build
  // hardcodes (sql-wasm.wasm, unversioned) — not the versioned filename it
  // itself shipped as. Naming the wasm file explicitly here, rather than
  // trusting that argument, is what keeps an upgrade to a newer sql.js from
  // silently breaking on a filename this code never controlled.
  SQL = await initSqlJs({ locateFile: () => 'vendor/sql-wasm-1.13.0.wasm' });
  return SQL;
}

// sql.js returns one {columns, values} result per statement (or none, for a
// query that matched nothing) rather than row objects — this is the one
// place that shape is dealt with, so every query site below reads like a
// normal array of rows.
function rowsOf(result) {
  const set = result && result[0];
  if (!set) return [];
  return set.values.map(row => {
    const obj = {};
    set.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function query(sql, params) {
  return rowsOf(dbHandle.exec(sql, params));
}

// Mirrors lib/db.js's own readArticles exactly — same rule, reimplemented
// because this half runs in the browser and that half runs in Node, and
// neither can require the other. Exactly one translation direction is ever
// relevant for a given article; translate_failed marks only that one.
function hydrateArticle(row, sourceMeta) {
  const meta = sourceMeta[row.source_id] || { name: row.source_id, color: '#666' };
  const a = {
    link: row.link, title: plainText(row.title), desc: plainText(row.desc),
    pubDate: row.pub_date, img: row.img || null, lang: row.lang,
    sourceId: row.source_id, sourceName: meta.name, sourceColor: meta.color
  };
  if (row.story_id != null) a.clusterId = row.story_id;
  if (row.score != null) a.score = row.score;
  if (row.topic != null) a.topic = row.topic;
  const wantEn = row.lang === 'bn';
  assignTranslated(a, 'titleEn', row.title_en, wantEn && row.translate_failed);
  assignTranslated(a, 'descEn', row.desc_en, wantEn && row.translate_failed);
  assignTranslated(a, 'titleBn', row.title_bn, !wantEn && row.translate_failed);
  assignTranslated(a, 'descBn', row.desc_bn, !wantEn && row.translate_failed);
  return a;
}
function assignTranslated(article, key, value, failed) {
  if (value != null) { article[key] = plainText(value); return; }
  if (failed) { article[key] = false; return; }
}

// A story, in the shape cardElement/briefItemElement/storyDetail already
// expect — the same shape the old JSON's data.stories[] carried. `links` and
// `sourceIds` are grouped from the article rows rather than queried
// separately: a story's membership is already fully described by
// articles.story_id, so asking the same question twice would only be a
// second place for the two answers to disagree.
function buildStoryMaps(storyRows, articles) {
  const byId = {};
  storyRows.forEach(r => {
    byId[r.id] = {
      id: r.id, topic: r.topic, score: r.score, first: r.first_date, latest: r.latest_date,
      why: r.why || null, whyBn: r.why_bn || null, links: [], sourceIds: []
    };
  });
  // Newest first, matching how allArticles is already ordered: members[0]
  // — the lead — is a story's freshest telling.
  articles.forEach(a => {
    const st = a.clusterId && byId[a.clusterId];
    if (!st) return;
    st.links.push(a.link);
    if (!st.sourceIds.includes(a.sourceId)) st.sourceIds.push(a.sourceId);
  });
  storyById = {};
  storyByLead = {};
  Object.keys(byId).forEach(id => {
    const st = byId[id];
    if (!st.links.length) return;   // a story row with no live member: skip
    st.lead = st.links[0];
    st.size = st.links.length;
    storyById[id] = st;
    storyByLead[st.lead] = st;
  });
}

// The structured briefing, whatever date it was last written under — not
// necessarily today, exactly mirroring the fallback fetch.js itself reads
// when deciding whether to regenerate.
function queryLatestBriefing(mode) {
  const m = mode === 'broker' ? 'broker' : 'general';
  const [row] = query("SELECT MAX(date) as d FROM briefing_items WHERE COALESCE(mode,'general') = ?", [m]);
  if (!row || !row.d) return { en: [], bn: [] };
  return queryBriefingFor(row.d, m);
}
function queryBriefingFor(date, mode) {
  const m = mode === 'broker' ? 'broker' : 'general';
  const rows = query("SELECT * FROM briefing_items WHERE date = ? AND COALESCE(mode,'general') = ? ORDER BY position", [date, m]);
  const en = rows.map(r => ({ id: r.story_id || '', headline: r.headline, what: r.what, why: r.why, watch: r.watch }));
  const anyBn = rows.some(r => r.headline_bn);
  const bn = anyBn ? rows.map(r => ({ id: r.story_id || '', headline: r.headline_bn, what: r.what_bn, why: r.why_bn, watch: r.watch_bn })) : [];
  return { en, bn };
}

function queryMeta(key) {
  const [row] = query('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : null;
}

// Fetches and opens one region's whole database, replacing whatever was
// open before. The previous handle is freed explicitly — sql.js holds its
// data on the wasm heap, which a garbage collector watching only the JS
// reference has no idea how large it is.
async function loadRegionDb(region) {
  const SQLlib = await ensureSqlJs();
  const base = window.location.pathname.replace(/[^/]*$/, '');
  const res = await fetch(base + REGION_CONFIG[region].dbFile + '?t=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (dbHandle) { try { dbHandle.close(); } catch (e) {} }
  dbHandle = new SQLlib.Database(bytes);
  archiveDates = query('SELECT date FROM snapshots ORDER BY date DESC').map(r => r.date);
}

/* ── Data ── */
async function loadData() {
  if (loading) return;
  loading = true;

  setStatus('warn', () => t('fetching') + ' ' + REGION_CONFIG[activeRegion].dbFile);
  showSkeletons();

  try {
    await loadRegionDb(activeRegion);

    const sourceRows = query('SELECT id, name, color FROM sources');
    allSources = sourceRows;
    const sourceMeta = {};
    sourceRows.forEach(s => { sourceMeta[s.id] = s; });

    allArticles = query('SELECT * FROM articles ORDER BY pub_date_ms DESC')
      .map(row => hydrateArticle(row, sourceMeta));

    // Stories are what the feed is actually made of: one record per event,
    // naming every article covering it and which of them to link to. Indexed
    // both ways because the feed asks "what story is this article in?" and
    // the card asks "is this article its story's lead?".
    articleByLink = {};
    allArticles.forEach(a => { if (a.link) articleByLink[a.link] = a; });
    buildStoryMaps(query('SELECT * FROM stories'), allArticles);

    changedSince = queryMeta('changedSince');
    const droppedJson = queryMeta('dropped');
    droppedItems = droppedJson ? JSON.parse(droppedJson) : [];

    // Stored as a Date rather than a formatted string: the format depends on
    // the selected language, and the language can change after the load.
    // renderProvenance puts it in all three places — masthead, Latest panel and
    // the footer, which below 560px is the only one still visible.
    const fetchedAtValue = queryMeta('fetchedAt');
    fetchedAt = fetchedAtValue ? new Date(fetchedAtValue) : null;
    renderProvenance();

    if (activeRegion !== 'au') briefMode = 'general';
    const latest = queryLatestBriefing(activeRegion === 'au' ? briefMode : 'general');
    briefingEn = latest.en;
    briefingBn = latest.bn;

    // Refreshed here, not only from showDate/boot: switching regions resets
    // viewDate to live but never used to touch archive-nav's own visibility
    // or enabled state, which is per-region (a fresh region's archive dates
    // differ from the one just left) — so the control could show yesterday's
    // region's dates, or stay visible for a region with no history at all.
    applyArchiveChrome();

    showHeadlines(allArticles);
    renderSummary();
    setStatus('ok', () => regionLabel(activeRegion));
    buildFilterBar();
    buildTopicBar();
    renderArticles();

  } catch (e) {
    const box = notice('notice error', t('errorTitle'),
      t('errorBody', { file: REGION_CONFIG[activeRegion].dbFile, message: e.message }));
    box.appendChild(el('p', null, t('errorHint')));
    document.getElementById('feed-container').replaceChildren(box);
    setStatus('err', () => t('errorTitle'));
    document.getElementById('article-count').textContent = '';
  }

  loading = false;
}

/* ── Back to top ── */
const toTop = document.getElementById('to-top');
window.addEventListener('scroll', () => {
  toTop.classList.toggle('show', window.scrollY > 600);
}, { passive: true });

/* ── Controls ── */
// The markup carries no handlers: inline script is what the CSP now refuses,
// and an onclick attribute is inline script. Every control is wired here, by
// the id or data attribute the markup already had to carry anyway.
function wireControls() {
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('lang-toggle').addEventListener('click', toggleLang);
  document.getElementById('summary-toggle').addEventListener('click', toggleSummary);
  // Delegated: each item's own toggle is rebuilt on every renderSummary(),
  // but #page-summary-text, the parent they're rebuilt inside, is not.
  document.getElementById('page-summary-text').addEventListener('click', e => {
    const btn = e.target.closest('.brief-item-toggle');
    if (btn) toggleBriefItem(Number(btn.dataset.itemIndex));
  });
  document.getElementById('search-clear').addEventListener('click', clearSearch);
  document.getElementById('to-top').addEventListener('click', () => window.scrollTo({ top: 0 }));
  document.getElementById('search-input').addEventListener('input', e => onSearch(e.target.value));
  document.getElementById('scope-switch').addEventListener('click', e => {
    const btn = e.target.closest('.scope-btn');
    if (btn) setDateScope(btn.dataset.scope);
  });
  document.getElementById('brief-mode-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.brief-mode-btn');
    if (btn) setBriefMode(btn.dataset.mode);
  });
  document.getElementById('archive-nav').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    showDate(btn.id === 'archive-date' ? null : btn.dataset.date);
  });

  // Delegated, because the source options are rebuilt on every load and the
  // region links are the same three buttons for the life of the page.
  document.querySelector('.region-strip').addEventListener('click', e => {
    const link = e.target.closest('.region-link');
    if (link) switchRegion(link.dataset.region, link);
  });
  document.getElementById('sources-trigger').addEventListener('click', () => {
    closeTopicsMenu();
    toggleSourcesMenu();
  });
  document.getElementById('sources-menu').addEventListener('click', e => {
    const option = e.target.closest('.source-option');
    if (option && option.dataset.source) setFilter(option.dataset.source, option);
  });
  document.getElementById('topics-trigger').addEventListener('click', () => {
    closeSourcesMenu();
    toggleTopicsMenu();
  });
  document.getElementById('topics-menu').addEventListener('click', e => {
    const option = e.target.closest('.source-option');
    if (option && option.dataset.topic) setTopicFilter(option.dataset.topic, option);
  });
  // Closed the same way any dropdown is: a click elsewhere, or Escape.
  document.addEventListener('click', e => {
    if (!e.target.closest('.sources-dropdown')) { closeSourcesMenu(); closeTopicsMenu(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSourcesMenu(); closeTopicsMenu(); }
  });
}

// Offline support and instant repeat loads. Guarded rather than assumed: a
// browser with no serviceWorker support just gets the page it always got.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ── Swipe navigation ── */
// Left across BD → AU → Global → Nepal and back — the same order the
// masthead tabs already read in, just reachable without a thumb trip up to
// them. Clamped rather than wrapping past either end, matching how the tabs
// themselves have no cyclic "next after Nepal is BD" behavior either.
(function setupSwipeNav() {
  const REGION_ORDER = ['bd', 'au', 'global', 'np'];
  const SWIPE_MIN_X = 60;   // minimum horizontal travel to count as a swipe
  const SWIPE_MAX_Y = 60;   // more vertical than this reads as a scroll, not a swipe
  let startX = 0, startY = 0;

  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dy) > SWIPE_MAX_Y) return;

    const at = REGION_ORDER.indexOf(activeRegion);
    const next = REGION_ORDER[at + (dx < 0 ? 1 : -1)];
    if (!next) return;
    switchRegion(next, document.querySelector(`.region-link[data-region="${next}"]`));
  }, { passive: true });
})();

/* ── Boot ── */
// The URL wins over the stored region: a shared link has to open on the day
// and the region it names, whatever this browser last looked at.
readLocation();
document.querySelectorAll('.region-link').forEach(c => {
  c.setAttribute('aria-selected', c.dataset.region === activeRegion ? 'true' : 'false');
});
wireControls();
applyLanguage();
// Live data renders first even when the URL names an archived day, and the
// archive view replaces it once its snapshot is actually in hand. Rendering
// the archive view first would flash "nothing archived for that day" at every
// visitor following a shared link, which is the one thing a share link must
// not do.
(async () => {
  const wanted = viewDate;
  viewDate = null;
  await loadData();
  if (wanted) showDate(wanted);
  else applyArchiveChrome();
})();
