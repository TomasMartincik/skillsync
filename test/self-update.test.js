/**
 * `skillsync self-update` — refuses without confirmation, `--yes` fast-forwards,
 * ff-only refuses on divergence, and reports "up to date" when there is nothing
 * to pull. Uses a real fixture: an origin repo cloned into an install clone
 * (pointed at via SKILLSYNC_HOME), with an incoming commit on origin.
 * @module test/self-update
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, gitSync, runCli } from './helpers.js';

/**
 * Build an origin repo and an install clone of it with `n` incoming commits
 * waiting on origin.
 * @param {string} root
 * @returns {Promise<{ origin: string, clone: string }>}
 */
async function makeCloneWithIncoming(root) {
  const origin = path.join(root, 'origin');
  await fs.mkdir(origin, { recursive: true });
  gitSync(origin, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(origin, 'VERSION'), 'v1\n');
  gitSync(origin, ['add', '-A']);
  gitSync(origin, ['commit', '-q', '-m', 'v1']);

  const clone = path.join(root, 'clone');
  gitSync(root, ['clone', '-q', origin, clone]);

  // A new commit lands on origin — the clone's `fetch` will see it.
  await fs.writeFile(path.join(origin, 'VERSION'), 'v2\n');
  gitSync(origin, ['add', '-A']);
  gitSync(origin, ['commit', '-q', '-m', 'v2 incoming feature']);

  return { origin, clone };
}

test('self-update refuses to merge without confirmation (non-interactive)', async () => {
  const root = await tmpDir();
  try {
    const { clone } = await makeCloneWithIncoming(root);
    const head0 = gitSync(clone, ['rev-parse', 'HEAD']);
    const env = { HOME: path.join(root, 'home'), SKILLSYNC_HOME: clone };

    const r = await runCli(['self-update'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /v2 incoming feature/, 'shows the incoming commit log');
    assert.match(r.stdout, /VERSION/, 'shows the diff stat');
    assert.match(r.stderr, /non-interactive: refusing/);
    assert.equal(gitSync(clone, ['rev-parse', 'HEAD']), head0, 'HEAD not advanced without confirmation');
  } finally {
    await rmrf(root);
  }
});

test('self-update --yes fast-forwards and repairs hooks', async () => {
  const root = await tmpDir();
  try {
    const { origin, clone } = await makeCloneWithIncoming(root);
    const originHead = gitSync(origin, ['rev-parse', 'HEAD']);
    const home = path.join(root, 'home');
    const env = { HOME: home, SKILLSYNC_HOME: clone };

    const r = await runCli(['self-update', '--yes'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /updated\./);
    assert.equal(gitSync(clone, ['rev-parse', 'HEAD']), originHead, 'fast-forwarded to origin tip');
    assert.equal((await fs.readFile(path.join(clone, 'VERSION'), 'utf8')).trim(), 'v2');

    // Hooks were repaired into the sandbox HOME.
    const claude = await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8');
    assert.match(claude, /skillsync-notice/);
  } finally {
    await rmrf(root);
  }
});

test('self-update reports up to date when there is nothing to pull', async () => {
  const root = await tmpDir();
  try {
    const { clone } = await makeCloneWithIncoming(root);
    const env = { HOME: path.join(root, 'home'), SKILLSYNC_HOME: clone };
    // First --yes catches up; the second run has nothing incoming.
    await runCli(['self-update', '--yes'], { cwd: root, env });
    const r = await runCli(['self-update', '--yes'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already up to date/i);
  } finally {
    await rmrf(root);
  }
});

test('self-update refuses a non-fast-forward divergence', async () => {
  const root = await tmpDir();
  try {
    const { clone } = await makeCloneWithIncoming(root);
    // Diverge: a local commit in the clone that is not on origin.
    await fs.writeFile(path.join(clone, 'LOCAL'), 'local\n');
    gitSync(clone, ['add', '-A']);
    gitSync(clone, ['commit', '-q', '-m', 'local divergent commit']);
    const localHead = gitSync(clone, ['rev-parse', 'HEAD']);
    const env = { HOME: path.join(root, 'home'), SKILLSYNC_HOME: clone };

    const r = await runCli(['self-update', '--yes'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /could not fast-forward/);
    assert.equal(gitSync(clone, ['rev-parse', 'HEAD']), localHead, 'divergent local HEAD left intact');
  } finally {
    await rmrf(root);
  }
});
