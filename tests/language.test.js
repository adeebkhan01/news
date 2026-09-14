'use strict';
//
// Tests for language detection and for the page's own translations.
//
// Two things here rot silently. A detector that is slightly wrong sends
// articles the wrong way through the translator and nobody notices until a
// Bangla headline shows up in the English view. And a dictionary key present
// in one language but not the other renders English inside a Bangla page —
// no error, no warning, just a word out of place.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const lang = require('../lib/lang.js');
const { REGIONS, SOURCE_LANG } = require('../fetch.js');

// ── Detection ────────────────────────────────────────────────────────────

test('detectLang: Bangla headlines', () => {
  // Both taken from data-bd.json, from the Rising BD feed.
  assert.equal(lang.detectLang('বাংলাদেশে মাদক নির্মূলে খেলাধুলার বিকল্প নেই: বিমানমন্ত্রী'), 'bn');
  assert.equal(lang.detectLang('১১ দলের ঢাকা-রংপুর লংমার্চ সফল করার আহ্বান'), 'bn');
  // Bangla carrying an English acronym is still Bangla.
  assert.equal(lang.detectLang('ঢাকায় BNP-র সমাবেশ'), 'bn');
  // Bengali numerals are Bengali.
  assert.equal(lang.detectLang('২০২৬'), 'bn');
});

test('detectLang: English headlines', () => {
  assert.equal(lang.detectLang('Israeli attack on Gaza kills two Palestinians'), 'en');
  assert.equal(lang.detectLang('AI staff genuinely frightened for humanity'), 'en');
});

test('detectLang: a taka sign does not make a headline Bangla', () => {
  // The regression this threshold exists for. ৳ is U+09F3, inside the Bengali
  // block, and this is a real Daily Star headline — an English one. A
  // "contains any Bengali character" test files it as Bangla and then asks the
  // model to translate English into English.
  assert.equal(lang.detectLang('Meghna Bank to raise ৳400 crore through subordinated bond'), 'en');
  assert.equal(lang.detectLang('Reserves fall below ৳2,000 crore, says central bank'), 'en');
});

test('detectLang: no opinion on text it cannot judge', () => {
  // null, not a guess — the caller falls back to what the source declares.
  assert.equal(lang.detectLang(''), null);
  assert.equal(lang.detectLang('   '), null);
  assert.equal(lang.detectLang('— · !!'), null);
  assert.equal(lang.detectLang(null), null);
  assert.equal(lang.detectLang(undefined), null);
});

test('articleLang: the text decides, the source is the fallback', () => {
  assert.equal(lang.articleLang({ title: 'A plain English headline' }, 'bn'), 'en');
  assert.equal(lang.articleLang({ title: 'বাংলা শিরোনাম' }, 'en'), 'bn');
  // Only when the text says nothing does the source's declaration count.
  assert.equal(lang.articleLang({ title: '—' }, 'bn'), 'bn');
  assert.equal(lang.articleLang({ title: '' }, undefined), 'en');
});

test('translation direction follows the article, not a fixed assumption', () => {
  assert.equal(lang.targetLang({ lang: 'en' }), 'bn');
  assert.equal(lang.targetLang({ lang: 'bn' }), 'en');
  assert.equal(lang.targetLang({}), 'bn');            // unstamped data is English
  assert.equal(lang.translatedField({ lang: 'en' }, 'title'), 'titleBn');
  assert.equal(lang.translatedField({ lang: 'bn' }, 'title'), 'titleEn');
  assert.equal(lang.translatedField({ lang: 'bn' }, 'desc'), 'descEn');
});

test('the Bangla-language source is declared as such', () => {
  // Rising BD publishes in Bangla. If that declaration is lost, articles whose
  // titles are too short to judge go the wrong way.
  assert.equal(SOURCE_LANG.risingbd, 'bn');
  const risingbd = REGIONS.bd.sources.find(s => s.id === 'risingbd');
  assert.ok(risingbd, 'Rising BD is no longer configured');
  assert.equal(risingbd.lang, 'bn');
  // Every other source is English, which is the default, so it says nothing.
  for (const region of Object.values(REGIONS)) {
    for (const s of region.sources) {
      if (s.id === 'risingbd') continue;
      assert.ok(s.lang === undefined, `${s.id} declares lang: ${s.lang} — is that intended?`);
    }
  }
});

// ── The page's own words ─────────────────────────────────────────────────

// STRINGS lives in app.js, which is browser code and cannot be required here.
// Pulling the two dictionaries out by brace matching is enough to compare
// their key sets, which is the thing that goes wrong.
const appJs = fs.readFileSync('app.js', 'utf8');

function dictionaryKeys(name) {
  const start = appJs.indexOf(name + ': {');
  assert.notEqual(start, -1, `no ${name} dictionary in app.js`);
  let depth = 0, end = -1;
  for (let i = appJs.indexOf('{', start); i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  assert.notEqual(end, -1, `unbalanced braces in the ${name} dictionary`);
  return [...appJs.slice(start, end).matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map(m => m[1]);
}

test('the two dictionaries have exactly the same keys', () => {
  const en = dictionaryKeys('  en');
  const bn = dictionaryKeys('  bn');
  assert.ok(en.length > 40, `only ${en.length} English strings — did the dictionary get truncated?`);
  assert.deepEqual(
    en.filter(k => !bn.includes(k)), [],
    'these keys have no Bangla translation, so they would render in English on a Bangla page'
  );
  assert.deepEqual(bn.filter(k => !en.includes(k)), [], 'these Bangla keys have no English counterpart');
});

test('no Bangla string was left as its English placeholder', () => {
  // A key copied across and not translated is worse than a missing one: the
  // parity test above passes and the page still shows English.
  const start = appJs.indexOf('  bn: {');
  const block = appJs.slice(start, appJs.indexOf('\n  }', start));
  const untranslated = [];
  for (const m of block.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):\s*'([^']*)'/gm)) {
    const [, key, value] = m;
    // Some values are legitimately non-Bangla: interpolation-only strings and
    // ones that name GitHub features by their English UI labels.
    if (!/[ঀ-৿]/.test(value) && /[A-Za-z]{4}/.test(value)) untranslated.push(key);
  }
  assert.deepEqual(untranslated, [], 'these Bangla values contain no Bengali script');
});

test('every key the page asks for exists', () => {
  const en = dictionaryKeys('  en');
  const html = fs.readFileSync('index.html', 'utf8');

  const markup = [...html.matchAll(/data-i18n(?:-placeholder|-label)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(markup.length > 10, 'the markup stopped declaring its translatable strings');
  assert.deepEqual(markup.filter(k => !en.includes(k)), [], 'markup asks for keys the dictionary lacks');

  const called = [...appJs.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)].map(m => m[1]);
  assert.deepEqual(called.filter(k => !en.includes(k)), [], 'app.js asks for keys the dictionary lacks');
});

test('every interpolation slot is filled in both languages', () => {
  // '{n} articles' translated as a string with no {n} drops the number
  // silently. The slots have to survive translation.
  const enStart = appJs.indexOf('  en: {');
  const bnStart = appJs.indexOf('  bn: {');
  const slots = (from, to) => {
    const out = {};
    for (const m of appJs.slice(from, to).matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):\s*'([^']*)'/gm)) {
      out[m[1]] = [...m[2].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort();
    }
    return out;
  };
  const en = slots(enStart, bnStart);
  const bn = slots(bnStart, appJs.indexOf('\n  }', bnStart));
  for (const key of Object.keys(en)) {
    assert.deepEqual(bn[key], en[key], `'${key}' has different interpolation slots in en and bn`);
  }
});

// ── The data on disk ─────────────────────────────────────────────────────

test('no stored article claims a language its text contradicts', () => {
  // Once fetch.js has stamped them, an article's `lang` should agree with what
  // the detector says about its own title.
  for (const file of ['data-bd.json', 'data-au.json', 'data-global.json']) {
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const a of data.articles || []) {
      if (!a.lang) continue;                       // not yet migrated; the next run stamps it
      const detected = lang.detectLang(a.title);
      if (!detected) continue;                     // no opinion, nothing to contradict
      assert.equal(a.lang, detected, `${file}: "${String(a.title).slice(0, 50)}" is stamped ${a.lang}`);
    }
  }
});

test('a Bangla article never stores a Bangla "translation" of itself', () => {
  // The bug that started this: Bangla text was sent to be translated into
  // Bangla, came back unchanged, and cost money to produce a duplicate.
  for (const file of ['data-bd.json', 'data-au.json', 'data-global.json']) {
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const a of data.articles || []) {
      if (a.lang !== 'bn') continue;
      assert.ok(!('titleBn' in a), `${file}: a Bangla article still carries titleBn`);
      assert.ok(!('descBn' in a), `${file}: a Bangla article still carries descBn`);
    }
  }
});
