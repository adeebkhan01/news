'use strict';
//
// Egress policy and untrusted-input validation.
//
// Three things in this pipeline are untrusted: the bytes a feed returns, the
// URLs inside those bytes, and whatever the model writes. This module is the
// one place that decides what may be fetched and what may be published, so the
// rules can be tested on their own and cannot drift apart between fetch.js and
// the tools that import it.
//
// The shape it enforces:
//
//   feed URL     -> exact allowlist, https only  -> fetch: no redirects, timeout, size cap
//   article link -> allowlisted domain           -> fetch: no redirects, timeout, size cap
//   image URL    -> allowlisted domain           -> published, or dropped to the placeholder
//   model output -> schema + sanitiser           -> published, or dropped
//
// Nothing here trusts a hostname it was not given in advance. The feed list in
// fetch.js is the root of that trust: widening what this script will talk to
// means adding a source, which is a reviewable diff.

// ── Public suffixes ──────────────────────────────────────────────────────
// "Last two labels" is wrong for every host under a two-label suffix: it reads
// unb.com.bd as com.bd and would allow every commercial host in Bangladesh,
// and the same for smh.com.au, abc.net.au and feeds.bbci.co.uk. This is not
// the full Public Suffix List — it is the entries the configured feeds and
// their image CDNs actually sit under, plus the common neighbours, so that
// adding a source rarely means editing this list. Add an entry when a feed
// moves somewhere not covered.
var MULTI_LABEL_SUFFIXES = [
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.bd', 'net.bd', 'org.bd', 'gov.bd', 'edu.bd', 'ac.bd',
  'co.nz', 'net.nz', 'org.nz',
  'co.in', 'net.in', 'org.in',
  'co.za', 'co.jp', 'or.jp', 'co.kr', 'co.id', 'co.ke', 'co.th',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.tw', 'com.hk',
  'com.sg', 'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.sa', 'com.eg',
  'com.ng', 'com.qa', 'com.lk', 'com.np'
];

// The registrable domain: the label that someone had to register, plus its
// suffix. Subdomains of a registrable domain are under the same control, which
// is what makes "same registrable domain" a usable trust boundary for the
// article pages a feed links to.
function registrableDomain(hostname) {
  var h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return '';
  var parts = h.split('.');
  if (parts.length < 2) return h;
  if (MULTI_LABEL_SUFFIXES.indexOf(parts.slice(-2).join('.')) !== -1) {
    return parts.slice(-Math.min(3, parts.length)).join('.');
  }
  return parts.slice(-2).join('.');
}

// ── Host safety ──────────────────────────────────────────────────────────
// The allowlists below are names, so an address literal can never match one.
// These checks exist for the probe path (tools/check-feeds.js takes a URL from
// a human) and so that a redirect or a config slip can't reach the runner's
// own network before the allowlist gets a look at it.
var IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIPv4(host) {
  var m = host.match(IPV4_RE);
  if (!m) return false;
  var o = m.slice(1).map(Number);
  if (o.some(function (n) { return n > 255; })) return true;   // malformed: refuse
  if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
  if (o[0] === 169 && o[1] === 254) return true;               // link-local, incl. cloud metadata
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;  // carrier-grade NAT
  return false;
}

function isPrivateHost(hostname) {
  var h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (isPrivateIPv4(h)) return true;
  if (h.indexOf(':') !== -1) return true;      // any IPv6 literal, including ::1 and fd00::/8
  if (IPV4_RE.test(h)) return true;            // public IPv4 literal: still not a news site
  return false;
}

// A URL this script is willing to consider at all: https, no embedded
// credentials, default port, and a public-looking name. Returns the parsed URL
// or null — never throws, so callers can treat "unparseable" and "refused" the
// same way.
function parseSafeUrl(raw) {
  var u;
  try { u = new URL(String(raw)); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  if (isPrivateHost(u.hostname)) return null;
  return u;
}

// ── Image domains ────────────────────────────────────────────────────────
// Publishers serve art from a CDN that is often nothing like the domain the
// feed sits on — the Herald's images are on ffx.io, the Guardian's on
// guim.co.uk, the ABC's on abc-cdn.net.au. This list was read off the image
// URLs already in the committed data files, so every entry is one a real
// article used, rather than a guess.
//
// An image whose host is not here is dropped and the card falls back to its
// placeholder: a source that changes CDN loses its art, not its headlines, and
// the run log names the host to add.
var IMAGE_DOMAINS = [
  'ffx.io',            // Sydney Morning Herald (static.ffx.io)
  'guim.co.uk',        // The Guardian (i.guim.co.uk)
  'bbci.co.uk',        // BBC (ichef.bbci.co.uk)
  'abc-cdn.net.au',    // ABC News (live-production.wcms.abc-cdn.net.au)
  'akamaized.net',     // several publishers front their CDN with Akamai
  'cloudfront.net',
  'wp.com'             // WordPress-hosted dailies (i0.wp.com and friends)
];

// ── Building the policy ──────────────────────────────────────────────────
// Derived from the feed list itself, so there is no second place to keep in
// sync. A source may name extra linkDomains when its articles live somewhere
// other than the feed's own registrable domain — the BBC is the standing
// example: the feed is on bbci.co.uk and every article is on bbc.co.uk.
function buildEgressPolicy(regions) {
  var feedUrls = new Set();
  var linkDomains = new Set();
  var imageDomains = new Set(IMAGE_DOMAINS);
  var invalid = [];

  Object.keys(regions).forEach(function (key) {
    (regions[key].sources || []).forEach(function (s) {
      var u = parseSafeUrl(s.url);
      if (!u) { invalid.push(s.url); return; }
      feedUrls.add(u.href);
      var reg = registrableDomain(u.hostname);
      linkDomains.add(reg);
      imageDomains.add(reg);
      (s.linkDomains || []).forEach(function (d) {
        var dom = String(d).toLowerCase();
        linkDomains.add(dom);
        imageDomains.add(dom);
      });
    });
  });

  return { feedUrls: feedUrls, linkDomains: linkDomains, imageDomains: imageDomains, invalid: invalid };
}

// Exact match against a configured URL, not a domain match: a feed is a
// specific document, and nothing in the pipeline has any business inventing a
// new path on a publisher's host.
function isAllowedFeedUrl(raw, policy) {
  var u = parseSafeUrl(raw);
  return !!u && policy.feedUrls.has(u.href);
}

function isAllowedArticleUrl(raw, policy) {
  var u = parseSafeUrl(raw);
  return !!u && policy.linkDomains.has(registrableDomain(u.hostname));
}

function isAllowedImageUrl(raw, policy) {
  var u = parseSafeUrl(raw);
  return !!u && policy.imageDomains.has(registrableDomain(u.hostname));
}

// ── Model output ─────────────────────────────────────────────────────────
// The model is downstream of every feed on the list, so its output carries
// whatever a publisher put in a headline. It is untrusted in exactly the way
// the feeds are, and gets the same treatment: a declared shape, a length, and
// no markup.
//
// The page renders these with textContent, so this is not the control that
// stops script from running — it is what stops unusable text from being
// published at all, and what keeps a prompt-injected answer from looking like
// part of the page.
var CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g;   // tab and newline stay
var MARKUP_RE = /<\s*\/?\s*[a-z!?]/i;
var API_KEY_RE = /sk-ant-/i;

// Returns the cleaned string, or null if the value cannot be trusted. Callers
// treat null the way they treat a failed API call: keep what was there before,
// publish nothing new.
function sanitizeModelText(value, maxLen) {
  if (typeof value !== 'string') return null;
  var s = value.replace(CONTROL_CHARS_RE, '').trim();
  if (!s) return null;
  if (s.length > maxLen) return null;        // a runaway answer is a failed one
  if (MARKUP_RE.test(s)) return null;        // translations and briefings are prose
  if (API_KEY_RE.test(s)) return null;       // never echo a credential into the data files
  return s;
}

// The translation call's declared shape. Anything else — a bare string, an
// array, extra fields, a titleBn that is not a string — is a failed call.
function validateTranslation(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  var titleBn = sanitizeModelText(parsed.titleBn, 600);
  if (!titleBn) return null;                 // a translation with no title is no translation
  var descBn = parsed.descBn === '' ? '' : sanitizeModelText(parsed.descBn, 1200);
  return { titleBn: titleBn, descBn: descBn == null ? '' : descBn };
}

function validateSummary(text) {
  return sanitizeModelText(text, 2000);
}

module.exports = {
  MULTI_LABEL_SUFFIXES: MULTI_LABEL_SUFFIXES,
  IMAGE_DOMAINS: IMAGE_DOMAINS,
  registrableDomain: registrableDomain,
  isPrivateHost: isPrivateHost,
  parseSafeUrl: parseSafeUrl,
  buildEgressPolicy: buildEgressPolicy,
  isAllowedFeedUrl: isAllowedFeedUrl,
  isAllowedArticleUrl: isAllowedArticleUrl,
  isAllowedImageUrl: isAllowedImageUrl,
  sanitizeModelText: sanitizeModelText,
  validateTranslation: validateTranslation,
  validateSummary: validateSummary
};
