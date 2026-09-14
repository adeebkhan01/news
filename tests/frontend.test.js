'use strict';
//
// Tests for the things the page promises about itself.
//
// The Content-Security-Policy is a string in a static file, and the rules it
// has to agree with live in JavaScript. Nothing but a test keeps the two
// honest: a CSP that has drifted still looks fine, still parses, and quietly
// stops enforcing the thing it was written for. Same for the inline bootstrap
// script's hash — edit the script, forget the hash, and the theme flash comes
// back with no error anywhere.
//
// These are text assertions over the shipped files, so they run without a
// browser. What a browser actually enforces was checked separately; this is
// what stops it regressing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');

const html = fs.readFileSync('index.html', 'utf8');
const appJs = fs.readFileSync('app.js', 'utf8');

// HTML tag matching is case-insensitive and tolerates whitespace, so these
// patterns have to be too. A test that only recognises one spelling of a tag
// does not fail when someone writes another — it silently stops checking, which
// is the worst outcome available to a test whose whole job is a guarantee.
function cspDirectives() {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(m, 'no Content-Security-Policy meta tag');
  const out = {};
  m[1].split(';').forEach(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  });
  return out;
}

test('the CSP allows no inline script or style', () => {
  const csp = cspDirectives();
  assert.ok(!csp['script-src'].includes("'unsafe-inline'"));
  assert.ok(!csp['style-src'].includes("'unsafe-inline'"));
  assert.ok(!csp['script-src'].includes("'unsafe-eval'"));
  assert.deepEqual(csp['default-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'none'"]);
  assert.deepEqual(csp['connect-src'], ["'self'"]);
});

// Every script tag in the page, split by whether it loads a file. <SCRIPT>,
// <script >, and <script> are one tag to a browser.
function scriptTags() {
  const tags = [...html.matchAll(/<script\b([^>]*)>/gi)];
  const hasSrc = t => /\bsrc\s*=/i.test(t[1]);
  return { inline: tags.filter(t => !hasSrc(t)), external: tags.filter(hasSrc) };
}

test('the inline bootstrap script matches the hash the CSP allows', () => {
  // The negative lookahead is what keeps this off <script src="app.js">, which
  // has no body to hash.
  const m = html.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/i);
  assert.ok(m, 'the theme bootstrap script is gone — drop its hash from the CSP too');
  const hash = 'sha256-' + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
  assert.ok(
    cspDirectives()['script-src'].includes("'" + hash + "'"),
    `the bootstrap script changed but the CSP hash did not. Correct value:\n  '${hash}'`
  );
});

test('index.html carries exactly one inline script and two external ones', () => {
  // The inline theme bootstrap needs a hash — everything else is a file, so
  // it is the one hash to keep current. app.js is one external script;
  // vendor/sql-wasm's glue code, loaded before it so initSqlJs exists by the
  // time app.js runs, is the other.
  const { inline, external } = scriptTags();
  assert.equal(inline.length, 1, `expected one inline script, found ${inline.length}`);
  assert.equal(external.length, 2, `expected two external scripts, found ${external.length}`);
  assert.match(html, /<script src="app\.js\?v=[0-9a-f]{12}" defer><\/script>/);
  assert.match(html, /<script src="vendor\/sql-wasm-[\d.]+\.js" defer><\/script>/);
  // Document order, not just presence: initSqlJs must exist before app.js's
  // deferred code runs and calls it.
  assert.ok(html.indexOf('vendor/sql-wasm') < html.indexOf('src="app.js'),
    'sql-wasm must be loaded before app.js in document order');
});

test('app.js and app.css are requested at a URL that changes with them', () => {
  // index.html used to be the whole front end, so a deploy was atomic. Split
  // into files, a fresh index.html can pair with a browser-cached app.js and
  // the page half-updates with no error anywhere — which is exactly what it
  // did. A content hash in the query string makes a changed file a different
  // URL, so a stale copy cannot be served for one.
  for (const [file, pattern] of [
    ['app.css', /href="app\.css\?v=([0-9a-f]{12})"/],
    ['app.js',  /src="app\.js\?v=([0-9a-f]{12})"/]
  ]) {
    const m = html.match(pattern);
    assert.ok(m, `${file} is referenced without a ?v= content hash`);
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    assert.equal(m[1], actual,
      `${file} changed but index.html still asks for ?v=${m[1]}. Correct value: ${actual}`);
  }
});

test('the markup carries no inline event handlers and no style attributes', () => {
  // An onclick attribute is inline script; a style attribute is inline style.
  // Both are refused by the CSP, so a page that still had them would simply
  // stop working in that spot rather than fail loudly.
  const handlers = html.match(/\son(?:click|input|error|load|change|submit|focus|blur|mouse\w+|key\w+)\s*=/gi);
  assert.equal(handlers, null, `inline handler(s) in index.html: ${handlers}`);
  const styles = html.match(/\sstyle\s*=\s*"/gi);
  assert.equal(styles, null, `style attribute(s) in index.html: ${styles}`);
});

test('img-src names no publisher CDN, because none is ever loaded', () => {
  // Article art is downloaded by the fetch pipeline and committed alongside
  // the data files (localizeImages in fetch.js) rather than hotlinked, so
  // the page only ever loads an image from its own origin — no per-publisher
  // domain to keep in sync here the way POLICY.imageDomains still is,
  // server-side, for what the fetcher is willing to download from.
  const imgSrc = cspDirectives()['img-src'];
  assert.deepEqual([...imgSrc].sort(), ["'self'", 'data:'].sort());
});

test('app.js never turns feed data into markup', () => {
  // The reason the escaping helper could be deleted: there is nothing left to
  // escape for. If innerHTML comes back, so does the whole class of bug.
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!appJs.includes(sink), `app.js uses ${sink}`);
  }
  // eval and Function are how a CSP with 'unsafe-eval' gets asked for.
  assert.ok(!/\beval\s*\(/.test(appJs), 'app.js calls eval');
  assert.ok(!/\bnew Function\s*\(/.test(appJs), 'app.js calls new Function');
});

test("the vendored sql.js build does not need 'unsafe-eval'", () => {
  // The CSP grants 'wasm-unsafe-eval' and nothing broader — that is only
  // defensible as long as the library actually only needs the narrow
  // grant. If a future version of the vendor file starts using eval or
  // new Function (an asm.js fallback path does), the CSP would need
  // 'unsafe-eval' too, and that is a real widening worth catching here
  // rather than discovering as a silent CSP violation in production.
  const files = fs.readdirSync('vendor').filter(f => f.endsWith('.js'));
  assert.ok(files.length, 'no vendored .js file found');
  for (const file of files) {
    const src = fs.readFileSync('vendor/' + file, 'utf8');
    assert.ok(!/\beval\s*\(/.test(src), `vendor/${file} calls eval`);
    assert.ok(!/\bnew Function\s*\(/.test(src), `vendor/${file} calls new Function`);
  }
});

test('app.js sets link and image URLs only through a validator', () => {
  // Belt and braces over the fetcher's own check: the page is also served from
  // a data file someone could edit by hand. Links go through safeURL
  // (https:// only); article art goes through safeImagePath (the exact
  // images/<region>/<hash>.<ext> shape the fetch pipeline writes) since it's
  // downloaded and committed rather than hotlinked.
  assert.ok(appJs.includes('function safeURL'));
  assert.ok(appJs.includes('function safeImagePath'));
  const assignments = appJs.match(/\.(?:href|src)\s*=\s*([^;\n]+)/g) || [];
  for (const line of assignments) {
    assert.ok(
      /safeURL|safeImagePath|link \|\| '#'|\blink\b|\bimg\b/.test(line),
      `a URL is assigned without going through a validator: ${line}`
    );
  }
});

test('the featured card is always the first card in the DOM, never a later one', () => {
  // Regression: featuredIndex used to be articles.findIndex(a => a.img),
  // picking whichever story had a picture — which could be the *second*
  // story if the top-ranked one had none. The featured card carries
  // grid-column:1/-1, so CSS Grid pushed it to a new row rather than share
  // row one with the card ahead of it, leaving row one a single narrow card
  // followed by empty columns and a wide gap before the sidebar. The fix is
  // that the hero slot is always index 0 (or none at all) — an image-less
  // top story gets the same placeholder every other image-less card gets,
  // rather than being skipped over.
  assert.ok(!/articles\.findIndex\(a\s*=>\s*a\.img\)/.test(appJs),
    'featuredIndex is picking a card by image again — this reintroduces the grid gap bug');
  assert.match(appJs, /featuredIndex\s*=\s*\([^)]*\)\s*\?\s*0\s*:\s*-1/,
    'featuredIndex should resolve to index 0 or -1, never a searched-for index');
});
