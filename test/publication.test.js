import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fullClone, resolveVersionToCommit } from '../src/fetch.js';
import { init } from '../src/commands/init.js';
import { add } from '../src/commands/add.js';
import { sync } from '../src/commands/sync.js';
import { readManifest, serializeManifest } from '../src/manifest.js';
import { makeCentral, writeSkill, gitSync, tmpDir, rmrf } from './helpers.js';

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
 * Version resolution returns the newest first-parent commit that declares the
 * pinned version.
 */
test('resolveVersionToCommit finds the newest first-parent declaration of a version', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1.0', skill: { name: 'foo', version: '1.0', body: 'ONE' } },
      { message: 'v1.1', skill: { name: 'foo', version: '1.1', body: 'TWO' } },
    ]);
    const [c10, c11] = central.commits;
    const clone = await fullClone(central.dir);
    try {
      assert.equal(await resolveVersionToCommit(clone.dir, 'foo', '1.0'), c10);
      assert.equal(await resolveVersionToCommit(clone.dir, 'foo', '1.1'), c11);
      await assert.rejects(resolveVersionToCommit(clone.dir, 'foo', '9.9'), (err) => err.code === 'UNRESOLVABLE_PIN');
    } finally {
      await clone.cleanup();
    }
  } finally {
    await rmrf(root);
  }
});

/**
 * The recorded commit is only a cache. If it declares a DIFFERENT version than the
 * pin (a stale/wrong but still-reachable commit), sync must resolve the pinned
 * version from history instead of failing.
 */
test('version resolution overrides a wrong-but-reachable cached commit', async () => {
  const root = await tmpDir();
  try {
    await withIsolatedConfig(root, async () => {
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'v1.0', skill: { name: 'foo', version: '1.0', body: 'ONE' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });
      await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });
      await add(['foo'], { cwd: proj }); // pins version 1.0 @ the 1.0 commit

      // Central advances to 1.1; capture that (reachable) commit.
      await writeSkill(path.join(central.dir, 'foo'), { name: 'foo', version: '1.1', body: 'TWO' });
      gitSync(central.dir, ['add', '-A']);
      gitSync(central.dir, ['commit', '-q', '-m', 'v1.1']);
      const c11 = gitSync(central.dir, ['rev-parse', 'HEAD']);

      // Poison the cache: point the pin's commit at the 1.1 commit (reachable but
      // declares 1.1, not the pinned 1.0). Leave version + hashes at 1.0.
      const manifestPath = path.join(proj, '.agents/skills-manifest.json');
      const manifest = await readManifest(manifestPath);
      manifest.skills.foo.commit = c11;
      await fs.writeFile(manifestPath, serializeManifest(manifest), 'utf8');

      // Delete the materialized copies so sync must re-resolve.
      await fs.rm(path.join(proj, '.claude/skills/foo'), { recursive: true, force: true });
      await fs.rm(path.join(proj, '.agents/skills/foo'), { recursive: true, force: true });

      await sync([], { cwd: proj }); // must resolve 1.0 by version, not fail

      const body = await fs.readFile(path.join(proj, '.claude/skills/foo/SKILL.md'), 'utf8');
      assert.match(body, /ONE/);
      assert.doesNotMatch(body, /TWO/);
      // Pin did not advance.
      const after = await readManifest(manifestPath);
      assert.equal(after.skills.foo.version, '1.0');
    });
  } finally {
    await rmrf(root);
  }
});
