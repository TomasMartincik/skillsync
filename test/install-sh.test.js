/**
 * install.sh: POSIX syntax check plus an idempotency run in a sandboxed HOME.
 * The install source is a local fixture git repo (SKILLSYNC_REPO) so no network
 * is touched; hooks are skipped (SKILLSYNC_NO_HOOKS=1) so the script's own
 * clone / symlink / PATH-advice / re-run behavior is what's under test — not a
 * stub CLI.
 * @module test/install-sh
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, rmrf, gitSync, BIN } from './helpers.js';

const INSTALL_SH = path.resolve(path.dirname(BIN), '..', 'install.sh');

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string,string> }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function sh(args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', args, {
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

test('install.sh passes `sh -n` syntax check', async () => {
  const r = await sh(['-n', INSTALL_SH], { cwd: path.dirname(INSTALL_SH) });
  assert.equal(r.code, 0, r.stderr);
});

test('install.sh clones, symlinks, and is idempotent on re-run', async () => {
  const root = await tmpDir();
  try {
    // Fixture "skillsync" repo with a runnable entry point.
    const repo = path.join(root, 'skillsync-src');
    await fs.mkdir(path.join(repo, 'bin'), { recursive: true });
    await fs.writeFile(path.join(repo, 'bin', 'skillsync.js'), "#!/usr/bin/env node\nconsole.log('stub');\n");
    gitSync(repo, ['init', '-q', '-b', 'main']);
    gitSync(repo, ['add', '-A']);
    gitSync(repo, ['commit', '-q', '-m', 'init']);

    const home = path.join(root, 'home');
    await fs.mkdir(home, { recursive: true });
    const env = {
      HOME: home,
      SKILLSYNC_REPO: repo,
      SKILLSYNC_NO_HOOKS: '1',
      // Real PATH keeps node+git available; the sandbox HOME's ~/.local/bin is
      // (by construction) not on it, so the PATH-advice branch is exercised.
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    };

    const dataDir = path.join(home, '.local', 'share', 'skillsync');
    const link = path.join(home, '.local', 'bin', 'skillsync');

    const r1 = await sh([INSTALL_SH], { cwd: root, env });
    assert.equal(r1.code, 0, r1.stderr);
    assert.ok((await fs.stat(path.join(dataDir, '.git'))).isDirectory(), 'clone created');
    assert.equal(await fs.realpath(link), await fs.realpath(path.join(dataDir, "bin", "skillsync.js")), "symlink points at entry");
    assert.match(r1.stdout, /not on your PATH/, 'PATH advice printed');

    // Idempotent re-run: still succeeds, link and clone intact.
    const r2 = await sh([INSTALL_SH], { cwd: root, env });
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /updating existing clone/, 'took the pull path on re-run');
    assert.equal(await fs.realpath(link), await fs.realpath(path.join(dataDir, 'bin', 'skillsync.js')), 'symlink still valid');
    assert.ok(((await fs.lstat(link)).isSymbolicLink()), 'link is still a symlink');
  } finally {
    await rmrf(root);
  }
});

test('install.sh honors SKILLSYNC_NO_HOOKS by skipping hook installation', async () => {
  const root = await tmpDir();
  try {
    const repo = path.join(root, 'src');
    await fs.mkdir(path.join(repo, 'bin'), { recursive: true });
    await fs.writeFile(path.join(repo, 'bin', 'skillsync.js'), '#!/usr/bin/env node\n');
    gitSync(repo, ['init', '-q', '-b', 'main']);
    gitSync(repo, ['add', '-A']);
    gitSync(repo, ['commit', '-q', '-m', 'init']);

    const home = path.join(root, 'home');
    await fs.mkdir(home, { recursive: true });
    const r = await sh([INSTALL_SH], {
      cwd: root,
      env: { HOME: home, SKILLSYNC_REPO: repo, SKILLSYNC_NO_HOOKS: '1', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipping hook installation/);
    // No ~/.claude or ~/.codex written.
    await assert.rejects(fs.access(path.join(home, '.claude', 'settings.json')));
  } finally {
    await rmrf(root);
  }
});
