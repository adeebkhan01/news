'use strict';
//
// Regression tests for the egress policy and the untrusted-input validators.
//
//   node --test tests/
//
// These are the tests that are supposed to fail when someone widens the rules
// by accident: a feed added over http, a suffix that turns one publisher's
// domain into every domain under a ccTLD, a javascript: URL surviving into an
// href, a model answer with a tag in it reaching the data file.
//
// No network. Everything here is a pure function of its input, which is the
// reason the policy lives in its own module.

const test = require('node:test');
const assert = require('node:assert');

const sec = require('../lib/security.js');
const { REGIONS, POLICY, sanitizeLink, sanitizeImage } = require('../fetch.js');

// ── Registrable domains ──────────────────────────────────────────────────

test('registrableDomain: ordinary two-label domains', () => {
  assert.equal(sec.registrableDomain('rss.cnn.com'), 'cnn.com');
  assert.equal(sec.registrableDomain('en.prothomalo.com'), 'prothomalo.com');
  assert.equal(sec.registrableDomain('theconversation.com'), 'theconversation.com');
  assert.equal(sec.registrableDomain('WWW.Aljazeera.COM'), 'aljazeera.com');
});

test('registrableDomain: two-label public suffixes are not registrable domains', () => {
  // The bug this exists to prevent: reading unb.com.bd as com.bd would put
  // every commercial host in Bangladesh inside the allowlist.
  assert.equal(sec.registrableDomain('unb.com.bd'), 'unb.com.bd');
  assert.equal(sec.registrableDomain('www.smh.com.au'), 'smh.com.au');
  assert.equal(sec.registrableDomain('www.abc.net.au'), 'abc.net.au');
  assert.equal(sec.registrableDomain('feeds.bbci.co.uk'), 'bbci.co.uk');
  assert.equal(sec.registrableDomain('live-production.wcms.abc-cdn.net.au'), 'abc-cdn.net.au');
});

test('registrableDomain: a bare suffix does not become a domain', () => {
  assert.equal(sec.registrableDomain('com.bd'), 'com.bd');
  assert.notEqual(sec.registrableDomain('attacker.com.bd'), 'com.bd');
});

// ── URL policy ───────────────────────────────────────────────────────────

test('parseSafeUrl: accepts plain https', () => {
  assert.ok(sec.parseSafeUrl('https://www.bbc.co.uk/news/article'));
});

test('parseSafeUrl: refuses every non-https scheme', () => {
  for (const bad of [
    'http://www.bbc.co.uk/news',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'vbscript:msgbox(1)',
    '//evil.example.com/x',
    'not a url',
    ''
  ]) {
    assert.equal(sec.parseSafeUrl(bad), null, `should refuse: ${bad}`);
  }
});

test('parseSafeUrl: refuses credentials, odd ports and address literals', () => {
  assert.equal(sec.parseSafeUrl('https://user:pass@www.bbc.co.uk/x'), null);
  assert.equal(sec.parseSafeUrl('https://www.bbc.co.uk:8443/x'), null);
  assert.equal(sec.parseSafeUrl('https://93.184.216.34/x'), null);
  assert.equal(sec.parseSafeUrl('https://[::1]/x'), null);
});

test('parseSafeUrl: refuses the runner and its neighbours (SSRF)', () => {
  for (const bad of [
    'https://localhost/x',
    'https://app.localhost/x',
    'https://127.0.0.1/x',
    'https://0.0.0.0/x',
    'https://10.0.0.5/x',
    'https://172.16.5.4/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data/',   // cloud instance metadata
    'https://100.64.0.1/x',
    'https://printer.local/x',
    'https://vault.internal/x'
  ]) {
    assert.equal(sec.parseSafeUrl(bad), null, `should refuse: ${bad}`);
  }
});

// ── The policy built from the real source list ───────────────────────────

test('every configured feed URL is accepted by the policy that was built from it', () => {
  assert.deepEqual(POLICY.invalid, [], 'a configured feed URL was rejected');
  for (const region of Object.values(REGIONS)) {
    for (const s of region.sources) {
      assert.ok(sec.isAllowedFeedUrl(s.url, POLICY), `feed not allowed: ${s.url}`);
    }
  }
});

test('feed matching is exact, not by domain', () => {
  // A host being on the list does not make every path on it a feed.
  assert.ok(!sec.isAllowedFeedUrl('https://rss.cnn.com/rss/anything-else.rss', POLICY));
  assert.ok(!sec.isAllowedFeedUrl('https://www.theguardian.com/', POLICY));
});

test('article links: publishers yes, everyone else no', () => {
  assert.ok(sec.isAllowedArticleUrl('https://www.theguardian.com/world/2026/story', POLICY));
  assert.ok(sec.isAllowedArticleUrl('https://edition.cnn.com/2026/09/13/story', POLICY));
  // The BBC's feed is on bbci.co.uk and its articles are on bbc.co.uk, which
  // only works because the source declares linkDomains.
  assert.ok(sec.isAllowedArticleUrl('https://www.bbc.co.uk/news/articles/abc', POLICY));
  assert.ok(sec.isAllowedArticleUrl('https://www.bbc.com/news/articles/abc', POLICY));

  assert.ok(!sec.isAllowedArticleUrl('https://evil.example.com/x', POLICY));
  assert.ok(!sec.isAllowedArticleUrl('https://theguardian.com.evil.example/x', POLICY));
  assert.ok(!sec.isAllowedArticleUrl('https://nottheguardian.com/x', POLICY));
  assert.ok(!sec.isAllowedArticleUrl('https://169.254.169.254/', POLICY));
});

test('image hosts: the CDNs the data files actually use', () => {
  for (const good of [
    'https://static.ffx.io/images/x.jpg',                              // SMH
    'https://i.guim.co.uk/img/media/x.jpg',                            // Guardian
    'https://ichef.bbci.co.uk/news/1024/x.jpg',                        // BBC
    'https://live-production.wcms.abc-cdn.net.au/x.jpg',               // ABC
    'https://media.prothomalo.com/x.jpg',                              // Prothom Alo
    'https://images.theconversation.com/files/x.jpg',                  // The Conversation
    'https://static.dw.com/image/x.jpg'                                // DW
  ]) {
    assert.ok(sec.isAllowedImageUrl(good, POLICY), `image should be allowed: ${good}`);
  }
  assert.ok(!sec.isAllowedImageUrl('https://tracker.example.com/pixel.gif', POLICY));
  assert.ok(!sec.isAllowedImageUrl('http://static.ffx.io/x.jpg', POLICY));
});

test('a multi-tenant CDN is allowed by exact host, never by domain', () => {
  // NPR publishes art from its own tenant on Brightspot, a CMS vendor with
  // many customers. Trusting the registrable domain would trust all of them,
  // which is the mistake this split exists to prevent.
  assert.ok(sec.isAllowedImageUrl('https://npr.brightspotcdn.com/dims3/x.jpg', POLICY));
  assert.ok(!sec.isAllowedImageUrl('https://brightspotcdn.com/x.jpg', POLICY));
  assert.ok(!sec.isAllowedImageUrl('https://someone-else.brightspotcdn.com/x.jpg', POLICY));
  // And the reverse holds for a domain a publisher actually owns.
  assert.ok(sec.isAllowedImageUrl('https://anything.guim.co.uk/x.jpg', POLICY));
});

test('no shared CDN is trusted by registrable domain', () => {
  // A guess at shared infrastructure is worse than no entry: it admits every
  // tenant. An entry earns its place by a real article using it, named exactly.
  for (const shared of ['cloudfront.net', 'akamaized.net', 'wp.com', 'brightspotcdn.com',
                        'amazonaws.com', 'fastly.net', 'cdn.ampproject.org']) {
    assert.ok(!POLICY.imageDomains.has(shared), `${shared} must not be a trusted image domain`);
  }
});

// ── What the parsers do with hostile feed content ────────────────────────

test('sanitizeLink: an href a feed cannot poison', () => {
  assert.equal(sanitizeLink('javascript:alert(document.domain)'), '');
  assert.equal(sanitizeLink('data:text/html;base64,PHNjcmlwdD4='), '');
  assert.equal(sanitizeLink('http://www.bbc.co.uk/news'), '');
  assert.equal(sanitizeLink(''), '');
  assert.equal(sanitizeLink(null), '');
  assert.equal(sanitizeLink('https://www.bbc.co.uk/news'), 'https://www.bbc.co.uk/news');
});

test('sanitizeLink keeps a link we show but would not fetch', () => {
  // Syndication: showing a link and opening one are different decisions.
  const syndicated = 'https://apnews.com/article/x';
  assert.equal(sanitizeLink(syndicated), syndicated);
  assert.ok(!sec.isAllowedArticleUrl(syndicated, POLICY));
});

test('sanitizeImage: relative URLs resolve, foreign hosts drop', () => {
  const base = 'https://www.theguardian.com/world/2026/story';
  assert.equal(sanitizeImage('/img/x.jpg', base), 'https://www.theguardian.com/img/x.jpg');
  assert.equal(sanitizeImage('https://i.guim.co.uk/x.jpg', base), 'https://i.guim.co.uk/x.jpg');
  assert.equal(sanitizeImage('https://tracker.example.com/p.gif', base), null);
  assert.equal(sanitizeImage('javascript:alert(1)', base), null);
  assert.equal(sanitizeImage(null, base), null);
});

// ── Model output ─────────────────────────────────────────────────────────

test('sanitizeModelText: ordinary prose passes through', () => {
  assert.equal(sec.sanitizeModelText('  A normal briefing sentence.  ', 100), 'A normal briefing sentence.');
  assert.equal(sec.sanitizeModelText('বাংলাদেশের রাজনৈতিক পরিস্থিতি', 100), 'বাংলাদেশের রাজনৈতিক পরিস্থিতি');
});

test('sanitizeModelText: refuses markup, overlength, control characters, credentials', () => {
  assert.equal(sec.sanitizeModelText('<script>alert(1)</script>', 100), null);
  assert.equal(sec.sanitizeModelText('<img src=x onerror=alert(1)>', 100), null);
  assert.equal(sec.sanitizeModelText('</div> escaped out', 100), null);
  assert.equal(sec.sanitizeModelText('<!-- comment -->', 100), null);
  assert.equal(sec.sanitizeModelText('x'.repeat(101), 100), null);
  assert.equal(sec.sanitizeModelText('   ', 100), null);
  assert.equal(sec.sanitizeModelText('', 100), null);
  assert.equal(sec.sanitizeModelText(42, 100), null);
  assert.equal(sec.sanitizeModelText(null, 100), null);
  assert.equal(sec.sanitizeModelText({ titleBn: 'x' }, 100), null);
  // A leaked key must never reach a file that gets committed.
  assert.equal(sec.sanitizeModelText('my key is sk-ant-api03-xxxx', 100), null);
  // Zero-width and bidi characters are stripped rather than published.
  assert.equal(sec.sanitizeModelText('safe​text', 100), 'safetext');
});

test('validateTranslation: the declared shape, or nothing', () => {
  // The keys are direction-independent: the model is asked for title/desc
  // whichever way it is translating, and the caller files the answer under the
  // field for the direction it asked for.
  assert.deepEqual(
    sec.validateTranslation({ title: 'শিরোনাম', desc: 'বিবরণ' }),
    { title: 'শিরোনাম', desc: 'বিবরণ' }
  );
  assert.deepEqual(
    sec.validateTranslation({ title: 'A headline', desc: 'A description' }),
    { title: 'A headline', desc: 'A description' }
  );
  // An empty description is legitimate; an empty title is not a translation.
  assert.deepEqual(sec.validateTranslation({ title: 'শিরোনাম', desc: '' }), { title: 'শিরোনাম', desc: '' });
  assert.equal(sec.validateTranslation({ desc: 'বিবরণ' }), null);
  assert.equal(sec.validateTranslation({ title: '<b>শিরোনাম</b>' }), null);
  assert.equal(sec.validateTranslation({ title: 123 }), null);
  assert.equal(sec.validateTranslation(['শিরোনাম']), null);
  assert.equal(sec.validateTranslation('শিরোনাম'), null);
  assert.equal(sec.validateTranslation(null), null);
  // The old one-directional shape is no longer accepted, so a stale prompt
  // fails loudly instead of writing undefined into the data file.
  assert.equal(sec.validateTranslation({ titleBn: 'শিরোনাম', descBn: '' }), null);
  // A description that fails on its own does not cost the title.
  assert.deepEqual(
    sec.validateTranslation({ title: 'শিরোনাম', desc: '<script>x</script>' }),
    { title: 'শিরোনাম', desc: '' }
  );
});

test('validateSummary: prose in, markup out', () => {
  assert.equal(sec.validateSummary('A three sentence briefing.'), 'A three sentence briefing.');
  assert.equal(sec.validateSummary('<p>A briefing.</p>'), null);
  assert.equal(sec.validateSummary('x'.repeat(2001)), null);
});

// ── The data already on disk ─────────────────────────────────────────────

test('every committed article satisfies the rules it will be re-checked against', () => {
  const fs = require('node:fs');
  for (const file of ['data-bd.json', 'data-au.json', 'data-global.json']) {
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const a of data.articles || []) {
      assert.ok(sec.parseSafeUrl(a.link), `${file}: unsafe link ${a.link}`);
      if (a.img) {
        assert.ok(sec.isAllowedImageUrl(a.img, POLICY), `${file}: image host not allowed: ${a.img}`);
      }
    }
  }
});
