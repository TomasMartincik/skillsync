/**
 * Global scope (`--global`): the project verbs operate on $HOME-managed skills
 * (`~/.claude/skills`, `~/.agents/skills`) via the same path-relative machinery.
 *
 * Driven as real subprocesses so `--global` flag parsing, HOME resolution (via a
 * sandbox $HOME), and stderr warnings are all exercised end to end. A throwaway
 * $HOME and XDG_CONFIG_HOME keep the developer's real home and config untouched.
 * @module test/global
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest } from '../src/manifest.js';
import { makeCentral, writeSkill, centralSkillDir, gitSync, runCli, tmpDir, rmrf } from './helpers.js';

/** Sandbox subprocess env: isolated global config + isolated HOME. */
function envFor(home, root) {
  return { HOME: home, XDG_CONFIG_HOME: path.join(root, 'xdg') };
}

/** A fresh sandbox: { root, home, central } with one skill `g@1.0` in central. */
async function sandbox(extraCommits = []) {
  const root = await tmpDir();
  const home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  const central = await makeCentral(path.join(root, 'central'), [
    { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
    ...extraCommits,
  ]);
  return { root, home, central, env: envFor(home, root) };
}

const GLOBAL_MANIFEST = '.agents/skills-manifest.json';

test('init --global creates the HOME manifest with mode plain', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    // cwd is HOME itself — the "project rooted at $HOME" case is fine WITH --global.
    const r = await runCli(['init', '--global', '--source', central.dir], { cwd: home, env });
    assert.equal(r.code, 0, r.stderr);
    const m = await readManifest(path.join(home, GLOBAL_MANIFEST));
    assert.equal(m.mode, 'plain');
    assert.equal(m.source, central.dir);
  } finally {
    await rmrf(root);
  }
});

test('init --global --mode committed is refused', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    const r = await runCli(['init', '--global', '--mode', 'committed', '--source', central.dir], { cwd: home, env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /BAD_MODE/);
    assert.match(r.stderr, /always plain/);
  } finally {
    await rmrf(root);
  }
});

test('a bare command whose cwd IS $HOME is refused (walk-up refusal)', async () => {
  const { root, home, env } = await sandbox();
  try {
    const r = await runCli(['status'], { cwd: home, env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /GLOBAL_SCOPE/);
    assert.match(r.stderr, /--global/);
  } finally {
    await rmrf(root);
  }
});

test('the walk-up refusal normalizes a trailing slash on $HOME', async () => {
  const { root, home, env } = await sandbox();
  try {
    // HOME carries a trailing slash; cwd does not. They must still compare equal.
    const r = await runCli(['status'], { cwd: home, env: { ...env, HOME: `${home}/` } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /GLOBAL_SCOPE/);
  } finally {
    await rmrf(root);
  }
});

test('global add/sync/remove materializes and cleans up both HOME skills dirs', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    // cwd is a neutral dir; --global forces the root to HOME regardless.
    const cwd = path.join(root, 'elsewhere');
    await fs.mkdir(cwd, { recursive: true });

    await runCli(['init', '--global', '--source', central.dir], { cwd, env });
    const add = await runCli(['add', '--global', 'g'], { cwd, env });
    assert.equal(add.code, 0, add.stderr);
    assert.ok((await fs.stat(path.join(home, '.claude/skills/g'))).isDirectory());
    assert.ok((await fs.stat(path.join(home, '.agents/skills/g'))).isDirectory());
    assert.match(await fs.readFile(path.join(home, '.claude/skills/g/SKILL.md'), 'utf8'), /ONE/);

    // Delete a copy, then sync --global restores it.
    await fs.rm(path.join(home, '.claude/skills/g'), { recursive: true, force: true });
    const sync = await runCli(['sync', '--global'], { cwd, env });
    assert.equal(sync.code, 0, sync.stderr);
    assert.ok((await fs.stat(path.join(home, '.claude/skills/g'))).isDirectory());

    const rm = await runCli(['remove', '--global', 'g'], { cwd, env });
    assert.equal(rm.code, 0, rm.stderr);
    await assert.rejects(fs.stat(path.join(home, '.claude/skills/g')));
    await assert.rejects(fs.stat(path.join(home, '.agents/skills/g')));
    const m = await readManifest(path.join(home, GLOBAL_MANIFEST));
    assert.deepEqual(m.skills, {});
  } finally {
    await rmrf(root);
  }
});

test('pre-existing unmanaged neighbor skills survive global add/sync/remove of another skill', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    // Two unmanaged neighbor dirs skillsync must never touch.
    for (const rel of ['.claude/skills/keepme', '.agents/skills/keepme']) {
      const dir = path.join(home, rel);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'NOTES.md'), 'KEEP', 'utf8');
    }
    const readKeep = () =>
      Promise.all([
        fs.readFile(path.join(home, '.claude/skills/keepme/NOTES.md'), 'utf8'),
        fs.readFile(path.join(home, '.agents/skills/keepme/NOTES.md'), 'utf8'),
      ]);

    await runCli(['init', '--global', '--source', central.dir], { cwd: home, env });
    await runCli(['add', '--global', 'g'], { cwd: home, env });
    assert.deepEqual(await readKeep(), ['KEEP', 'KEEP'], 'survived add');

    await runCli(['sync', '--global', '--force'], { cwd: home, env });
    assert.deepEqual(await readKeep(), ['KEEP', 'KEEP'], 'survived sync');

    await runCli(['remove', '--global', 'g'], { cwd: home, env });
    assert.deepEqual(await readKeep(), ['KEEP', 'KEEP'], 'survived remove');
    // The neighbor was never managed, so it stays on disk.
    assert.ok((await fs.stat(path.join(home, '.claude/skills/keepme'))).isDirectory());
  } finally {
    await rmrf(root);
  }
});

test('add --global warns about a pre-existing unmanaged copy of the same name', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    const stray = path.join(home, '.claude/skills/g');
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(path.join(stray, 'SKILL.md'), 'stray', 'utf8');

    await runCli(['init', '--global', '--source', central.dir], { cwd: home, env });
    const add = await runCli(['add', '--global', 'g'], { cwd: home, env });
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stderr, /unmanaged copy already exists/);
    assert.match(add.stderr, /\.claude\/skills\/g/);
    // The managed materialization still lands (the stray copy is replaced).
    assert.match(await fs.readFile(path.join(home, '.claude/skills/g/SKILL.md'), 'utf8'), /ONE/);
  } finally {
    await rmrf(root);
  }
});

test('a globally-managed skill triggers the project-side HOME-shadow warning', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    // Manage `g` globally: it now lives in ~/.agents/skills/g.
    await runCli(['init', '--global', '--source', central.dir], { cwd: home, env });
    await runCli(['add', '--global', 'g'], { cwd: home, env });

    // A separate project also pins `g`. Its cached status must warn about the HOME copy.
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    await runCli(['init', '--source', central.dir, '--mode', 'plain'], { cwd: proj, env });
    await runCli(['add', 'g'], { cwd: proj, env }); // refreshes the version cache

    const st = await runCli(['status', '--cached'], { cwd: proj, env });
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stderr, /also present in/);
    assert.match(st.stderr, /\.agents\/skills\/g/);
    assert.match(st.stderr, /shadow/);
  } finally {
    await rmrf(root);
  }
});

test('global status does NOT warn about its own managed HOME copy', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    await runCli(['init', '--global', '--source', central.dir], { cwd: home, env });
    await runCli(['add', '--global', 'g'], { cwd: home, env });
    const st = await runCli(['status', '--cached', '--global'], { cwd: home, env });
    assert.equal(st.code, 0, st.stderr);
    assert.doesNotMatch(st.stderr, /also present in/, 'the managed copy is not a shadow of itself');
  } finally {
    await rmrf(root);
  }
});

test('list --global and update --global operate on the HOME scope', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    await runCli(['init', '--global', '--source', central.dir], { cwd: home, env });
    await runCli(['add', '--global', 'g'], { cwd: home, env });

    const ls = await runCli(['list', '--global'], { cwd: home, env });
    assert.equal(ls.code, 0, ls.stderr);
    assert.match(ls.stdout, /g@1\.0/);

    // Central advances; update --global applies the pending minor to the HOME copy.
    await writeSkill(centralSkillDir(central.dir, 'g'), { name: 'g', version: '1.1', body: 'TWO' });
    gitSync(central.dir, ['add', '-A']);
    gitSync(central.dir, ['commit', '-q', '-m', 'v1.1']);
    const up = await runCli(['update', '--global'], { cwd: home, env });
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /update g 1\.0 -> 1\.1/);

    const m = await readManifest(path.join(home, GLOBAL_MANIFEST));
    assert.equal(m.skills.g.version, '1.1');
    assert.match(await fs.readFile(path.join(home, '.agents/skills/g/SKILL.md'), 'utf8'), /TWO/);
  } finally {
    await rmrf(root);
  }
});

test('global operations resolve a symlinked $HOME to the real directory', async () => {
  const { root, central } = await sandbox();
  try {
    // $HOME is itself a symlink to the real home dir (some real-world setups do this).
    const real = path.join(root, 'realhome');
    await fs.mkdir(real, { recursive: true });
    const link = path.join(root, 'homelink');
    await fs.symlink(real, link);
    const env = { HOME: link, XDG_CONFIG_HOME: path.join(root, 'xdg') };

    const init = await runCli(['init', '--global', '--source', central.dir], { cwd: link, env });
    assert.equal(init.code, 0, init.stderr);
    const add = await runCli(['add', '--global', 'g'], { cwd: link, env });
    assert.equal(add.code, 0, add.stderr);
    // Materialized under the REAL directory, reachable through the symlink.
    assert.ok((await fs.stat(path.join(real, '.claude/skills/g'))).isDirectory());
  } finally {
    await rmrf(root);
  }
});

test('add --global warns when EXPANDING a managed skill to a new agent that has a stray copy', async () => {
  const { root, home, central, env } = await sandbox();
  try {
    await runCli(['init', '--global', '--source', central.dir], { cwd: home, env });
    // Manage g for claude only.
    await runCli(['add', '--global', 'g', '--agents', 'claude'], { cwd: home, env });
    // An unmanaged copy appears in the Codex dir (not yet a target agent).
    const stray = path.join(home, '.agents/skills/g');
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(path.join(stray, 'SKILL.md'), 'stray', 'utf8');

    // Re-add without a filter → expands to codex, whose dir already has a stray copy.
    const add = await runCli(['add', '--global', 'g'], { cwd: home, env });
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stderr, /unmanaged copy already exists/);
    assert.match(add.stderr, /\.agents\/skills\/g/, 'warns for the newly-targeted Codex agent');
  } finally {
    await rmrf(root);
  }
});
