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

const { POLICY } = require('../fetch.js');

const html = fs.readFileSync('index.html', 'utf8');
const appJs = fs.readFileSync('app.js', 'utf8');

function cspDirectives() {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
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

test('the inline bootstrap script matches the hash the CSP allows', () => {
  const m = html.match(/<script>(.*?)<\/script>/s);
  assert.ok(m, 'the theme bootstrap script is gone — drop its hash from the CSP too');
  const hash = 'sha256-' + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
  assert.ok(
    cspDirectives()['script-src'].includes("'" + hash + "'"),
    `the bootstrap script changed but the CSP hash did not. Correct value:\n  '${hash}'`
  );
});

test('index.html carries exactly one inline script and no other', () => {
  // Every other script is a file, so there is one hash to keep current.
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.ok(html.includes('<script src="app.js" defer></script>'));
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

test('img-src names exactly the image domains the fetcher enforces', () => {
  // The page and the fetcher have to agree: an image host the fetcher would
  // write into the data file but the CSP would refuse renders as a broken
  // picture, and one the CSP allows but the fetcher drops is a rule kept in
  // two places. Adding a source updates POLICY automatically — this is what
  // says the CSP was updated too.
  const imgSrc = cspDirectives()['img-src'];
  const listed = new Set(
    imgSrc.filter(v => v.startsWith('https://')).map(v => v.replace(/^https:\/\/(\*\.)?/, ''))
  );
  const expected = new Set(POLICY.imageDomains);
  assert.deepEqual(
    [...listed].sort(), [...expected].sort(),
    'img-src and IMAGE_DOMAINS/POLICY have drifted apart'
  );
  assert.ok(imgSrc.includes("'self'"));
  assert.ok(imgSrc.includes('data:'), 'the favicon is a data: URL');
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

test('app.js sets link and image URLs only through safeURL', () => {
  // Belt and braces over the fetcher's own check: the page is also served from
  // a data file someone could edit by hand.
  assert.ok(appJs.includes('function safeURL'));
  const assignments = appJs.match(/\.(?:href|src)\s*=\s*([^;\n]+)/g) || [];
  for (const line of assignments) {
    assert.ok(
      /safeURL|link \|\| '#'|\blink\b|\bimg\b/.test(line),
      `a URL is assigned without going through safeURL: ${line}`
    );
  }
});
