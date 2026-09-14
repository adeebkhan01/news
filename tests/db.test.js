'use strict';
//
// Tests for the SQLite layer: schema, the write transaction, and pruning.
//
//   node --test tests/
//
// The two failures worth guarding against: a write that lands half-done
// (an article pointing at a story that was never inserted, because the run
// crashed between the two statements), and a prune that deletes a story
// still holding a live article, or keeps an orphaned one around forever.
// No network. Each test opens a fresh file in a throwaway directory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../lib/db.js');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
  const file = path.join(dir, 'test.sqlite');
  const conn = db.open(file);
  try {
    fn(conn, file);
  } finally {
    db.closeQuietly(conn);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function count(conn, table) {
  return conn.prepare('SELECT COUNT(*) n FROM ' + table).get().n;
}

function baseRun(over) {
  return Object.assign({
    fetchedAt: '2026-09-14T10:00:00.000Z',
    date: '2026-09-14',
    sources: [{ id: 'src', name: 'Source', color: '#000' }],
    stories: [{ id: 's1', leadLink: 'https://x.example/1', topic: 'politics', score: 1.5 }],
    articles: [{
      link: 'https://x.example/1', title: 'A', desc: '', pubDate: '2026-09-14T00:00:00Z',
      pubDateMs: Date.now(), lang: 'en', sourceId: 'src', storyId: 's1', score: 1.5, topic: 'politics'
    }]
  }, over);
}

// ── Schema ───────────────────────────────────────────────────────────────

test('opening a fresh path creates every table and records the schema version', () => {
  withDb((conn) => {
    // meta is the one table that is never empty: opening a fresh file is
    // what writes its schemaVersion row.
    for (const table of ['sources', 'stories', 'articles', 'briefing_items', 'snapshots', 'snapshot_stories']) {
      assert.equal(count(conn, table), 0, table + ' should exist and start empty');
    }
    const row = conn.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
    assert.equal(Number(row.value), db.SCHEMA_VERSION);
  });
});

test('opening the same file twice does not duplicate or reset anything', () => {
  withDb((conn, file) => {
    db.writeRun(conn, baseRun());
    db.closeQuietly(conn);
    const reopened = db.open(file);
    assert.equal(count(reopened, 'articles'), 1);
    db.closeQuietly(reopened);
  });
});

// ── Writing ──────────────────────────────────────────────────────────────

test('a run writes sources, stories and articles together', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun());
    assert.equal(count(conn, 'sources'), 1);
    assert.equal(count(conn, 'stories'), 1);
    assert.equal(count(conn, 'articles'), 1);
    const article = conn.prepare('SELECT * FROM articles WHERE link = ?').get('https://x.example/1');
    assert.equal(article.story_id, 's1');
    assert.equal(article.title, 'A');
  });
});

test('writing the same article twice updates it in place, not a duplicate row', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun());
    const run2 = baseRun();
    run2.articles[0].title = 'A, updated';
    db.writeRun(conn, run2);
    assert.equal(count(conn, 'articles'), 1);
    assert.equal(conn.prepare('SELECT title FROM articles').get().title, 'A, updated');
  });
});

test('a translation attempted and rejected is stored as NULL plus a flag, not as false', () => {
  withDb((conn) => {
    const run = baseRun();
    run.articles[0].titleBn = false;
    db.writeRun(conn, run);
    const row = conn.prepare('SELECT title_bn, translate_failed FROM articles').get();
    assert.equal(row.title_bn, null);
    assert.equal(row.translate_failed, 1);
  });
});

test('a translation never attempted is NULL with no failure flag', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun());
    const row = conn.prepare('SELECT title_bn, translate_failed FROM articles').get();
    assert.equal(row.title_bn, null);
    assert.equal(row.translate_failed, 0);
  });
});

test('a briefing and its Bangla translation write together, positional not by id', () => {
  withDb((conn) => {
    const run = baseRun({
      briefingItems: [
        { id: 's1', headline: 'H1', what: 'W1', why: 'Y1', watch: '' },
        { id: '', headline: 'H2', what: 'W2', why: 'Y2', watch: 'X2' }
      ],
      briefingItemsBn: [{ headline: 'হ১' }]   // second item's translation not landed yet
    });
    db.writeRun(conn, run);
    const rows = conn.prepare('SELECT * FROM briefing_items WHERE date = ? ORDER BY position').all('2026-09-14');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].story_id, 's1');
    assert.equal(rows[1].story_id, null);
    assert.equal(rows[0].headline_bn, 'হ১');
    assert.equal(rows[1].headline_bn, null);
  });
});

test('rewriting a day\'s briefing replaces it rather than appending', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({ briefingItems: [{ id: 's1', headline: 'H1', what: 'W', why: 'Y', watch: '' }] }));
    db.writeRun(conn, baseRun({ briefingItems: [{ id: 's1', headline: 'H2', what: 'W', why: 'Y', watch: '' }] }));
    const rows = conn.prepare('SELECT headline FROM briefing_items WHERE date = ?').all('2026-09-14');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].headline, 'H2');
  });
});

test('a snapshot freezes the story as it was, independent of the live story row', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({
      snapshotStories: [{ id: 's1', headline: 'Frozen headline', leadLink: 'https://x.example/1',
        size: 1, sourceIds: ['src'], topic: 'politics', score: 1.5, why: 'Frozen why.' }]
    }));
    // The live story changes the next run...
    const run2 = baseRun();
    run2.stories[0].why = 'A different why, written later.';
    db.writeRun(conn, run2);
    // ...but the snapshot from the first day still reads as it did that day.
    const snap = conn.prepare('SELECT * FROM snapshot_stories WHERE date = ?').get('2026-09-14');
    assert.equal(snap.headline, 'Frozen headline');
    assert.equal(snap.why, 'Frozen why.');
    assert.deepEqual(JSON.parse(snap.source_ids), ['src']);
    const live = conn.prepare('SELECT why FROM stories WHERE id = ?').get('s1');
    assert.equal(live.why, 'A different why, written later.');
  });
});

test('a failed run writes nothing at all', () => {
  withDb((conn) => {
    const run = baseRun();
    run.articles.push({ link: null });   // link is the primary key; NULL fails the insert
    assert.throws(() => db.writeRun(conn, run));
    assert.equal(count(conn, 'articles'), 0, 'a failed write must not leave a partial article');
    assert.equal(count(conn, 'stories'), 0, 'a failed write must not leave the story it belonged to either');
  });
});

// ── Pruning ──────────────────────────────────────────────────────────────

test('an article past the retention window is deleted', () => {
  withDb((conn) => {
    const old = Date.now() - 130 * 24 * 60 * 60 * 1000;
    db.writeRun(conn, baseRun({
      articles: [{ link: 'https://x.example/old', title: 'Old', desc: '', pubDate: 'x',
        pubDateMs: old, lang: 'en', sourceId: 'src' }]
    }));
    const result = db.prune(conn, Date.now(), 120);
    assert.equal(result.articles, 1);
    assert.equal(count(conn, 'articles'), 0);
  });
});

test('a story is only deleted once every article in it is gone', () => {
  withDb((conn) => {
    const old = Date.now() - 130 * 24 * 60 * 60 * 1000;
    const fresh = Date.now();
    db.writeRun(conn, {
      fetchedAt: '2026-09-14T00:00:00Z', date: '2026-09-14',
      sources: [{ id: 'src', name: 'Source', color: '#000' }],
      stories: [{ id: 's1', leadLink: 'https://x.example/1', topic: 'politics', score: 1 }],
      articles: [
        { link: 'https://x.example/1', title: 'Old', desc: '', pubDate: 'x', pubDateMs: old, lang: 'en', sourceId: 'src', storyId: 's1' },
        { link: 'https://x.example/2', title: 'Fresh', desc: '', pubDate: 'x', pubDateMs: fresh, lang: 'en', sourceId: 'src', storyId: 's1' }
      ]
    });
    db.prune(conn, Date.now(), 120);
    assert.equal(count(conn, 'articles'), 1, 'the fresh article should survive');
    assert.equal(count(conn, 'stories'), 1, 'the story still has a live member and must not be deleted');
  });
});

test('a story with no article left in it is deleted', () => {
  withDb((conn) => {
    const old = Date.now() - 130 * 24 * 60 * 60 * 1000;
    db.writeRun(conn, {
      fetchedAt: '2026-09-14T00:00:00Z', date: '2026-09-14',
      sources: [{ id: 'src', name: 'Source', color: '#000' }],
      stories: [{ id: 's1', leadLink: 'https://x.example/1', topic: 'politics', score: 1 }],
      articles: [{ link: 'https://x.example/1', title: 'Old', desc: '', pubDate: 'x', pubDateMs: old, lang: 'en', sourceId: 'src', storyId: 's1' }]
    });
    const result = db.prune(conn, Date.now(), 120);
    assert.equal(result.stories, 1);
    assert.equal(count(conn, 'stories'), 0);
  });
});

test('briefing items and snapshots past the window are pruned by date, not by age of write', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({
      date: '2026-01-01',
      briefingItems: [{ id: 's1', headline: 'H', what: 'W', why: 'Y', watch: '' }],
      snapshotStories: [{ id: 's1', headline: 'H', leadLink: 'https://x.example/1', size: 1, sourceIds: ['src'], topic: 'politics', score: 1 }]
    }));
    const result = db.prune(conn, new Date('2026-09-14').getTime(), 120);
    assert.equal(result.briefings, 1);
    assert.equal(result.snapshots, 1);
    assert.equal(result.snapStories, 1);
    assert.equal(count(conn, 'briefing_items'), 0);
    assert.equal(count(conn, 'snapshots'), 0);
  });
});

test('an article with no pub_date_ms is never pruned by age', () => {
  // Missing rather than guessed: an unparseable date must not silently
  // expire an article that might still be recent.
  withDb((conn) => {
    db.writeRun(conn, baseRun({
      articles: [{ link: 'https://x.example/1', title: 'A', desc: '', pubDate: 'unparseable',
        pubDateMs: null, lang: 'en', sourceId: 'src' }]
    }));
    db.prune(conn, Date.now(), 120);
    assert.equal(count(conn, 'articles'), 1);
  });
});

test('vacuum does not throw on an empty or a populated database', () => {
  withDb((conn) => {
    assert.doesNotThrow(() => db.vacuum(conn));
    db.writeRun(conn, baseRun());
    assert.doesNotThrow(() => db.vacuum(conn));
  });
});

// ── Reading back into the pipeline's own shape ──────────────────────────

test('a hydrated article carries only its own translation direction as failed', () => {
  // Regression: translate_failed is one flag per article, not one per
  // field, and it must only ever mark the direction that article actually
  // needed. Marking the untouched pair `false` too would say a translation
  // was attempted and failed when it was never asked for — a different
  // claim, and the one that decides which retry queue an article sits in.
  withDb((conn) => {
    db.writeRun(conn, baseRun({
      sources: [{ id: 'src', name: 'Source', color: '#000' }],
      stories: [],
      articles: [
        { link: 'https://x.example/en', title: 'A', desc: '', pubDate: 'p', pubDateMs: Date.now(),
          lang: 'en', sourceId: 'src', titleBn: false },
        { link: 'https://x.example/bn', title: 'বি', desc: '', pubDate: 'p', pubDateMs: Date.now(),
          lang: 'bn', sourceId: 'src', titleEn: false }
      ]
    }));
    const bySources = db.readSources(conn);
    const articles = db.readArticles(conn, bySources);
    const en = articles.find(a => a.link === 'https://x.example/en');
    const bn = articles.find(a => a.link === 'https://x.example/bn');
    assert.equal(en.titleBn, false);
    assert.equal(en.titleEn, undefined, 'an English article was never asked to translate into English');
    assert.equal(en.descEn, undefined);
    assert.equal(bn.titleEn, false);
    assert.equal(bn.titleBn, undefined, 'a Bangla article was never asked to translate into Bangla');
    assert.equal(bn.descBn, undefined);
  });
});

test('a hydrated article with no translation attempt has neither field set', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({ stories: [] }));
    const [article] = db.readArticles(conn, db.readSources(conn));
    assert.equal(article.titleBn, undefined);
    assert.equal(article.descBn, undefined);
    assert.equal(article.titleEn, undefined);
    assert.equal(article.descEn, undefined);
  });
});

test('a landed translation is returned as text, sourceName/sourceColor hydrated from the sources table', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({
      sources: [{ id: 'src', name: 'The Source', color: '#abc' }],
      stories: [],
      articles: [{ link: 'https://x.example/1', title: 'A', desc: '', pubDate: 'p', pubDateMs: Date.now(),
        lang: 'en', sourceId: 'src', titleBn: 'অ', descBn: '' }]
    }));
    const [article] = db.readArticles(conn, db.readSources(conn));
    assert.equal(article.titleBn, 'অ');
    assert.equal(article.descBn, '');
    assert.equal(article.sourceName, 'The Source');
    assert.equal(article.sourceColor, '#abc');
  });
});

test('an article from a source since retired from config still hydrates by name', () => {
  // sources rows persist as long as an article in the retention window
  // still cites them, even after REGIONS drops the source entirely.
  withDb((conn) => {
    db.writeRun(conn, baseRun({
      sources: [{ id: 'retired', name: 'Retired Paper', color: '#999' }],
      stories: [],
      articles: [{ link: 'https://x.example/1', title: 'A', desc: '', pubDate: 'p', pubDateMs: Date.now(),
        lang: 'en', sourceId: 'retired' }]
    }));
    const [article] = db.readArticles(conn, db.readSources(conn));
    assert.equal(article.sourceName, 'Retired Paper');
  });
});

test('story why-state exposes member_count for the "did this story grow" check', () => {
  withDb((conn) => {
    db.writeRun(conn, {
      fetchedAt: 't', date: '2026-09-14',
      sources: [{ id: 'src', name: 'S', color: '#000' }],
      stories: [{ id: 's1', leadLink: 'https://x.example/1', topic: 'politics', score: 1,
        memberCount: 3, why: 'It matters.' }],
      articles: [{ link: 'https://x.example/1', title: 'A', desc: '', pubDate: 'p',
        pubDateMs: Date.now(), lang: 'en', sourceId: 'src', storyId: 's1' }]
    });
    const state = db.readStoryWhyState(conn);
    assert.deepEqual(state.s1, { memberCount: 3, why: 'It matters.', whyBn: null });
  });
});

test('a story written with no matching article is swept away in the same write', () => {
  // Every story is derived from real clustered articles; one with none is
  // not a state the database should ever hand back to a reader.
  withDb((conn) => {
    db.writeRun(conn, {
      fetchedAt: 't', date: '2026-09-14',
      sources: [{ id: 'src', name: 'S', color: '#000' }],
      stories: [{ id: 'orphan', leadLink: 'https://x.example/9', topic: 'politics', score: 1 }],
      articles: []
    });
    assert.equal(count(conn, 'stories'), 0);
  });
});

test('readBriefing returns null for a date with nothing, not an empty array', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({ stories: [] }));
    assert.equal(db.readBriefing(conn, '2099-01-01'), null);
  });
});

test('readBriefing omits the Bangla side entirely until it has actually landed', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({
      stories: [],
      briefingItems: [{ id: 's1', headline: 'H', what: 'W', why: 'Y', watch: '' }]
      // no briefingItemsBn — translation has not landed yet
    }));
    const result = db.readBriefing(conn, '2026-09-14');
    assert.equal(result.bn, null, 'a briefing with no Bangla anywhere in it must not render as an empty Bangla briefing');
    assert.equal(result.en[0].headline, 'H');
  });
});

test('previousSnapshotDate never returns the date given, even when that date has a snapshot', () => {
  withDb((conn) => {
    db.writeRun(conn, baseRun({ date: '2026-09-14', stories: [],
      snapshotStories: [{ id: 's1', headline: 'H', leadLink: 'https://x.example/1', size: 1, sourceIds: ['src'], topic: 'politics', score: 1 }] }));
    assert.equal(db.previousSnapshotDate(conn, '2026-09-14'), null);
  });
});
