'use strict';
let allArticles  = [];
let allSources   = [];
let activeFilter = 'all';
let searchQuery  = '';
let loading      = false;
let langMode     = 'en';
let activeRegion = localStorage.getItem('news-region') || 'bd';
let searchTimer  = null;
let summaryEn    = '';
let summaryBn    = '';
let lastFetched  = '';

const PAGE_SIZE = 24;
let visibleArticles = [];
let renderedCount   = 0;
let featuredIndex   = -1;
let feedObserver    = null;

// hasLang mirrors `translate` in fetch.js: it says the region's data file
// carries Bangla, not that every article in it does. A region whose backlog is
// still draining renders untranslated articles in English either way.
const REGION_CONFIG = {
  bd:     { label: 'Bangladesh', mark: 'BD', dataFile: 'data-bd.json',     hasLang: true },
  au:     { label: 'Australia',  mark: 'AU', dataFile: 'data-au.json',     hasLang: true },
  global: { label: 'Global',     mark: 'GL', dataFile: 'data-global.json', hasLang: true }
};

/* ── Theme ── */
function applyThemeLabel() {
  // The button names what it will do, so no icon has to be invented.
  document.getElementById('theme-label').textContent =
    document.documentElement.getAttribute('data-theme') === 'night' ? 'Day' : 'Night';
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
  const t = Date.parse(dateStr);
  if (!t) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff / 60)    + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600)  + 'h ago';
  return                   Math.floor(diff / 86400) + 'd ago';
}

/* ── Language ── */
function toggleLang() {
  langMode = langMode === 'en' ? 'bn' : 'en';
  const btn = document.getElementById('lang-toggle');
  btn.textContent = langMode === 'bn' ? 'English' : 'বাংলা';
  btn.setAttribute('lang', langMode === 'bn' ? 'en' : 'bn');
  btn.classList.toggle('bn', langMode === 'bn');
  renderArticles();
  showHeadlines(allArticles);
  renderSummary();
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
  document.getElementById('logo-edition').textContent = cfg.label;
  document.title = 'Daily Digest — ' + cfg.label;

  const langBtn = document.getElementById('lang-toggle');
  langBtn.style.display = cfg.hasLang ? '' : 'none';
  if (!cfg.hasLang && langMode !== 'en') {
    langMode = 'en';
    langBtn.textContent = 'বাংলা';
    langBtn.setAttribute('lang', 'bn');
    langBtn.classList.remove('bn');
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

  const allBtn = el('button', 'chip' + (activeFilter === 'all' ? ' active' : ''), 'All sources');
  allBtn.dataset.source = 'all';
  bar.appendChild(allBtn);

  allSources.forEach(s => {
    const count = counts[s.id] || 0;
    if (!count) return;
    const btn = el('button', 'chip' + (activeFilter === s.id ? ' active' : ''));
    btn.dataset.source = s.id;
    btn.appendChild(document.createTextNode(s.name));
    btn.appendChild(el('span', 'count', String(count)));
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
  const isBn   = langMode === 'bn' && a.titleBn;
  const source = a.sourceName || 'Unknown';
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
      wrap.replaceChildren(el('span', 'cap', 'Image unavailable'));
    }, { once: true });
    pic.src = img;
    wrap.appendChild(pic);
    card.appendChild(wrap);
  } else {
    const wrap = el('div', 'thumb placeholder');
    wrap.appendChild(el('span', 'cap', 'No image \u00B7 ' + source));
    card.appendChild(wrap);
  }

  const body = el('div', 'card-body');
  if (isFeatured) body.appendChild(el('span', 'lead-badge', 'Lead story'));
  body.appendChild(el('span', 'label', source));

  const title = el('h2', 'card-title');
  if (isBn) title.lang = 'bn';
  appendHighlighted(title, isBn ? a.titleBn : (a.title || 'Untitled'), searchQuery);
  body.appendChild(title);

  const descText = isBn ? (a.descBn || '') : (a.desc || '');
  if (descText) {
    const desc = el('p', 'card-desc');
    if (isBn) desc.lang = 'bn';
    appendHighlighted(desc, descText, searchQuery);
    body.appendChild(desc);
  }

  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', 'age', timeAgo(a.pubDate) || '\u2014'));
  meta.appendChild(el('span', null, 'Read \u2192'));
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
    articles = articles.filter(a =>
      (a.title || '').toLowerCase().includes(q) ||
      (a.desc  || '').toLowerCase().includes(q) ||
      (a.titleBn || '').toLowerCase().includes(q)
    );
  }

  document.getElementById('article-count').textContent =
    articles.length.toLocaleString() + (articles.length === 1 ? ' article' : ' articles');

  if (!articles.length) {
    visibleArticles = [];
    renderedCount = 0;
    if (feedObserver) feedObserver.disconnect();
    container.replaceChildren(notice('notice', 'Nothing here yet',
      q ? 'No headlines match \u201C' + searchQuery + '\u201D. Widen the term or clear the filter.'
        : 'This source has published nothing in the retained window. Pick another source or region.'));
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
  if (progress) progress.textContent = renderedCount + ' / ' + visibleArticles.length + ' shown';

  if (renderedCount >= visibleArticles.length) {
    const sentinel = document.getElementById('feed-sentinel');
    if (sentinel) sentinel.replaceChildren(
      el('span', 'label', 'End of feed \u00B7 ' + visibleArticles.length + ' shown'));
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
  toggle.textContent = 'Read more';
  toggle.setAttribute('aria-expanded', 'false');
  box.hidden = false;
  renderFacts();
}

// Fills the space the 68ch measure leaves beside the prose, and puts the
// provenance where the system wants it: every number named and dated.
function renderFacts() {
  const rows = [
    ['Region',   REGION_CONFIG[activeRegion].label],
    ['Articles', allArticles.length.toLocaleString()],
    ['Sources',  String(allSources.length)],
    ['Fetched',  lastFetched || '—']
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
  toggle.textContent = clamped ? 'Read more' : 'Show less';
  toggle.setAttribute('aria-expanded', clamped ? 'false' : 'true');
}

function showHeadlines(articles) {
  const list = document.getElementById('headlines-list');
  if (!articles || !articles.length) { list.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  articles.slice(0, 6).forEach(a => {
    const link = safeURL(a.link);
    const isBn = langMode === 'bn' && a.titleBn;
    const item = el('li', 'headline-item');
    const anchor = el('a', 'headline-title', isBn ? a.titleBn : (a.title || ''));
    anchor.href = link || '#';
    if (isBn) anchor.lang = 'bn';
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
  document.getElementById('refresh-label').textContent = 'Fetching';
  setStatus('warn', 'Loading', 'Fetching ' + REGION_CONFIG[activeRegion].dataFile);
  showSkeletons();

  try {
    const base = window.location.pathname.replace(/[^/]*$/, '');
    const res  = await fetch(base + REGION_CONFIG[activeRegion].dataFile + '?t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data  = await res.json();
    allArticles = (data.articles || []).map(a => ({
      ...a,
      title:   plainText(a.title),
      desc:    plainText(a.desc),
      titleBn: a.titleBn ? plainText(a.titleBn) : a.titleBn,
      descBn:  a.descBn  ? plainText(a.descBn)  : a.descBn
    }));
    allSources  = data.sources  || [];

    if (data.fetchedAt) {
      const fetched = new Date(data.fetchedAt);
      lastFetched = fetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        + ' · ' + fetched.toLocaleDateString([], { day: '2-digit', month: 'short' });
      document.getElementById('last-updated').textContent = 'Fetched ' + lastFetched;
      document.getElementById('latest-provenance').textContent = lastFetched;
      // The masthead's copy goes at 560px and the facts list at 700px, so on a
      // phone this is the only place the fetch time survives.
      document.getElementById('foot-provenance').textContent =
        'Refreshed twice daily via GitHub Actions \u2014 last ' + lastFetched;
    }

    showHeadlines(allArticles);
    showPageSummary(data.summary, data.summaryBn);
    setStatus('ok', 'Live', REGION_CONFIG[activeRegion].label);
    buildFilterBar();
    renderArticles();

  } catch (e) {
    const box = notice('notice error', 'No data file',
      REGION_CONFIG[activeRegion].dataFile + ' did not load: ' + e.message + '.');
    box.appendChild(el('p', null, 'Run the Fetch RSS Feeds workflow in Actions, then reload.'));
    document.getElementById('feed-container').replaceChildren(box);
    setStatus('err', 'Failed', 'No data file');
    document.getElementById('article-count').textContent = '';
  }

  btn.disabled = false;
  document.getElementById('refresh-label').textContent = 'Refresh';
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
applyRegionChrome();
loadData();
