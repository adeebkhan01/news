'use strict';
//
// Tests for the workflow files.
//
// Pinning is the kind of thing that holds until the day someone adds a step in
// a hurry, writes `@v4`, and nobody notices — at which point the repository is
// back to running whatever code that tag points at today. A tag is a mutable
// pointer in someone else's repository; a commit SHA is not.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = '.github/workflows';
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

test('there are workflows to check', () => {
  assert.ok(files.length >= 2, 'no workflow files found');
});

test('every action is pinned to a full commit SHA', () => {
  const SHA = /^[0-9a-f]{40}$/;
  for (const file of files) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*-?\s*uses:\s*(\S+)/);
      if (!m) continue;
      const ref = m[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;   // local, not fetched by tag
      const at = ref.lastIndexOf('@');
      assert.notEqual(at, -1, `${file}: unversioned action: ${ref}`);
      assert.ok(
        SHA.test(ref.slice(at + 1)),
        `${file}: ${ref} is pinned to a tag, not a commit SHA. A tag can be moved; pin the SHA and put the version in a trailing comment.`
      );
    }
  }
});

test('every action pinned to a SHA says which version that is', () => {
  // The SHA is what is enforced; the comment is what makes the diff readable
  // and is what Dependabot rewrites when it bumps one.
  for (const file of files) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!/^\s*-?\s*uses:\s*\S+@[0-9a-f]{40}/.test(line)) continue;
      assert.match(line, /#\s*v?\d/, `${file}: pinned action has no version comment: ${line.trim()}`);
    }
  }
});

test('every workflow declares its permissions', () => {
  // Without a permissions block the job gets whatever the repository default
  // is, which historically was write access to everything.
  for (const file of files) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    assert.match(text, /^permissions:/m, `${file}: no top-level permissions block`);
  }
});

// The entries under the top-level `permissions:` key, read line by line and
// stopping at the next unindented key. Walking an indented block with a nested
// quantifier is how a regex ends up backtracking exponentially — it is never
// worth it for something a five-line loop reads more clearly anyway.
function topLevelPermissions(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^permissions:/.test(line));
  if (start === -1) return [];
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;          // next top-level key
    if (lines[i].trim()) entries.push(lines[i].trim());
  }
  return entries;
}

test('only the workflow that publishes may write', () => {
  // One job commits to main. Every other job reads. If that stops being true,
  // it should be a deliberate edit to this test, not a quiet change in a yml.
  const writers = files.filter(f =>
    topLevelPermissions(fs.readFileSync(path.join(DIR, f), 'utf8'))
      .some(entry => /^contents:\s*write$/.test(entry))
  );
  assert.deepEqual(writers, ['fetch-feeds.yml']);
});

test('the publishing workflow runs the tests before it commits', () => {
  // The gate in the architecture: fetch, validate, and only then publish. If
  // the commit step ever moves above the test step, nothing else catches it.
  const text = fs.readFileSync(path.join(DIR, 'fetch-feeds.yml'), 'utf8');
  const validate = text.indexOf('node --test');
  const commit = text.indexOf('Commit data files');
  assert.ok(validate !== -1, 'fetch-feeds.yml does not run the tests');
  assert.ok(commit !== -1, 'fetch-feeds.yml has no commit step');
  assert.ok(validate < commit, 'the tests run after the commit step — they gate nothing');
});

test('secrets are scoped to the step that needs them', () => {
  // OPEN_ROUTER belongs to the fetch step. A workflow-level or job-level
  // env block would hand it to the commit step and to every action either one
  // runs.
  const text = fs.readFileSync(path.join(DIR, 'fetch-feeds.yml'), 'utf8');
  const uses = [...text.matchAll(/OPEN_ROUTER/g)];
  assert.equal(uses.length, 2, 'expected the key named once as an env var and once as the secret');
  // The env block sits inside a step, which means it is indented past the
  // step's own keys rather than sitting at job or workflow level.
  assert.match(text, /\n {8}env:\n {10}OPEN_ROUTER:/,
    'OPEN_ROUTER is not scoped to a single step');
});
