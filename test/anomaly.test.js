import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { init } from '../src/commands/init.js';
import { add } from '../src/commands/add.js';
import { sync } from '../src/commands/sync.js';
import { makeCentral, runCli, tmpDir, rmrf } from './helpers.js';

async function withIsolatedConfig(root, fn) {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

/**
 * Adversarial-review MAJOR: an integrity anomaly (symlink/FIFO/oversized/unreadable
 * file swapped into a materialized copy) was classified as `missing` and silently
 * overwritten without `--force`. Only a genuinely absent copy is `missing`; an
 * anomaly is drift that requires `--force`, and `list` reports it as an anomaly.
 */
test('an anomalous materialized copy is skipped without --force and reported by list', async () => {
  const root = await tmpDir();
  try {
    await withIsolatedConfig(root, async () => {
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'v1.0', skill: { name: 'foo', version: '1.0', body: 'ONE' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });
      await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });
      await add(['foo'], { cwd: proj });

      // Swap the materialized claude SKILL.md for a symlink — an integrity anomaly,
      // NOT an absence.
      const claudeSkill = path.join(proj, '.claude/skills/foo/SKILL.md');
      await fs.rm(claudeSkill);
      await fs.symlink('/etc/hostname', claudeSkill);

      // list reports the copy as anomalous (not missing, not ok).
      const listed = await runCli(['list'], { cwd: proj, env: { XDG_CONFIG_HOME: path.join(root, 'xdg') } });
      assert.match(listed.stdout, /foo@1\.0/);
      assert.match(listed.stdout, /claude:anomaly/);

      // sync without --force must NOT overwrite the anomalous copy.
      await sync([], { cwd: proj });
      assert.ok((await fs.lstat(claudeSkill)).isSymbolicLink(), 'anomaly must survive a non-forced sync');

      // --force overwrites it with the real materialized file.
      await sync(['--force'], { cwd: proj });
      const st = await fs.lstat(claudeSkill);
      assert.ok(st.isFile() && !st.isSymbolicLink());
      assert.match(await fs.readFile(claudeSkill, 'utf8'), /ONE/);
    });
  } finally {
    await rmrf(root);
  }
});

/**
 * Adversarial-review MAJOR: the TARGET ROOT was never lstat'd, so a materialized
 * skill dir REPLACED by a symlink (even to a tree with the expected bytes) could
 * be followed and reported `ok`. It must be an anomaly, and `sync` must not
 * silently overwrite it.
 */
test('a symlinked target ROOT is an anomaly, not ok/missing', async () => {
  const root = await tmpDir();
  try {
    await withIsolatedConfig(root, async () => {
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'v1.0', skill: { name: 'foo', version: '1.0', body: 'ONE' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });
      await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });
      await add(['foo'], { cwd: proj });

      // Replace the whole claude skill dir with a symlink to an external tree that
      // happens to contain the same bytes.
      const external = path.join(root, 'external-foo');
      await fs.cp(path.join(proj, '.claude/skills/foo'), external, { recursive: true });
      await fs.rm(path.join(proj, '.claude/skills/foo'), { recursive: true, force: true });
      await fs.symlink(external, path.join(proj, '.claude/skills/foo'));

      const listed = await runCli(['list'], { cwd: proj, env: { XDG_CONFIG_HOME: path.join(root, 'xdg') } });
      assert.match(listed.stdout, /claude:anomaly/);

      await sync([], { cwd: proj }); // must not overwrite the anomalous symlinked root
      assert.ok((await fs.lstat(path.join(proj, '.claude/skills/foo'))).isSymbolicLink());
    });
  } finally {
    await rmrf(root);
  }
});
