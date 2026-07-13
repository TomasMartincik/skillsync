import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { init } from '../src/commands/init.js';
import { add } from '../src/commands/add.js';
import { remove } from '../src/commands/remove.js';
import { sync } from '../src/commands/sync.js';
import { readManifest } from '../src/manifest.js';
import { makeCentral, writeSkill, gitSync, tmpDir, rmrf } from './helpers.js';

/** Run a body with a throwaway XDG_CONFIG_HOME so the real config is untouched. */
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

test('sync is version-exact: central advances but sync reproduces the pinned version', async () => {
  const root = await tmpDir();
  try {
    await withIsolatedConfig(root, async () => {
      // Central starts at 1.0.
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });

      await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });
      await add(['g'], { cwd: proj });

      let manifest = await readManifest(path.join(proj, '.agents/skills-manifest.json'));
      assert.equal(manifest.skills.g.version, '1.0');

      // Central ADVANCES to 1.1.
      await writeSkill(path.join(central.dir, 'g'), { name: 'g', version: '1.1', body: 'TWO' });
      gitSync(central.dir, ['add', '-A']);
      gitSync(central.dir, ['commit', '-q', '-m', 'v1.1']);

      // Delete the materialized copies, then sync: must restore 1.0, NOT 1.1.
      await fs.rm(path.join(proj, '.claude/skills/g'), { recursive: true, force: true });
      await fs.rm(path.join(proj, '.agents/skills/g'), { recursive: true, force: true });
      await sync([], { cwd: proj });

      const body = await fs.readFile(path.join(proj, '.claude/skills/g/SKILL.md'), 'utf8');
      assert.match(body, /ONE/);
      assert.doesNotMatch(body, /TWO/);

      // Pin did not advance.
      manifest = await readManifest(path.join(proj, '.agents/skills-manifest.json'));
      assert.equal(manifest.skills.g.version, '1.0');
    });
  } finally {
    await rmrf(root);
  }
});

test('sync skips a drifted copy unless --force', async () => {
  const root = await tmpDir();
  try {
    await withIsolatedConfig(root, async () => {
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });
      await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });
      await add(['g'], { cwd: proj });

      // Tamper (drift) the materialized claude copy.
      const claudeSkill = path.join(proj, '.claude/skills/g/SKILL.md');
      await fs.writeFile(claudeSkill, 'TAMPERED');

      await sync([], { cwd: proj }); // should skip, leaving the tamper in place
      assert.equal(await fs.readFile(claudeSkill, 'utf8'), 'TAMPERED');

      await sync(['--force'], { cwd: proj }); // force overwrites
      assert.match(await fs.readFile(claudeSkill, 'utf8'), /ONE/);
    });
  } finally {
    await rmrf(root);
  }
});

test('add then remove deletes the materialized copies and the pin', async () => {
  const root = await tmpDir();
  try {
    await withIsolatedConfig(root, async () => {
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'v1.0', skill: { name: 'g', version: '1.0' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });
      await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });
      await add(['g'], { cwd: proj });
      assert.ok((await fs.stat(path.join(proj, '.claude/skills/g'))).isDirectory());

      await remove(['g'], { cwd: proj });
      await assert.rejects(fs.stat(path.join(proj, '.claude/skills/g')));
      await assert.rejects(fs.stat(path.join(proj, '.agents/skills/g')));
      const manifest = await readManifest(path.join(proj, '.agents/skills-manifest.json'));
      assert.deepEqual(manifest.skills, {});
    });
  } finally {
    await rmrf(root);
  }
});

test('gitignored mode writes .git/info/exclude entries', async () => {
  const root = await tmpDir();
  try {
    await withIsolatedConfig(root, async () => {
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'v1.0', skill: { name: 'g', version: '1.0' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });
      gitSync(proj, ['init', '-q', '-b', 'main']);
      await init(['--source', central.dir, '--mode', 'gitignored'], { cwd: proj });
      await add(['g'], { cwd: proj });
      const exclude = await fs.readFile(path.join(proj, '.git/info/exclude'), 'utf8');
      assert.match(exclude, /skillsync managed/);
      assert.match(exclude, /\.agents\/skills-manifest\.json/);
      assert.match(exclude, /\.claude\/skills\/g/);
      assert.match(exclude, /\.agents\/skills\/g/);
    });
  } finally {
    await rmrf(root);
  }
});
