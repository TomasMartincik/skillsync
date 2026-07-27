/**
 * SessionStart guard (`bin/skillsync-notice.js`). The guard is exercised as a
 * real subprocess; the skillsync binary it calls is STUBBED with a fake script
 * (via SKILLSYNC_BIN) so these tests never depend on the concurrently-built
 * `status --cached` command.
 * @module test/notice-guard
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, BIN } from './helpers.js';

const GUARD = path.join(path.dirname(BIN), 'skillsync-notice.js');

/**
 * @param {{ cwd: string, home?: string, agent?: string, env?: Record<string,string> }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runGuard(opts) {
  const args = [GUARD];
  if (opts.agent) args.push('--agent', opts.agent);
  // Pin HOME to a sandbox so the global-manifest fall-through is deterministic and
  // never reads (or reports on) the developer's real ~/.agents manifest.
  const home = opts.home ?? opts.cwd;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd,
      env: { ...process.env, HOME: home, ...(opts.env ?? {}) },
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

/** Write an executable stub script at `p`. @param {string} p @param {string} body */
async function writeStub(p, body) {
  await fs.writeFile(p, body, { mode: 0o755 });
  await fs.chmod(p, 0o755);
}

/** A project dir containing the manifest. @param {string} root */
async function makeProjWithManifest(root) {
  const proj = path.join(root, 'proj');
  await fs.mkdir(path.join(proj, '.agents'), { recursive: true });
  await fs.writeFile(path.join(proj, '.agents', 'skills-manifest.json'), '{"version":1}');
  return proj;
}

/** Write a global manifest directly under a sandbox HOME. @param {string} home */
async function makeGlobalManifest(home) {
  await fs.mkdir(path.join(home, '.agents'), { recursive: true });
  await fs.writeFile(path.join(home, '.agents', 'skills-manifest.json'), '{"version":1}');
}

test('guard is silent when no manifest is found', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'no-manifest');
    await fs.mkdir(proj, { recursive: true });
    // A stub that WOULD print, to prove the manifest gate short-circuits first.
    const stub = path.join(root, 'stub.sh');
    await writeStub(stub, '#!/bin/sh\necho "grilling 1.2 -> 1.3 (minor)"\n');
    const r = await runGuard({ cwd: proj, home: root, env: { SKILLSYNC_BIN: stub } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '', 'no output without a manifest');
  } finally {
    await rmrf(root);
  }
});

test('guard is silent when the skillsync binary is missing', async () => {
  const root = await tmpDir();
  try {
    const proj = await makeProjWithManifest(root);
    const r = await runGuard({ cwd: proj, home: root, env: { SKILLSYNC_BIN: path.join(root, 'does-not-exist') } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    await rmrf(root);
  }
});

test('guard is silent when status prints nothing (up to date)', async () => {
  const root = await tmpDir();
  try {
    const proj = await makeProjWithManifest(root);
    const stub = path.join(root, 'stub.sh');
    await writeStub(stub, '#!/bin/sh\nexit 0\n');
    const r = await runGuard({ cwd: proj, home: root, env: { SKILLSYNC_BIN: stub } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    await rmrf(root);
  }
});

test('guard emits the notice line for Claude (plain stdout), no migration warning for minors', async () => {
  const root = await tmpDir();
  try {
    const proj = await makeProjWithManifest(root);
    const stub = path.join(root, 'stub.sh');
    await writeStub(stub, '#!/bin/sh\necho "grilling 1.2 -> 1.3 (minor)"\n');
    const r = await runGuard({ cwd: proj, home: root, agent: 'claude', env: { SKILLSYNC_BIN: stub } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /grilling 1\.2 -> 1\.3 \(minor\)/);
    assert.doesNotMatch(r.stdout, /migration/i, 'no migration warning for a minor');
  } finally {
    await rmrf(root);
  }
});

test('guard emits Codex JSON systemMessage and appends the migration warning for majors', async () => {
  const root = await tmpDir();
  try {
    const proj = await makeProjWithManifest(root);
    const stub = path.join(root, 'stub.sh');
    await writeStub(stub, '#!/bin/sh\necho "grilling 1.2 -> 2.0 (major)"\n');
    const r = await runGuard({ cwd: proj, home: root, agent: 'codex', env: { SKILLSYNC_BIN: stub } });
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout.trim());
    assert.ok(typeof payload.systemMessage === 'string', 'documented Codex shape');
    assert.match(payload.systemMessage, /grilling 1\.2 -> 2\.0 \(major\)/);
    assert.match(payload.systemMessage, /migrations/, 'migration warning appended for majors');
    assert.match(payload.systemMessage, /update <skill> --major/);
  } finally {
    await rmrf(root);
  }
});

test('guard finds the manifest in an ancestor directory', async () => {
  const root = await tmpDir();
  try {
    const proj = await makeProjWithManifest(root);
    const deep = path.join(proj, 'a', 'b', 'c');
    await fs.mkdir(deep, { recursive: true });
    const stub = path.join(root, 'stub.sh');
    await writeStub(stub, '#!/bin/sh\necho "grilling 1.2 -> 1.3 (minor)"\n');
    const r = await runGuard({ cwd: deep, home: root, agent: 'claude', env: { SKILLSYNC_BIN: stub } });
    assert.match(r.stdout, /grilling/);
  } finally {
    await rmrf(root);
  }
});

test('guard fails open (silent) when status times out', async () => {
  const root = await tmpDir();
  try {
    const proj = await makeProjWithManifest(root);
    const stub = path.join(root, 'slow.sh');
    await writeStub(stub, '#!/bin/sh\nsleep 3\necho "grilling 1.2 -> 2.0 (major)"\n');
    const start = Date.now();
    const r = await runGuard({
      cwd: proj,
      home: root,
      agent: 'claude',
      env: { SKILLSYNC_BIN: stub, SKILLSYNC_NOTICE_TIMEOUT_MS: '400' },
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '', 'timeout fails open with no output');
    assert.ok(Date.now() - start < 2500, 'returned promptly on timeout, not after the full sleep');
  } finally {
    await rmrf(root);
  }
});

test('guard fails open (silent) when status exits non-zero', async () => {
  const root = await tmpDir();
  try {
    const proj = await makeProjWithManifest(root);
    const stub = path.join(root, 'fail.sh');
    await writeStub(stub, '#!/bin/sh\necho "boom" >&2\nexit 3\n');
    const r = await runGuard({ cwd: proj, home: root, agent: 'claude', env: { SKILLSYNC_BIN: stub } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    await rmrf(root);
  }
});

test('guard falls through to the global manifest and runs status --global', async () => {
  const root = await tmpDir();
  try {
    // HOME has a global manifest; cwd is an ordinary HOME subdir with NO project.
    await makeGlobalManifest(root);
    const work = path.join(root, 'work');
    await fs.mkdir(work, { recursive: true });
    // Stub echoes the args it received so we can prove --global was passed through.
    const stub = path.join(root, 'stub.sh');
    await writeStub(stub, '#!/bin/sh\necho "pending [$*]"\n');
    const r = await runGuard({ cwd: work, home: root, agent: 'claude', env: { SKILLSYNC_BIN: stub } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /pending/);
    assert.match(r.stdout, /--global/, 'global fall-through passes --global to status');
  } finally {
    await rmrf(root);
  }
});

test('guard prefers a project manifest over the global one (no --global)', async () => {
  const root = await tmpDir();
  try {
    await makeGlobalManifest(root); // global manifest also present under HOME
    const proj = await makeProjWithManifest(root); // but cwd is a real project
    const stub = path.join(root, 'stub.sh');
    await writeStub(stub, '#!/bin/sh\necho "pending [$*]"\n');
    const r = await runGuard({ cwd: proj, home: root, agent: 'claude', env: { SKILLSYNC_BIN: stub } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /pending/);
    assert.doesNotMatch(r.stdout, /--global/, 'project scope takes precedence, stays non-global');
  } finally {
    await rmrf(root);
  }
});
