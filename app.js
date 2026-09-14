'use strict';
let allArticles  = [];
let allSources   = [];
let activeFilter = 'all';
let searchQuery  = '';
let loading      = false;
let langMode     = localStorage.getItem('news-lang') === 'bn' ? 'bn' : 'en';
let activeRegion = localStorage.getItem('news-region') || 'bd';
let searchTimer  = null;
let summaryEn    = '';
let summaryBn    = '';
let fetchedAt    = null;   // the Date, not a formatted string: the format is language-dependent

const PAGE_SIZE = 24;
let visibleArticles = [];
let renderedCount   = 0;
let featuredIndex   = -1;
let feedObserver    = null;

// hasLang mirrors `translate` in fetch.js: it says the region's data file
// carries Bangla, not that every article in it does. A region whose backlog is
// still draining renders untranslated articles in English either way.
const REGION_CONFIG = {
  bd:     { mark: 'BD', dataFile: 'data-bd.json',     hasLang: true },
  au:     { mark: 'AU', dataFile: 'data-au.json',     hasLang: true },
  global: { mark: 'GL', dataFile: 'data-global.json', hasLang: true }
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
    refresh:         'Refresh',
    fetching:        'Fetching',
    region:          'Region',
    regionBd:        'Bangladesh',
    regionAu:        'Australia',
    regionGlobal:    'Global',
    search:          'Search',
    filterHeadlines: 'Filter headlines',
    clearSearch:     'Clear search',
    filterBySource:  'Filter by source',
    allSources:      'All sources',
    briefing:        'Briefing',
    readMore:        'Read more',
    showLess:        'Show less',
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
    emptyTitle:      'Nothing here yet',
    emptySearch:     'No headlines match \u201C{query}\u201D. Widen the term or clear the filter.',
    emptySource:     'This source has published nothing in the retained window. Pick another source or region.',
    errorTitle:      'No data file',
    errorBody:       '{file} did not load: {message}.',
    errorHint:       'Run the Fetch RSS Feeds workflow in Actions, then reload.',
    factRegion:      'Region',
    factArticles:    'Articles',
    factSources:     'Sources',
    factFetched:     'Fetched',
    fetchedAt:       'Fetched {time}',
    justNow:         'just now',
    minutesAgo:      '{n}m ago',
    hoursAgo:        '{n}h ago',
    daysAgo:         '{n}d ago',
    siteTitle:       'Daily Digest \u2014 {region}',
    footerRegions:   'Daily Digest \u2014 Bangladesh, Australia, Global',
    footerRefresh:   'Refreshed twice daily via GitHub Actions',
    footerLast:      'Refreshed twice daily via GitHub Actions \u2014 last {time}'
  },
  bn: {
    skipToHeadlines: 'শিরোনামে যান',
    switchLanguage:  'ভাষা বদলান',
    themeDay:        'দিন',
    themeNight:      'রাত',
    refresh:         'রিফ্রেশ',
    fetching:        'আনা হচ্ছে',
    region:          'অঞ্চল',
    regionBd:        'বাংলাদেশ',
    regionAu:        'অস্ট্রেলিয়া',
    regionGlobal:    'বিশ্ব',
    search:          'খোঁজ',
    filterHeadlines: 'শিরোনাম ছাঁকুন',
    clearSearch:     'খোঁজ মুছুন',
    filterBySource:  'উৎস অনুযায়ী ছাঁকুন',
    allSources:      'সব উৎস',
    briefing:        'সারসংক্ষেপ',
    readMore:        'আরও পড়ুন',
    showLess:        'কম দেখান',
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
    emptyTitle:      'এখানে এখনও কিছু নেই',
    emptySearch:     '\u201C{query}\u201D-এর সঙ্গে কোনো শিরোনাম মেলেনি। শব্দটি বড় করুন বা ছাঁকনি মুছুন।',
    emptySource:     'এই উৎস সংরক্ষিত সময়সীমার মধ্যে কিছু প্রকাশ করেনি। অন্য উৎস বা অঞ্চল বেছে নিন।',
    errorTitle:      'কোনো ডেটা ফাইল নেই',
    errorBody:       '{file} লোড হয়নি: {message}।',
    errorHint:       'Actions-এ Fetch RSS Feeds ওয়ার্কফ্লো চালান, তারপর পৃষ্ঠাটি রিলোড করুন।',
    factRegion:      'অঞ্চল',
    factArticles:    'নিবন্ধ',
    factSources:     'উৎস',
    factFetched:     'সংগৃহীত',
    fetchedAt:       'সংগৃহীত {time}',
    justNow:         'এইমাত্র',
    minutesAgo:      '{n} মিনিট আগে',
    hoursAgo:        '{n} ঘণ্টা আগে',
    daysAgo:         '{n} দিন আগে',
    siteTitle:       'ডেইলি ডাইজেস্ট \u2014 {region}',
    footerRegions:   'ডেইলি ডাইজেস্ট \u2014 বাংলাদেশ, অস্ট্রেলিয়া, বিশ্ব',
    footerRefresh:   'GitHub Actions-এ দিনে দুইবার হালনাগাদ',
    footerLast:      'GitHub Actions-এ দিনে দুইবার হালনাগাদ \u2014 সর্বশেষ {time}'
  }
};

// Publishers' own names, as a Bangla reader would see them in print. Kept out
// of the data files so a rename is one edit here rather than a refetch.
const SOURCE_NAMES_BN = {
  dailystar: 'দ্য ডেইলি স্টার', prothomalo: 'প্রথম আলো',   risingbd: 'রাইজিংবিডি',
  dhakatribune: 'ঢাকা ট্রিবিউন', newage: 'নিউ এজ',          unb: 'ইউএনবি',
  abcnews: 'এবিসি নিউজ',        guardianau: 'দ্য গার্ডিয়ান অস্ট্রেলিয়া',
  smh: 'সিডনি মর্নিং হেরাল্ড',   conversationau: 'দ্য কনভারসেশন অস্ট্রেলিয়া',
  bbcnews: 'বিবিসি নিউজ',       aljazeera: 'আল জাজিরা',    guardian: 'দ্য গার্ডিয়ান',
  npr: 'এনপিআর',                france24: 'ফ্রান্স ২৪',      dwnews: 'ডয়চে ভেলে',
  cnn: 'সিএনএন'
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
  return t(id === 'bd' ? 'regionBd' : id === 'au' ? 'regionAu' : 'regionGlobal');
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

// Which language pick() actually returned, which is not always the one
// selected: a Bangla article with no English translation yet stays Bangla.
function shownLang(article) {
  const own = article.lang || 'en';
  if (langMode === own) return own;
  const other = article['title' + (langMode === 'bn' ? 'Bn' : 'En')];
  return (typeof other === 'string' && other) ? langMode : own;
}

/* ── Theme ── */
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
function setStatus(kind, word, detail) {
  const strip = document.getElementById('status-strip');
  strip.className = 'status-strip' + (kind === 'ok' ? '' : ' ' + kind);
  strip.textContent = STATUS_GLYPH[kind] + ' ' + word;
  document.getElementById('status-text').textContent = detail || '';
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
  applyRegionChrome();
  document.getElementById('refresh-label').textContent = t(loading ? 'fetching' : 'refresh');
  renderProvenance();
  buildFilterBar();
  renderArticles();
  showHeadlines(allArticles);
  renderSummary();
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

  document.querySelectorAll('.tab').forEach(c => {
    c.setAttribute('aria-selected', c === el ? 'true' : 'false');
  });

  activeFilter = 'all';
  clearSearch();
  loadData();
}

function applyRegionChrome() {
  const cfg = REGION_CONFIG[activeRegion];
  document.getElementById('logo-edition').textContent = regionLabel(activeRegion);
  document.title = t('siteTitle', { region: regionLabel(activeRegion) });

  const langBtn = document.getElementById('lang-toggle');
  langBtn.hidden = !cfg.hasLang;
  if (!cfg.hasLang && langMode !== 'en') {
    langMode = 'en';
    localStorage.setItem('news-lang', langMode);
    applyLanguage();
  }
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

/* ── Filters ── */
function buildFilterBar() {
  const counts = {};
  allArticles.forEach(a => { counts[a.sourceId] = (counts[a.sourceId] || 0) + 1; });

  const bar = document.getElementById('filter-bar');
  bar.replaceChildren();

  const allBtn = el('button', 'chip' + (activeFilter === 'all' ? ' active' : ''), t('allSources'));
  allBtn.dataset.source = 'all';
  bar.appendChild(allBtn);

  allSources.forEach(s => {
    const count = counts[s.id] || 0;
    if (!count) return;
    const btn = el('button', 'chip' + (activeFilter === s.id ? ' active' : ''));
    btn.dataset.source = s.id;
    btn.appendChild(document.createTextNode(sourceLabel({ sourceId: s.id, sourceName: s.name })));
    btn.appendChild(el('span', 'count', num(count)));
    bar.appendChild(btn);
  });
}

function setFilter(id, el) {
  activeFilter = id;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderArticles();
}

/* ── Rendering ── */
function cardElement(a, isFeatured, n) {
  const source = sourceLabel(a);
  const link   = safeURL(a.link);
  const img    = safeURL(a.img);

  const card = el('a', 'card' + (isFeatured ? ' featured' : ''));
  card.href = link || '#';
  card.dataset.n = String(n).padStart(2, '0');
  if (link) { card.target = '_blank'; card.rel = 'noopener noreferrer'; }

  // Missing art gets the striped placeholder, captioned with what belongs there.
  if (img) {
    const wrap = el('div', 'thumb');
    const pic = document.createElement('img');
    pic.alt = '';
    pic.loading = 'lazy';
    pic.decoding = 'async';
    // A listener rather than an onerror attribute: the CSP no longer allows an
    // inline handler, and this one cannot be confused with feed content.
    pic.addEventListener('error', () => {
      wrap.className = 'thumb placeholder';
      wrap.replaceChildren(el('span', 'cap', t('imageUnavailable')));
    }, { once: true });
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
  body.appendChild(el('span', 'label', source));

  // lang on the element, not a guess from the page: an article with no
  // translation yet still renders in its own language, and the Bangla face
  // applies to exactly the text that is Bangla.
  const shown = shownLang(a);
  const title = el('h2', 'card-title');
  if (shown === 'bn') title.lang = 'bn';
  appendHighlighted(title, pick(a, 'title') || t('untitled'), searchQuery);
  body.appendChild(title);

  const descText = pick(a, 'desc');
  if (descText) {
    const desc = el('p', 'card-desc');
    if (shown === 'bn') desc.lang = 'bn';
    appendHighlighted(desc, descText, searchQuery);
    body.appendChild(desc);
  }

  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', 'age', timeAgo(a.pubDate) || '\u2014'));
  meta.appendChild(el('span', null, t('readArrow')));
  body.appendChild(meta);

  card.appendChild(body);
  return card;
}

function renderArticles() {
  const container = document.getElementById('feed-container');
  const q = searchQuery.toLowerCase();

  let articles = activeFilter === 'all'
    ? allArticles
    : allArticles.filter(a => a.sourceId === activeFilter);

  if (q) {
    // Across every language the article carries, so a Bangla query finds an
    // English article that has been translated, and the other way round.
    articles = articles.filter(a =>
      ['title', 'desc', 'titleBn', 'descBn', 'titleEn', 'descEn']
        .some(f => typeof a[f] === 'string' && a[f].toLowerCase().includes(q))
    );
  }

  document.getElementById('article-count').textContent =
    t(articles.length === 1 ? 'articleCountOne' : 'articleCount', { n: num(articles.length) });

  if (!articles.length) {
    visibleArticles = [];
    renderedCount = 0;
    if (feedObserver) feedObserver.disconnect();
    container.replaceChildren(notice('notice', t('emptyTitle'),
      q ? t('emptySearch', { query: searchQuery }) : t('emptySource')));
    return;
  }

  // Only a page of cards is put in the DOM at a time — a feed can hold
  // thousands of articles, and rendering them all makes every subsequent
  // repaint (theme switch, filtering, scrolling) crawl.
  visibleArticles = articles;
  featuredIndex   = (!q && activeFilter === 'all') ? articles.findIndex(a => a.img) : -1;
  renderedCount   = 0;

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
  slice.forEach((a, i) =>
    batch.appendChild(cardElement(a, renderedCount + i === featuredIndex, renderedCount + i + 1)));
  grid.appendChild(batch);
  renderedCount += slice.length;

  const progress = document.getElementById('feed-progress');
  if (progress) progress.textContent =
    t('shownOfTotal', { n: num(renderedCount), total: num(visibleArticles.length) });

  if (renderedCount >= visibleArticles.length) {
    const sentinel = document.getElementById('feed-sentinel');
    if (sentinel) sentinel.replaceChildren(
      el('span', 'label', t('endOfFeed', { n: num(visibleArticles.length) })));
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

// The one shape both the empty state and the load failure use.
function notice(className, heading, body) {
  const box = el('div', className);
  box.appendChild(el('h3', null, heading));
  box.appendChild(el('p', null, body));
  return box;
}

function showPageSummary(text, textBn) {
  summaryEn = text || '';
  summaryBn = textBn || '';
  renderSummary();
}

function renderSummary() {
  const box = document.getElementById('page-summary');
  // Falls back to English when the translation hasn't landed yet, rather
  // than dropping the briefing off the page.
  const isBn = langMode === 'bn' && summaryBn;
  const text = isBn ? summaryBn : summaryEn;
  if (!text) { box.hidden = true; return; }

  const body = document.getElementById('page-summary-text');
  body.textContent = text;
  if (isBn) body.setAttribute('lang', 'bn'); else body.removeAttribute('lang');
  body.classList.add('clamped');

  const toggle = document.getElementById('summary-toggle');
  toggle.textContent = t('readMore');
  toggle.setAttribute('aria-expanded', 'false');
  box.hidden = false;
  renderFacts();
}

// Fills the space the 68ch measure leaves beside the prose, and puts the
// provenance where the system wants it: every number named and dated.
function renderFacts() {
  const when = fetchedAt ? formatFetched() : '\u2014';
  const rows = [
    [t('factRegion'),   regionLabel(activeRegion)],
    [t('factArticles'), num(allArticles.length)],
    [t('factSources'),  num(allSources.length)],
    [t('factFetched'),  when]
  ];
  const facts = document.createDocumentFragment();
  rows.forEach(([k, v]) => {
    const row = el('div', 'fact');
    row.appendChild(el('dt', null, k));
    row.appendChild(el('dd', null, v));
    facts.appendChild(row);
  });
  document.getElementById('brief-facts').replaceChildren(facts);
}

function toggleSummary() {
  const body = document.getElementById('page-summary-text');
  const toggle = document.getElementById('summary-toggle');
  const clamped = body.classList.toggle('clamped');
  toggle.textContent = t(clamped ? 'readMore' : 'showLess');
  toggle.setAttribute('aria-expanded', clamped ? 'false' : 'true');
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

/* ── Data ── */
async function loadData() {
  if (loading) return;
  loading = true;

  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  document.getElementById('refresh-label').textContent = t('fetching');
  setStatus('warn', t('statusLoading'), t('fetching') + ' ' + REGION_CONFIG[activeRegion].dataFile);
  showSkeletons();

  try {
    const base = window.location.pathname.replace(/[^/]*$/, '');
    const res  = await fetch(base + REGION_CONFIG[activeRegion].dataFile + '?t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data  = await res.json();
    // Only the fields an article actually has: spreading a fixed set would
    // give every article an own `titleBn` of undefined, which reads as "this
    // article has a Bangla field" to anything using `in`.
    allArticles = (data.articles || []).map(a => {
      const out = { ...a };
      for (const f of ['title', 'desc', 'titleBn', 'descBn', 'titleEn', 'descEn']) {
        if (typeof out[f] === 'string' && out[f]) out[f] = plainText(out[f]);
      }
      return out;
    });
    allSources  = data.sources  || [];

    // Stored as a Date rather than a formatted string: the format depends on
    // the selected language, and the language can change after the load.
    // renderProvenance puts it in all three places — masthead, Latest panel and
    // the footer, which below 560px is the only one still visible.
    fetchedAt = data.fetchedAt ? new Date(data.fetchedAt) : null;
    renderProvenance();

    showHeadlines(allArticles);
    showPageSummary(data.summary, data.summaryBn);
    setStatus('ok', t('statusLive'), regionLabel(activeRegion));
    buildFilterBar();
    renderArticles();

  } catch (e) {
    const box = notice('notice error', t('errorTitle'),
      t('errorBody', { file: REGION_CONFIG[activeRegion].dataFile, message: e.message }));
    box.appendChild(el('p', null, t('errorHint')));
    document.getElementById('feed-container').replaceChildren(box);
    setStatus('err', t('statusFailed'), t('errorTitle'));
    document.getElementById('article-count').textContent = '';
  }

  btn.disabled = false;
  document.getElementById('refresh-label').textContent = t('refresh');
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
  document.getElementById('refresh-btn').addEventListener('click', loadData);
  document.getElementById('summary-toggle').addEventListener('click', toggleSummary);
  document.getElementById('search-clear').addEventListener('click', clearSearch);
  document.getElementById('to-top').addEventListener('click', () => window.scrollTo({ top: 0 }));
  document.getElementById('search-input').addEventListener('input', e => onSearch(e.target.value));

  // Delegated, because the chips are rebuilt on every load and the tabs are
  // the same three buttons for the life of the page.
  document.querySelector('.tabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (tab) switchRegion(tab.dataset.region, tab);
  });
  document.getElementById('filter-bar').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip && chip.dataset.source) setFilter(chip.dataset.source, chip);
  });
}

/* ── Boot ── */
document.querySelectorAll('.tab').forEach(c => {
  c.setAttribute('aria-selected', c.dataset.region === activeRegion ? 'true' : 'false');
});
wireControls();
applyLanguage();
loadData();
