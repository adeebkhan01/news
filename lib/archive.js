'use strict';
//
// Yesterday.
//
// Everything the page knows is overwritten twice a day. That is fine for a
// feed and useless for a reader who came back: "what changed since I last
// looked" is unanswerable when there is only ever a now. This module keeps a
// small dated snapshot of each region's briefing and top stories, which is
// what makes a *change* observable at all.
//
// What it deliberately does not keep is the articles. A full copy of a
// region's data file is about 1.5 MB and there are two runs a day; a year of
// those is a repository nobody can clone. A snapshot is the briefing and the
// ranked stories in headline form — around 10 KB — and that is enough to
// answer the questions worth asking of the past: what was the briefing that
// morning, which stories were on it, and which of today's stories are new.

var fs = require('fs');
var path = require('path');

var ARCHIVE_DIR = 'archive';

// How many stories per snapshot. The point of the archive is the top of the
// page, not the whole feed: past the first twenty, a story that has changed
// since yesterday is not something anybody is coming back to check.
var ARCHIVE_STORIES = 20;

// How many days of snapshots to keep on disk. Older ones are pruned rather
// than accumulating forever — git history still has them, and a working tree
// that grows without bound is a repository that eventually cannot be cloned.
var ARCHIVE_DAYS = 120;

// UTC, always. The runs are scheduled in UTC, the article timestamps are
// normalised to it, and a snapshot named in local time would name a different
// day depending on which runner picked up the job.
function dayOf(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function regionDir(region) {
  return path.join(ARCHIVE_DIR, region);
}

function snapshotPath(region, day) {
  return path.join(regionDir(region), day + '.json');
}

// The English headline for a story, which is what a snapshot stores instead of
// the article. For a Bangla-language lead it is the translation the pipeline
// already bought — a snapshot full of text the reader cannot search is not
// worth the bytes.
function headlineOf(story) {
  var lead = story.members && story.members[0];
  if (!lead) return '';
  return lead.lang === 'bn' && typeof lead.titleEn === 'string' && lead.titleEn
    ? lead.titleEn : (lead.title || '');
}

function compactStory(story) {
  var record = {
    id:        story.id,
    headline:  headlineOf(story),
    lead:      story.members[0].link,
    size:      story.members.length,
    sourceIds: story.sourceIds,
    topic:     story.topic,
    score:     Math.round(story.score * 1000) / 1000
  };
  if (story.why) record.why = story.why;
  return record;
}

function buildSnapshot(options) {
  return {
    date:       options.day,
    region:     options.region,
    fetchedAt:  options.fetchedAt,
    briefing:   options.briefing || null,
    briefingBn: options.briefingBn || null,
    stories:    (options.stories || []).slice(0, ARCHIVE_STORIES).map(compactStory)
  };
}

// Every snapshot date a region has, newest first. Read from the directory
// rather than from a manifest the directory could disagree with: the files
// are the record, and an index is a cache of them.
function listDays(region) {
  var dir = regionDir(region);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function (name) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(name); })
    .map(function (name) { return name.slice(0, -'.json'.length); })
    .sort()
    .reverse();
}

function readSnapshot(region, day) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(region, day), 'utf8'));
  } catch (e) {
    return null;
  }
}

// The most recent snapshot from a day *before* the one given. Strictly
// before: both of a day's runs write to the same file, so comparing today's
// stories against today's earlier run would report the morning's news as
// "unchanged since this morning", which is true and useless.
function previousSnapshot(region, day) {
  var earlier = listDays(region).filter(function (d) { return d < day; });
  for (var i = 0; i < earlier.length; i++) {
    var snap = readSnapshot(region, earlier[i]);
    if (snap) return snap;
  }
  return null;
}

// What changed, per story, against a previous snapshot.
//
// Returns null when there is nothing to compare against — the first run, or a
// region whose archive has been cleared. That is the important case: with no
// baseline every story is trivially "new", and a page that announced 146 new
// stories on its first morning would have taught its reader to ignore the
// badge forever.
function diffStories(stories, previous) {
  if (!previous || !Array.isArray(previous.stories) || !previous.stories.length) return null;

  var before = Object.create(null);
  previous.stories.forEach(function (st) {
    if (st && st.id) before[st.id] = st;
  });

  var out = Object.create(null);
  stories.forEach(function (story) {
    var was = before[story.id];
    var size = story.members ? story.members.length : story.size;
    if (!was) {
      out[story.id] = { status: 'new' };
      return;
    }
    var gained = size - (was.size || 0);
    out[story.id] = gained > 0
      ? { status: 'developing', gained: gained }
      : { status: 'continuing' };
  });
  return { since: previous.date, stories: out };
}

// Stories that were on the previous snapshot's briefing and are not on
// today's. A reader who read yesterday's briefing is owed the other half of
// "what changed": not only what arrived, but what has dropped off.
function droppedFromBriefing(briefing, previous) {
  if (!previous || !Array.isArray(previous.briefing) || !briefing) return [];
  var today = Object.create(null);
  briefing.forEach(function (item) { if (item.id) today[item.id] = true; });
  return previous.briefing
    .filter(function (item) { return item.id && !today[item.id]; })
    .map(function (item) { return { id: item.id, headline: item.headline }; });
}

function writeSnapshot(snapshot) {
  var dir = regionDir(snapshot.region);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(snapshotPath(snapshot.region, snapshot.date), JSON.stringify(snapshot, null, 2));
}

// Older than the retention window, removed. Returns what it removed so the
// run log can say so rather than files quietly disappearing.
function prune(region, keepDays) {
  var days = listDays(region);
  var stale = days.slice(keepDays === undefined ? ARCHIVE_DAYS : keepDays);
  stale.forEach(function (day) {
    try { fs.unlinkSync(snapshotPath(region, day)); } catch (e) {}
  });
  return stale;
}

// A manifest the page can fetch. The browser cannot list a directory, so the
// archive is only browsable if something writes down what is in it — and it
// is written from the directory every run, so it cannot drift.
function writeIndex(regions) {
  var index = { generatedAt: new Date().toISOString(), regions: {} };
  regions.forEach(function (region) {
    index.regions[region] = listDays(region);
  });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARCHIVE_DIR, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}

module.exports = {
  ARCHIVE_DIR: ARCHIVE_DIR,
  ARCHIVE_STORIES: ARCHIVE_STORIES,
  ARCHIVE_DAYS: ARCHIVE_DAYS,
  dayOf: dayOf,
  regionDir: regionDir,
  snapshotPath: snapshotPath,
  headlineOf: headlineOf,
  compactStory: compactStory,
  buildSnapshot: buildSnapshot,
  listDays: listDays,
  readSnapshot: readSnapshot,
  previousSnapshot: previousSnapshot,
  diffStories: diffStories,
  droppedFromBriefing: droppedFromBriefing,
  writeSnapshot: writeSnapshot,
  prune: prune,
  writeIndex: writeIndex
};
