/**
 * A symlinked existing skill target is externally managed (e.g. a GNU Stow entry
 * from a dotfiles repo). `add` must never unlink it: it fails EARLY — at target
 * planning, before any staging or install — with an actionable EXTERNAL_TARGET
 * error naming the exact path, rather than the opaque late UNSAFE_ANCESTOR from
 * materialization. Verified in both project and global scope, driven as real
 * subprocesses so flag parsing and stderr rendering are exercised end to end.
 * @module test/external-target
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeCentral, makeProject, runCli, tmpDir, rmrf } from './helpers.js';

test('project add is refused EARLY when the target skill dir is a symlink', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1.0', skill: { name: 'foo', version: '1.0', body: 'ONE' } },
    ]);
    const proj = await makeProject(path.join(root, 'proj'));
    const env = { XDG_CONFIG_HOME: path.join(root, 'xdg') };
    assert.equal((await runCli(['init', '--source', central.dir, '--mode', 'plain'], { cwd: proj, env })).code, 0);

    // A Stow-style externally-managed copy: .claude/skills/foo is a symlink.
    const external = path.join(root, 'dotfiles-foo');
    await fs.mkdir(external, { recursive: true });
    await fs.mkdir(path.join(proj, '.claude/skills'), { recursive: true });
    const target = path.join(proj, '.claude/skills/foo');
    await fs.symlink(external, target);

    const add = await runCli(['add', 'foo'], { cwd: proj, env });
    assert.equal(add.code, 1, add.stderr);
    assert.match(add.stderr, /EXTERNAL_TARGET/);
    assert.match(add.stderr, /is a symlink/);
    assert.match(add.stderr, /externally managed|GNU Stow/);
    assert.match(add.stderr, /remove or unstow it first/);
    assert.match(add.stderr, /\.claude\/skills\/foo/, 'names the exact path');
    assert.doesNotMatch(add.stderr, /UNSAFE_ANCESTOR/, 'fails at planning, not late in materialization');
    // The externally-managed symlink is left untouched.
    assert.ok((await fs.lstat(target)).isSymbolicLink(), 'symlink must survive the refusal');
  } finally {
    await rmrf(root);
  }
});

test('global add is refused EARLY when the target skill dir is a symlink', async () => {
  const root = await tmpDir();
  try {
    const home = path.join(root, 'home');
    await fs.mkdir(home, { recursive: true });
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
    ]);
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(root, 'xdg') };
    assert.equal((await runCli(['init', '--global', '--source', central.dir], { cwd: home, env })).code, 0);

    // Stow-managed dotfiles: ~/.claude/skills/g is a symlink into a dotfiles repo.
    const external = path.join(root, 'dotfiles-g');
    await fs.mkdir(external, { recursive: true });
    await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
    const target = path.join(home, '.claude/skills/g');
    await fs.symlink(external, target);

    const add = await runCli(['add', '--global', 'g'], { cwd: home, env });
    assert.equal(add.code, 1, add.stderr);
    assert.match(add.stderr, /EXTERNAL_TARGET/);
    assert.match(add.stderr, /is a symlink/);
    assert.match(add.stderr, /remove or unstow it first/);
    assert.match(add.stderr, /\.claude\/skills\/g/, 'names the exact path');
    assert.doesNotMatch(add.stderr, /UNSAFE_ANCESTOR/, 'fails at planning, not late in materialization');
    // The old warn-then-fail bug: no misleading "will replace" warning precedes it.
    assert.doesNotMatch(add.stderr, /unmanaged copy already exists/, 'no misleading replace warning');
    assert.ok((await fs.lstat(target)).isSymbolicLink(), 'symlink must survive the refusal');
  } finally {
    await rmrf(root);
  }
});
