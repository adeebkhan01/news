'use strict';
//
// Which language a piece of text is already in.
//
// The pipeline used to assume every feed publishes English and translated one
// way, into Bangla. Rising BD publishes in Bangla, so those articles were
// "translated" Bangla to Bangla — the model dutifully returned the input, we
// paid for it, and the page had no English to show when English was selected.
//
// Getting this right needs more care than it looks. The taka sign ৳ (U+09F3)
// lives in the Bengali Unicode block, so "Meghna Bank to raise ৳400 crore
// through subordinated bond" contains a Bengali character while being an
// English headline in every sense that matters. One character is never the
// answer: the question is what share of the text is Bengali.

// The whole Bengali block: letters, digits (\u09E6-\u09EF) and signs.
var BENGALI_CHAR = /[\u0980-\u09FF]/;

// Letters and numbers in any script. Punctuation, spaces and currency signs
// are excluded deliberately — they say nothing about the language, and the
// taka sign is a currency sign, which is exactly how the false positive above
// stops being one.
var ALPHANUMERIC_RE = /[\p{L}\p{N}]/gu;

// Above this share of Bengali alphanumerics, call it Bangla. A Bangla headline
// quoting an English name still lands far above it; an English headline
// carrying a taka figure lands far below.
var BENGALI_THRESHOLD = 0.3;

// Returns 'bn', 'en', or null when there is nothing to judge — an empty string,
// or one made only of digits and punctuation. null means "no opinion", so the
// caller can fall back to what the source declares rather than guessing.
function detectLang(text) {
  var s = String(text == null ? '' : text);
  var alphanumeric = s.match(ALPHANUMERIC_RE);
  if (!alphanumeric || !alphanumeric.length) return null;
  var bengali = 0;
  for (var i = 0; i < alphanumeric.length; i++) {
    if (BENGALI_CHAR.test(alphanumeric[i])) bengali++;
  }
  // Bengali digits are alphanumeric and in the block, so they count on both
  // sides and a date written in Bangla numerals reads as Bangla.
  return (bengali / alphanumeric.length) >= BENGALI_THRESHOLD ? 'bn' : 'en';
}

// The language an article is written in: what its own text says, and only when
// the text has no opinion, what its source declares.
function articleLang(article, sourceLang) {
  return detectLang(article && article.title) || sourceLang || 'en';
}

// Which way this article still needs translating, or null if it is complete.
// An article carries its own language in `title`/`desc`, and the other one in
// the matching `...En` or `...Bn` fields — never both, so nothing is stored
// twice.
//
// `false` in the target field means the model already answered unusably; that
// is a retry, not a fresh translation, and the caller tells them apart.
function targetLang(article) {
  return (article.lang || 'en') === 'bn' ? 'en' : 'bn';
}

function translatedField(article, field) {
  return field + (targetLang(article) === 'bn' ? 'Bn' : 'En');
}

module.exports = {
  BENGALI_CHAR: BENGALI_CHAR,
  BENGALI_THRESHOLD: BENGALI_THRESHOLD,
  detectLang: detectLang,
  articleLang: articleLang,
  targetLang: targetLang,
  translatedField: translatedField
};
