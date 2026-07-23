import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runTransaction } from '../src/materialize.js';
import { scanSkillTree } from '../src/input-policy.js';
import { writeSkill, tmpDir, rmrf } from './helpers.js';

const H = 'sha256:' + 'a'.repeat(64);

/** Build a plan that materializes one skill to both agents. */
async function onePlan(skillSrc, opts = {}) {
  const files = await scanSkillTree(skillSrc);
  const manifest = {
    version: 1,
    source: 'git@x:y.git',
    mode: 'plain',
    skills: { g: { version: '1.0', commit: 'abc1234', sourceHash: H, outputs: { claude: H, codex: H } } },
  };
  return {
    manifest,
    targets: [
      { target: '.claude/skills/g', files },
      { target: '.agents/skills/g', files },
    ],
    removeDirs: [],
    excludeEntries: null,
    ...opts,
  };
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

test('runTransaction materializes targets, writes manifest last, cleans up staging', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', files: { 'r/n.md': 'hi' } });

    await runTransaction(proj, await onePlan(src));

    assert.ok((await fs.stat(path.join(proj, '.claude/skills/g/SKILL.md'))).isFile());
    assert.ok((await fs.stat(path.join(proj, '.agents/skills/g/r/n.md'))).isFile());
    const manifest = await fs.readFile(path.join(proj, '.agents/skills-manifest.json'), 'utf8');
    assert.match(manifest, /"g"/);

    // No staging residue.
    const agentsEntries = await fs.readdir(path.join(proj, '.agents'));
    assert.ok(!agentsEntries.some((e) => e.includes('stage')));
  } finally {
    await rmrf(root);
  }
});

test('the manifest is written LAST — a crash before it leaves the OLD (absent) manifest', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });

    // Throw exactly at the manifest phase: dirs are installed, manifest not yet.
    await assert.rejects(
      runTransaction(proj, await onePlan(src), (phase) => {
        if (phase === 'manifest') throw new Error('crash before manifest');
      }),
      /crash before manifest/,
    );
    assert.ok((await fs.stat(path.join(proj, '.claude/skills/g/SKILL.md'))).isFile());
    await assert.rejects(fs.stat(path.join(proj, '.agents/skills-manifest.json')), 'manifest not written yet');

    // Re-running the same operation converges and writes the manifest.
    await runTransaction(proj, await onePlan(src));
    assert.ok((await fs.stat(path.join(proj, '.agents/skills-manifest.json'))).isFile());
  } finally {
    await rmrf(root);
  }
});

test('the install replaces a COMPLETE tree via a single rename (atomic visibility)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    // Pre-existing target with old content that must vanish atomically.
    await fs.mkdir(path.join(proj, '.claude/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.claude/skills/g/OLD.md'), 'old');

    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', files: { 'r/n.md': 'nested', 'b.md': 'bee' } });
    const target = path.join(proj, '.claude/skills/g');

    let absentBeforeRename = false;
    let completeAtRename = false;
    await runTransaction(proj, await onePlan(src), async (phase) => {
      if (phase === 'swap.0.pre-rename') {
        // The old dir has been removed; the target is momentarily absent — it is
        // NEVER observed as a partially-populated mix of old and new.
        absentBeforeRename = !(await pathExists(target));
      }
      if (phase === 'swap.0.post-rename') {
        const hasAll =
          (await pathExists(path.join(target, 'SKILL.md'))) &&
          (await pathExists(path.join(target, 'b.md'))) &&
          (await pathExists(path.join(target, 'r/n.md')));
        const oldGone = !(await pathExists(path.join(target, 'OLD.md')));
        completeAtRename = hasAll && oldGone;
      }
    });

    assert.ok(absentBeforeRename, 'target must be absent (not partial) before the rename');
    assert.ok(completeAtRename, 'the whole new tree must appear in one atomic rename');
    await assert.rejects(fs.stat(path.join(target, 'OLD.md')));
  } finally {
    await rmrf(root);
  }
});

test('install replaces an existing dir (old content gone)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.claude/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.claude/skills/g/OLD.md'), 'old');
    await fs.mkdir(path.join(proj, '.agents/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.agents/skills/g/OLD.md'), 'old');

    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });
    await runTransaction(proj, await onePlan(src));

    await assert.rejects(fs.stat(path.join(proj, '.claude/skills/g/OLD.md'))); // replaced
    assert.ok((await fs.stat(path.join(proj, '.claude/skills/g/SKILL.md'))).isFile());
  } finally {
    await rmrf(root);
  }
});

test('a symlinked target ancestor is refused (no escape out of the project)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(proj, '.claude'));

    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', body: 'NEW' });

    await assert.rejects(runTransaction(proj, await onePlan(src)), (err) => err.code === 'UNSAFE_ANCESTOR');
    await assert.rejects(fs.stat(path.join(outside, 'skills/g/SKILL.md')), 'nothing written through the symlink');
  } finally {
    await rmrf(root);
  }
});
