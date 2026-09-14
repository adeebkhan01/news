'use strict';
//
// One SQLite file per region, holding everything within the retention
// window — articles, the stories they cluster into, every day's briefing,
// and a frozen daily snapshot of the top stories for "what changed" and the
// archive. It replaces two things that used to be separate: the live data
// file (data-{region}.json, 30 days of articles) and the archive
// (archive/{region}/YYYY-MM-DD.json, 120 days of headlines only). One
// retention window, one file, one query surface, and a real database gets
// to hold the full 120 days of everything rather than a compact summary of
// it — the trade the old archive made because a flat JSON file rewritten
// wholesale every run could not afford to be large.
//
// Node-side only. Written with node:sqlite — built into Node 22, so this
// adds no npm dependency to a project that has never had one. The browser
// reads the same file with sql.js (vendor/sql-wasm-*.js), which is a real
// new dependency and the one this module's whole design is spent avoiding
// anywhere else: node:sqlite writes the standard SQLite file format, and
// sql.js just opens it, so nothing is exported, converted, or kept in sync
// by hand between the write side and the read side.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

// How long anything lives in the database: an article, the story it belongs
// to, a day's briefing, a day's snapshot. One number for all of it, where
// the old design had two (30 days of articles, 120 days of archive headlines)
// because the cost of storing full articles for 120 days in a flat JSON file
// rewritten every run was real. A database does not have that problem.
var RETENTION_DAYS = 120;

var SCHEMA = [
  // version is the schema version, not a data value — bumped when a
  // migration is needed, checked before every open. A file at an older
  // version is rebuilt rather than read wrong.
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",

  "CREATE TABLE IF NOT EXISTS sources (\n" +
  "  id    TEXT PRIMARY KEY,\n" +
  "  name  TEXT NOT NULL,\n" +
  "  color TEXT NOT NULL\n" +
  ")",

  // One row per story. A story's `why` is the current, live line — kept in
  // sync with the story as it grows, unlike the frozen copy a day's
  // snapshot carries. Deleted once every article in it ages out.
  "CREATE TABLE IF NOT EXISTS stories (\n" +
  "  id           TEXT PRIMARY KEY,\n" +
  "  lead_link    TEXT NOT NULL,\n" +
  "  topic        TEXT NOT NULL,\n" +
  "  score        REAL NOT NULL,\n" +
  "  first_date   TEXT,\n" +
  "  latest_date  TEXT,\n" +
  "  member_count INTEGER NOT NULL DEFAULT 0,\n" +   // cheap lookup: whether a
  //                                                    story grew is asked on
  //                                                    every run, for every
  //                                                    candidate why-line.
  "  why          TEXT,\n" +
  "  why_bn       TEXT,\n" +
  // status/gained describe THIS run's "since yesterday" verdict for the
  // story, computed once by the pipeline and stored rather than recomputed
  // by every reader. Absent (both NULL) means "no baseline to compare
  // against" — not the same claim as "unchanged" — see diffStories in
  // fetch.js, which is where that distinction is decided.
  "  status       TEXT,\n" +
  "  gained       INTEGER\n" +
  ")",

  // link is the primary key, as it always has been in the JSON files: a
  // feed can only tell this pipeline about an article once per URL, and
  // that URL is the one stable thing about it across every run it survives.
  //
  // translate_failed replaces the `false` sentinel the JSON files used for
  // "the model answered, just not usably" — a boolean column reads the same
  // either way and is not a magic value living inside a text field.
  "CREATE TABLE IF NOT EXISTS articles (\n" +
  "  link             TEXT PRIMARY KEY,\n" +
  "  title            TEXT NOT NULL,\n" +
  "  desc             TEXT NOT NULL DEFAULT '',\n" +
  "  pub_date         TEXT NOT NULL,\n" +
  "  pub_date_ms      INTEGER,\n" +
  "  img              TEXT,\n" +
  "  lang             TEXT NOT NULL,\n" +
  "  source_id        TEXT NOT NULL,\n" +
  "  title_en         TEXT,\n" +
  "  desc_en          TEXT,\n" +
  "  title_bn         TEXT,\n" +
  "  desc_bn          TEXT,\n" +
  "  translate_failed INTEGER NOT NULL DEFAULT 0,\n" +
  "  story_id         TEXT,\n" +
  "  score            REAL,\n" +
  "  topic            TEXT\n" +
  ")",
  "CREATE INDEX IF NOT EXISTS idx_articles_story ON articles(story_id)",
  "CREATE INDEX IF NOT EXISTS idx_articles_pubdate ON articles(pub_date_ms)",
  "CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id)",

  // The structured briefing, one row per item, keyed by the day it was
  // written for. Full text for every day in the retention window — the old
  // archive kept only the headline and the short why-line, a concession to
  // JSON files being expensive to grow; a database is not, so "what did the
  // briefing say on the 10th" now answers in full, not in summary.
  "CREATE TABLE IF NOT EXISTS briefing_items (\n" +
  "  date        TEXT NOT NULL,\n" +
  "  position    INTEGER NOT NULL,\n" +
  "  story_id    TEXT,\n" +
  "  headline    TEXT NOT NULL,\n" +
  "  what        TEXT NOT NULL,\n" +
  "  why         TEXT NOT NULL,\n" +
  "  watch       TEXT NOT NULL,\n" +
  "  headline_bn TEXT,\n" +
  "  what_bn     TEXT,\n" +
  "  why_bn      TEXT,\n" +
  "  watch_bn    TEXT,\n" +
  "  PRIMARY KEY (date, position)\n" +
  ")",

  // The frozen top twenty for a day. Frozen because `stories` and `articles`
  // keep moving — a story can grow a member, its live `why` can be
  // rewritten — and "what did the briefing look like on the 10th" has to
  // answer with the 10th's wording, not today's evolved version of the same
  // event. This is what the archive browsing and the day-over-day diff both
  // read from, exactly the job compactStory did in the old archive module.
  "CREATE TABLE IF NOT EXISTS snapshots (\n" +
  "  date       TEXT PRIMARY KEY,\n" +
  "  fetched_at TEXT NOT NULL\n" +
  ")",
  "CREATE TABLE IF NOT EXISTS snapshot_stories (\n" +
  "  date       TEXT NOT NULL,\n" +
  "  position   INTEGER NOT NULL,\n" +
  "  story_id   TEXT NOT NULL,\n" +
  "  headline   TEXT NOT NULL,\n" +
  "  lead_link  TEXT NOT NULL,\n" +
  "  size       INTEGER NOT NULL,\n" +
  "  source_ids TEXT NOT NULL,\n" +   // JSON array, frozen at the size it was that day
  "  topic      TEXT NOT NULL,\n" +
  "  score      REAL NOT NULL,\n" +
  "  why        TEXT,\n" +
  "  why_bn     TEXT,\n" +
  "  PRIMARY KEY (date, position)\n" +
  ")"
];

var SCHEMA_VERSION = 1;

function ensureSchema(db) {
  db.exec('PRAGMA journal_mode = WAL');
  SCHEMA.forEach(function (stmt) { db.exec(stmt); });
  var row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  var current = row ? Number(row.value) : 0;
  if (current !== SCHEMA_VERSION) {
    // No migrations exist yet — the first version of this file. A future
    // bump writes a real migration here; today, mismatched means "rebuild",
    // and the caller (open) is what decides whether that is acceptable.
    db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
  }
}

// Opens (creating if absent) and returns a ready database. A file from a
// newer schema version than this code knows is refused rather than read
// wrong — the caller sees the error and the run fails loudly instead of
// silently corrupting data it does not understand.
function open(path) {
  var db = new DatabaseSync(path);
  ensureSchema(db);
  return db;
}

function closeQuietly(db) {
  try { db.close(); } catch (e) {}
}

// Every write for one run, in a single transaction: either the whole run's
// data lands, or none of it does. A run that fails halfway through must
// never leave the database with new articles pointing at a story that was
// never inserted, or a snapshot with no matching briefing.
function writeRun(db, run) {
  db.exec('BEGIN');
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES ('fetchedAt', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(run.fetchedAt);

    var upsertSource = db.prepare(
      'INSERT INTO sources (id, name, color) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color');
    (run.sources || []).forEach(function (s) { upsertSource.run(s.id, s.name, s.color); });

    var upsertStory = db.prepare(
      'INSERT INTO stories (id, lead_link, topic, score, first_date, latest_date, member_count, why, why_bn, status, gained) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET lead_link=excluded.lead_link, topic=excluded.topic, ' +
      'score=excluded.score, first_date=excluded.first_date, latest_date=excluded.latest_date, ' +
      'member_count=excluded.member_count, why=excluded.why, why_bn=excluded.why_bn, ' +
      'status=excluded.status, gained=excluded.gained');
    (run.stories || []).forEach(function (s) {
      upsertStory.run(s.id, s.leadLink, s.topic, s.score, s.first || null, s.latest || null,
        s.memberCount || 0, s.why || null, s.whyBn || null, s.status || null, s.gained || null);
    });

    var upsertArticle = db.prepare(
      'INSERT INTO articles (link, title, desc, pub_date, pub_date_ms, img, lang, source_id, ' +
      'title_en, desc_en, title_bn, desc_bn, translate_failed, story_id, score, topic) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(link) DO UPDATE SET title=excluded.title, desc=excluded.desc, ' +
      'pub_date=excluded.pub_date, pub_date_ms=excluded.pub_date_ms, img=excluded.img, ' +
      'lang=excluded.lang, source_id=excluded.source_id, title_en=excluded.title_en, ' +
      'desc_en=excluded.desc_en, title_bn=excluded.title_bn, desc_bn=excluded.desc_bn, ' +
      'translate_failed=excluded.translate_failed, story_id=excluded.story_id, ' +
      'score=excluded.score, topic=excluded.topic');
    (run.articles || []).forEach(function (a) {
      upsertArticle.run(
        a.link, a.title, a.desc || '', a.pubDate, a.pubDateMs == null ? null : a.pubDateMs,
        a.img || null, a.lang, a.sourceId,
        fieldValue(a.titleEn), fieldValue(a.descEn), fieldValue(a.titleBn), fieldValue(a.descBn),
        (a.titleEn === false || a.titleBn === false) ? 1 : 0,
        a.storyId || null, a.score == null ? null : a.score, a.topic || null
      );
    });

    if (run.briefingItems) {
      db.prepare('DELETE FROM briefing_items WHERE date = ?').run(run.date);
      var insertBriefing = db.prepare(
        'INSERT INTO briefing_items (date, position, story_id, headline, what, why, watch, ' +
        'headline_bn, what_bn, why_bn, watch_bn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      run.briefingItems.forEach(function (item, i) {
        var bn = (run.briefingItemsBn && run.briefingItemsBn[i]) || {};
        insertBriefing.run(run.date, i, item.id || null, item.headline, item.what, item.why,
          item.watch || '', bn.headline || null, bn.what || null, bn.why || null, bn.watch || null);
      });
    }

    // Ephemeral, single-current-value facts about the live view — not
    // date-partitioned, because the old JSON only ever had one value for
    // these too. Absent (row deleted) means "no baseline", which must read
    // differently from an empty string.
    if (run.changedSince) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('changedSince', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(run.changedSince);
    } else {
      db.prepare("DELETE FROM meta WHERE key = 'changedSince'").run();
    }
    if (run.droppedItems && run.droppedItems.length) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('dropped', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(run.droppedItems));
    } else {
      db.prepare("DELETE FROM meta WHERE key = 'dropped'").run();
    }

    var imagesToDelete = [];
    if (run.deleteLinks && run.deleteLinks.length) {
      var getImg = db.prepare('SELECT img FROM articles WHERE link = ?');
      var delArticle = db.prepare('DELETE FROM articles WHERE link = ?');
      run.deleteLinks.forEach(function (link) {
        var row = getImg.get(link);
        if (row && row.img) imagesToDelete.push(row.img);
        delArticle.run(link);
      });
    }

    if (run.snapshotStories) {
      db.prepare('INSERT INTO snapshots (date, fetched_at) VALUES (?, ?) ' +
        'ON CONFLICT(date) DO UPDATE SET fetched_at = excluded.fetched_at').run(run.date, run.fetchedAt);
      db.prepare('DELETE FROM snapshot_stories WHERE date = ?').run(run.date);
      var insertSnap = db.prepare(
        'INSERT INTO snapshot_stories (date, position, story_id, headline, lead_link, size, ' +
        'source_ids, topic, score, why, why_bn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      run.snapshotStories.forEach(function (s, i) {
        insertSnap.run(run.date, i, s.id, s.headline, s.leadLink, s.size,
          JSON.stringify(s.sourceIds), s.topic, s.score, s.why || null, s.whyBn || null);
      });
    }

    db.prepare('DELETE FROM stories WHERE id NOT IN ' +
      '(SELECT DISTINCT story_id FROM articles WHERE story_id IS NOT NULL)').run();

    db.exec('COMMIT');
    // Outside the transaction on purpose: a file already off disk cannot be
    // rolled back, so the delete has to wait until the rows it belongs to
    // are actually gone for good.
    imagesToDelete.forEach(unlinkImageQuietly);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// A translated field is one of three states: not yet attempted (column is
// NULL and translate_failed is 0), attempted and unusable (NULL, but
// translate_failed is 1), or attempted and stored (the text). `false` — the
// JSON files' sentinel for "attempted, unusable" — is not stored as a value;
// it becomes the translate_failed flag instead, so the column only ever
// holds NULL or real text.
function fieldValue(v) {
  return (v === false || v == null) ? null : v;
}

// Best-effort: a file already gone (or never local — an unresolved URL,
// briefly, on an old row from before images were downloaded at all) is not
// an error, and one stuck file is not worth failing a prune over.
function unlinkImageQuietly(relPath) {
  try { fs.unlinkSync(relPath); } catch (e) {}
}

// Everything older than the retention window, gone: articles, the stories
// left with no article in them, and whole days of briefing/snapshot. Run
// after every write, in its own transaction, and returns counts so the run
// log can say what it did rather than pruning silently.
function prune(db, nowMs, retentionDays) {
  var days = retentionDays == null ? RETENTION_DAYS : retentionDays;
  var cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  var cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

  db.exec('BEGIN');
  try {
    var expiredImages = db.prepare(
      'SELECT img FROM articles WHERE pub_date_ms IS NOT NULL AND pub_date_ms < ? AND img IS NOT NULL'
    ).all(cutoffMs).map(function (r) { return r.img; });
    var articles = db.prepare(
      'DELETE FROM articles WHERE pub_date_ms IS NOT NULL AND pub_date_ms < ?').run(cutoffMs).changes;
    var stories = db.prepare(
      'DELETE FROM stories WHERE id NOT IN (SELECT DISTINCT story_id FROM articles WHERE story_id IS NOT NULL)'
    ).run().changes;
    var briefings = db.prepare('DELETE FROM briefing_items WHERE date < ?').run(cutoffDate).changes;
    var snapStories = db.prepare('DELETE FROM snapshot_stories WHERE date < ?').run(cutoffDate).changes;
    var snapshots = db.prepare('DELETE FROM snapshots WHERE date < ?').run(cutoffDate).changes;
    db.exec('COMMIT');
    expiredImages.forEach(unlinkImageQuietly);
    return { articles: articles, stories: stories, briefings: briefings,
             snapshots: snapshots, snapStories: snapStories, cutoffDate: cutoffDate };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Reclaims the space DELETE leaves behind. Outside the write transaction —
// VACUUM cannot run inside one — and safe to skip on failure: an unvacuumed
// file is larger than it needs to be, never wrong.
function vacuum(db) {
  try { db.exec('VACUUM'); } catch (e) {}
}

// ── Reads used by the fetch pipeline itself ────────────────────────────
//
// Everything below is what fetch.js needs from a database it just opened:
// what is already stored, so a run knows what is new and what merely needs
// re-checking. The browser has its own, separate read path (sql.js, run
// entirely client-side against the same file) and does not go through any
// of this — these are Node-only, synchronous, and shaped for the pipeline's
// own in-memory article objects rather than for rendering.

// Every stored source, keyed by id — used to hydrate a loaded article back
// into the {sourceName, sourceColor} shape the rest of the pipeline expects,
// including for a source since retired from REGIONS but still inside the
// retention window.
function readSources(dbconn) {
  var out = Object.create(null);
  dbconn.prepare('SELECT id, name, color FROM sources').all().forEach(function (s) {
    out[s.id] = { name: s.name, color: s.color };
  });
  return out;
}

// Every stored article, reshaped into exactly the object fetch.js has always
// worked with in memory — the same fields parseFeed produces for a fresh
// one. `false` is reconstructed from the translate_failed flag: the pipeline
// tells "never attempted" (key absent) from "attempted, unusable" (false)
// from "done" (a string), and the database has to hand that distinction
// back the same way it was handed in.
function readArticles(dbconn, sourceMeta) {
  var rows = dbconn.prepare('SELECT * FROM articles').all();
  return rows.map(function (r) {
    var meta = sourceMeta[r.source_id] || { name: r.source_id, color: '#666' };
    var a = {
      link: r.link, title: r.title, desc: r.desc, pubDate: r.pub_date,
      img: r.img || null, lang: r.lang,
      sourceId: r.source_id, sourceName: meta.name, sourceColor: meta.color
    };
    if (r.story_id != null) a.clusterId = r.story_id;
    if (r.score != null) a.score = r.score;
    if (r.topic != null) a.topic = r.topic;

    // Exactly one direction is ever relevant for a given article — Bangla
    // asks for English, everything else asks for Bangla, mirroring
    // lang.targetLang exactly — and translate_failed describes only that
    // direction. Applying it to the other pair too would mark a translation
    // as "attempted and failed" that was in fact never asked for at all,
    // which is not a rounding error: it changes which retry queue an
    // article sits in. The untouched pair is left genuinely absent
    // (undefined), matching what parseFeed hands a fresh article.
    var wantEn = r.lang === 'bn';
    assignTranslated(a, 'titleEn', r.title_en, wantEn && r.translate_failed);
    assignTranslated(a, 'descEn', r.desc_en, wantEn && r.translate_failed);
    assignTranslated(a, 'titleBn', r.title_bn, !wantEn && r.translate_failed);
    assignTranslated(a, 'descBn', r.desc_bn, !wantEn && r.translate_failed);
    return a;
  });
}

function assignTranslated(article, key, value, failed) {
  if (value != null) { article[key] = value; return; }
  if (failed) { article[key] = false; return; }
  // undefined: never attempted, or not this article's direction. Leave the
  // key absent either way.
}

// A story's live `why`/`whyBn` and how many members it had last run — the
// two things generateWhyLines needs to decide whether a story's line is
// still fresh, keyed by id.
function readStoryWhyState(dbconn) {
  var out = Object.create(null);
  dbconn.prepare('SELECT id, member_count, why, why_bn FROM stories').all().forEach(function (s) {
    out[s.id] = { memberCount: s.member_count, why: s.why || null, whyBn: s.why_bn || null };
  });
  return out;
}

// The structured briefing for one date, both languages, in position order.
// Returns null rather than an empty array when the date has no rows, so the
// caller can tell "no briefing that day" from "a briefing with nothing in
// it" — the second never legitimately happens, and collapsing the two would
// hide a bug.
function readBriefing(dbconn, date) {
  var rows = dbconn.prepare('SELECT * FROM briefing_items WHERE date = ? ORDER BY position').all(date);
  if (!rows.length) return null;
  var en = [], bn = [], anyBn = false;
  rows.forEach(function (r) {
    en.push({ id: r.story_id || '', headline: r.headline, what: r.what, why: r.why, watch: r.watch });
    if (r.headline_bn) anyBn = true;
    bn.push({ id: r.story_id || '', headline: r.headline_bn, what: r.what_bn, why: r.why_bn, watch: r.watch_bn });
  });
  return { en: en, bn: anyBn ? bn : null };
}

// The most recently written briefing, whatever date it was written under —
// the fallback source when today has not (yet, or ever this run) produced
// one of its own. A run that fails to generate falls back to this rather
// than to nothing, exactly as the old design's single unversioned blob
// stayed on the page until something replaced it; the difference is that a
// day with nothing written now honestly has no row, rather than an
// undated blob quietly describing an older day.
function readLatestBriefing(dbconn) {
  var row = dbconn.prepare('SELECT date FROM briefing_items ORDER BY date DESC LIMIT 1').get();
  return row ? readBriefing(dbconn, row.date) : null;
}

// The most recent snapshot date strictly before the one given — never that
// date itself, since both of a day's runs write the same snapshot and
// comparing a run against its own morning is comparing against nothing.
function previousSnapshotDate(dbconn, beforeDate) {
  var row = dbconn.prepare('SELECT date FROM snapshots WHERE date < ? ORDER BY date DESC LIMIT 1').get(beforeDate);
  return row ? row.date : null;
}

function readSnapshotStories(dbconn, date) {
  if (!date) return null;
  return dbconn.prepare('SELECT * FROM snapshot_stories WHERE date = ? ORDER BY position').all(date)
    .map(function (r) {
      return { id: r.story_id, headline: r.headline, leadLink: r.lead_link, size: r.size,
               sourceIds: JSON.parse(r.source_ids), topic: r.topic, score: r.score,
               why: r.why, whyBn: r.why_bn };
    });
}

module.exports = {
  RETENTION_DAYS: RETENTION_DAYS,
  SCHEMA_VERSION: SCHEMA_VERSION,
  open: open,
  closeQuietly: closeQuietly,
  ensureSchema: ensureSchema,
  writeRun: writeRun,
  fieldValue: fieldValue,
  prune: prune,
  vacuum: vacuum,
  readSources: readSources,
  readArticles: readArticles,
  readStoryWhyState: readStoryWhyState,
  readBriefing: readBriefing,
  readLatestBriefing: readLatestBriefing,
  previousSnapshotDate: previousSnapshotDate,
  readSnapshotStories: readSnapshotStories
};
