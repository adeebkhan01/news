'use strict';
//
// Tests for the archive: the dated snapshots, and the "what changed" answer
// they exist to make possible.
//
//   node --test tests/
//
// The failure that matters most here is a false "New". A badge that fires on
// every story the first morning, or one that compares today against this
// morning's own run, teaches the reader to ignore it — and a badge nobody
// reads is worse than no badge, because it still takes up the space where a
// real signal would go. Several tests below exist only to pin that down.
//
// These touch the filesystem, so each one runs in its own temporary directory
// and puts the working directory back afterwards. No network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const archive = require('../lib/archive.js');

// archive.js addresses its files relative to the working directory, the same
// way fetch.js addresses the data files. Running each case in a throwaway
// directory is what keeps a test from writing into the repository.
function inTempDir(fn) {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  try {
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function story(over) {
  const members = over.members || [{ title: 'A headline', link: 'https://x.example/1', lang: 'en' }];
  return Object.assign({
    id: 's1', sourceIds: ['a'], topic: 'politics', score: 1.234
  }, over, { members });
}

// ── Dates ────────────────────────────────────────────────────────────────

test('a snapshot is dated in UTC, whatever the runner thinks the day is', () => {
  // 23:30 UTC is already tomorrow in Dhaka and still yesterday in Los
  // Angeles. The snapshot has one name.
  assert.equal(archive.dayOf('2026-09-14T23:30:00Z'), '2026-09-14');
  assert.equal(archive.dayOf('2026-09-14T00:10:00Z'), '2026-09-14');
});

// ── Building a snapshot ──────────────────────────────────────────────────

test('a snapshot stores the English headline for a Bangla lead', () => {
  // A snapshot the reader cannot search is not worth the bytes, and the
  // translation has already been paid for.
  const compact = archive.compactStory(story({
    members: [{ title: 'বাংলাদেশ ব্যাংক নীতি সুদহার বাড়াল', titleEn: 'Bangladesh Bank raises policy rate',
                link: 'https://x.example/1', lang: 'bn' }]
  }));
  assert.equal(compact.headline, 'Bangladesh Bank raises policy rate');
});

test('a snapshot keeps the top stories and drops the tail', () => {
  const stories = Array.from({ length: 50 }, (_, i) => story({
    id: 's' + i, members: [{ title: 'Headline ' + i, link: 'https://x.example/' + i, lang: 'en' }]
  }));
  const snap = archive.buildSnapshot({ day: '2026-09-14', region: 'bd', fetchedAt: 'now', stories });
  assert.equal(snap.stories.length, archive.ARCHIVE_STORIES);
  assert.equal(snap.stories[0].id, 's0');
});

test('a snapshot carries no article bodies', () => {
  const snap = archive.buildSnapshot({
    day: '2026-09-14', region: 'bd', fetchedAt: 'now',
    stories: [story({ members: [{ title: 'A', desc: 'x'.repeat(500), link: 'https://x.example/1', lang: 'en' }] })]
  });
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('x'.repeat(100)),
    'a snapshot that copies article text is a repository that cannot be cloned');
  assert.ok(!('members' in snap.stories[0]));
});

// ── What changed ─────────────────────────────────────────────────────────

test('with no baseline, nothing is new', () => {
  // The one that matters: on the first run every story is trivially "new",
  // and announcing 146 new stories teaches the reader to ignore the badge.
  assert.equal(archive.diffStories([story({ id: 'a' })], null), null);
  assert.equal(archive.diffStories([story({ id: 'a' })], { date: '2026-09-13', stories: [] }), null);
  assert.equal(archive.diffStories([story({ id: 'a' })], { date: '2026-09-13' }), null);
});

test('a story absent from yesterday is new; one that grew is developing', () => {
  const previous = { date: '2026-09-13', stories: [
    { id: 'kept', size: 2 },
    { id: 'grown', size: 2 }
  ] };
  const diff = archive.diffStories([
    story({ id: 'kept',  members: [{}, {}] }),
    story({ id: 'grown', members: [{}, {}, {}, {}] }),
    story({ id: 'fresh', members: [{}] })
  ], previous);

  assert.equal(diff.since, '2026-09-13');
  assert.equal(diff.stories.kept.status, 'continuing');
  assert.equal(diff.stories.grown.status, 'developing');
  assert.equal(diff.stories.grown.gained, 2);
  assert.equal(diff.stories.fresh.status, 'new');
  assert.ok(!('gained' in diff.stories.kept));
});

test('a story that shrank is not reported as developing', () => {
  // Articles age out of the 30-day window, so a story can lose members.
  // That is not a development and must not be badged as one.
  const diff = archive.diffStories(
    [story({ id: 'a', members: [{}] })],
    { date: '2026-09-13', stories: [{ id: 'a', size: 3 }] });
  assert.equal(diff.stories.a.status, 'continuing');
});

test('what has dropped off the briefing is reported too', () => {
  const previous = { date: '2026-09-13', stories: [{ id: 'a', size: 1 }],
    briefing: [{ id: 'a', headline: 'Still here' }, { id: 'b', headline: 'Gone today' }] };
  const dropped = archive.droppedFromBriefing([{ id: 'a', headline: 'Still here' }], previous);
  assert.deepEqual(dropped, [{ id: 'b', headline: 'Gone today' }]);
});

test('nothing has dropped off when there is no previous briefing', () => {
  assert.deepEqual(archive.droppedFromBriefing([{ id: 'a' }], null), []);
  assert.deepEqual(archive.droppedFromBriefing([{ id: 'a' }], { date: '2026-09-13' }), []);
  assert.deepEqual(archive.droppedFromBriefing(null, { briefing: [{ id: 'b' }] }), []);
});

// ── On disk ──────────────────────────────────────────────────────────────

function write(region, day, over) {
  archive.writeSnapshot(Object.assign({
    date: day, region, fetchedAt: day + 'T00:20:00Z',
    briefing: [{ id: 's1', headline: 'H', what: 'w', why: 'y', watch: '' }],
    stories: [{ id: 's1', headline: 'H', size: 2 }]
  }, over));
}

test('snapshots round-trip and list newest first', () => {
  inTempDir(() => {
    write('bd', '2026-09-12');
    write('bd', '2026-09-14');
    write('bd', '2026-09-13');
    assert.deepEqual(archive.listDays('bd'), ['2026-09-14', '2026-09-13', '2026-09-12']);
    assert.equal(archive.readSnapshot('bd', '2026-09-13').date, '2026-09-13');
    assert.equal(archive.readSnapshot('bd', '2026-01-01'), null);
    assert.deepEqual(archive.listDays('au'), []);
  });
});

test('the baseline is a day strictly before today, not this morning', () => {
  // Both of a day's runs write the same file. Comparing today against
  // today would report the morning's news as unchanged since the morning.
  inTempDir(() => {
    write('bd', '2026-09-13');
    write('bd', '2026-09-14');
    assert.equal(archive.previousSnapshot('bd', '2026-09-14').date, '2026-09-13',
      'today\'s own snapshot must never be the baseline for today');
    assert.equal(archive.previousSnapshot('bd', '2026-09-13'), null,
      'the earliest day has nothing before it to compare against');
  });
});

test('a gap in the archive falls back to the last day there is', () => {
  inTempDir(() => {
    write('bd', '2026-09-01');
    assert.equal(archive.previousSnapshot('bd', '2026-09-14').date, '2026-09-01');
  });
});

test('snapshots past the retention window are pruned', () => {
  inTempDir(() => {
    for (let d = 1; d <= 10; d++) write('bd', '2026-09-' + String(d).padStart(2, '0'));
    const pruned = archive.prune('bd', 4);
    assert.equal(pruned.length, 6);
    assert.deepEqual(archive.listDays('bd'), ['2026-09-10', '2026-09-09', '2026-09-08', '2026-09-07']);
  });
});

test('the index is written from the directory, so it cannot drift from it', () => {
  inTempDir(() => {
    write('bd', '2026-09-14');
    write('global', '2026-09-13');
    const index = archive.writeIndex(['bd', 'au', 'global']);
    assert.deepEqual(index.regions.bd, ['2026-09-14']);
    assert.deepEqual(index.regions.au, []);
    assert.deepEqual(index.regions.global, ['2026-09-13']);
    const onDisk = JSON.parse(fs.readFileSync('archive/index.json', 'utf8'));
    assert.deepEqual(onDisk.regions, index.regions);
  });
});
