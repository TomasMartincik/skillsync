/**
 * `skillsync self-update` — refuses without confirmation, `--yes` fast-forwards,
 * ff-only refuses on divergence, and reports "up to date" when there is nothing
 * to pull. Uses a real fixture: an origin repo cloned into an install clone
 * (pointed at via SKILLSYNC_HOME), with an incoming commit on origin.
 * @module test/self-update
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, gitSync, runCli, BIN } from './helpers.js';

/** Repo root of the CLI under test (BIN is <root>/bin/skillsync.js). */
const REPO_ROOT = path.dirname(path.dirname(BIN));

/**
 * Copy the runnable CLI (bin/src/package.json) into a fixture dir so it is a
 * real skillsync install — self-update repairs hooks by spawning that CLI, so
 * the clone must actually be able to run `hooks install`.
 * @param {string} dir
 */
function seedCli(dir) {
  execFileSync('cp', [
    '-R',
    path.join(REPO_ROOT, 'bin'),
    path.join(REPO_ROOT, 'src'),
    path.join(REPO_ROOT, 'package.json'),
    dir,
  ]);
}

/**
 * Build an origin repo and an install clone of it with `n` incoming commits
 * waiting on origin. The clone carries the full CLI so hook repair can run.
 * @param {string} root
 * @returns {Promise<{ origin: string, clone: string }>}
 */
async function makeCloneWithIncoming(root) {
  const origin = path.join(root, 'origin');
  await fs.mkdir(origin, { recursive: true });
  seedCli(origin);
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

/**
 * Simulate a real upgrade: the install clone sits at an 'old' commit whose
 * `hooks-config.js` writes a distinguishable (pre-fix) hook shape; origin's tip
 * carries the corrected implementation. Fast-forwarding then repairing must
 * produce the NEW shape — provable only if the repair runs the just-pulled code.
 * @param {string} root
 * @returns {Promise<{ origin: string, clone: string }>}
 */
async function makeUpgradeClone(root) {
  const origin = path.join(root, 'origin');
  await fs.mkdir(origin, { recursive: true });
  seedCli(origin);
  gitSync(origin, ['init', '-q', '-b', 'main']);

  const hooksConfig = path.join(origin, 'src', 'hooks-config.js');
  const current = await fs.readFile(hooksConfig, 'utf8');
  // OLD commit: the Claude hook command carries a marker the current code never
  // writes — a stand-in for any pre-fix implementation quirk (cf. #27/#28).
  const legacy = current.replace('--agent claude', '--agent claude --skillsync-old-shape');
  assert.notEqual(legacy, current, 'fixture marker must apply to hooks-config.js');
  await fs.writeFile(hooksConfig, legacy);
  gitSync(origin, ['add', '-A']);
  gitSync(origin, ['commit', '-q', '-m', 'old: pre-fix hook shape']);

  // The install clone starts at the OLD commit — a machine due for an update.
  const clone = path.join(root, 'clone');
  gitSync(root, ['clone', '-q', origin, clone]);

  // NEW commit on origin: the corrected implementation the update will deliver.
  await fs.writeFile(hooksConfig, current);
  gitSync(origin, ['add', '-A']);
  gitSync(origin, ['commit', '-q', '-m', 'new: corrected hook shape']);

  return { origin, clone };
}

/**
 * Run a bin/skillsync.js at an explicit path (not the shared repo BIN) as a real
 * child. The upgrade test must run the CLONE's own CLI so the self-update
 * process's ESM module cache is frozen at the pre-update code — exactly the
 * condition the in-process repair got wrong.
 * @param {string} bin
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string,string> }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runBin(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
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

test('self-update repairs hooks with the post-update code, not the ESM-cached impl', async () => {
  const root = await tmpDir();
  try {
    const { origin, clone } = await makeUpgradeClone(root);
    const originHead = gitSync(origin, ['rev-parse', 'HEAD']);
    const home = path.join(root, 'home');
    // Run the CLONE's own CLI (installDir resolves from its module path), so the
    // self-update process is the pre-update code — no SKILLSYNC_HOME override.
    const env = { HOME: home };

    const r = await runBin(path.join(clone, 'bin', 'skillsync.js'), ['self-update', '--yes'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /updated\./);
    assert.equal(gitSync(clone, ['rev-parse', 'HEAD']), originHead, 'fast-forwarded to origin tip');

    const claude = await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8');
    // The NEW shape: repair ran the just-pulled code in a fresh process...
    assert.match(claude, /--agent claude"/, 'wrote the post-update hook shape');
    // ...not the pre-update impl frozen in the self-update process's module cache
    // (an in-process installHooks() would have re-emitted the old marker).
    assert.doesNotMatch(claude, /skillsync-old-shape/, 'must not use the in-process (pre-update) code');
  } finally {
    await rmrf(root);
  }
});
