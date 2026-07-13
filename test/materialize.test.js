import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTransaction, recover } from '../src/materialize.js';
import { scanSkillTree } from '../src/input-policy.js';
import { serializeManifest } from '../src/manifest.js';
import { TXN_FILE } from '../src/constants.js';
import { writeSkill, tmpDir, rmrf } from './helpers.js';

// Isolate the machine secret (used to MAC journals) into a throwaway dir so these
// direct-transaction tests never touch the real ~/.config/skillsync.
process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), `skillsync-secret-materialize-${process.pid}`);

const H = 'sha256:' + 'a'.repeat(64);

/** Build a plan that materializes one skill to both agents. */
async function onePlan(root, skillSrc, opts = {}) {
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

test('runTransaction materializes targets, writes manifest last, cleans up', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', files: { 'r/n.md': 'hi' } });

    await runTransaction(proj, await onePlan(root, src));

    assert.ok((await fs.stat(path.join(proj, '.claude/skills/g/SKILL.md'))).isFile());
    assert.ok((await fs.stat(path.join(proj, '.agents/skills/g/r/n.md'))).isFile());
    const manifest = await fs.readFile(path.join(proj, '.agents/skills-manifest.json'), 'utf8');
    assert.match(manifest, /"g"/);

    // No transaction/staging/backup residue.
    await assert.rejects(fs.stat(path.join(proj, TXN_FILE)));
    const agentsEntries = await fs.readdir(path.join(proj, '.agents'));
    assert.ok(!agentsEntries.some((e) => e.includes('stage') || e.includes('backup')));
  } finally {
    await rmrf(root);
  }
});

test('recovery rolls forward a crash after journaling but before apply', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });

    // Crash exactly when apply begins: journal + staging exist, nothing swapped.
    await assert.rejects(
      runTransaction(proj, await onePlan(root, src), (phase) => {
        if (phase === 'apply') throw new Error('simulated crash');
      }),
      /simulated crash/,
    );
    // Journal present, targets NOT yet materialized.
    assert.ok((await fs.stat(path.join(proj, TXN_FILE))).isFile());
    await assert.rejects(fs.stat(path.join(proj, '.claude/skills/g/SKILL.md')));

    // Recover -> roll forward to the complete state.
    const did = await recover(proj);
    assert.equal(did, true);
    assert.ok((await fs.stat(path.join(proj, '.claude/skills/g/SKILL.md'))).isFile());
    assert.ok((await fs.stat(path.join(proj, '.agents/skills/g/SKILL.md'))).isFile());
    assert.ok((await fs.stat(path.join(proj, '.agents/skills-manifest.json'))).isFile());
    await assert.rejects(fs.stat(path.join(proj, TXN_FILE))); // journal removed
  } finally {
    await rmrf(root);
  }
});

test('recovery completes a crash between dir swaps and manifest write', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });

    await assert.rejects(
      runTransaction(proj, await onePlan(root, src), (phase) => {
        if (phase === 'manifest') throw new Error('crash before manifest');
      }),
      /crash before manifest/,
    );
    // Dirs swapped in, but manifest not yet written.
    assert.ok((await fs.stat(path.join(proj, '.claude/skills/g/SKILL.md'))).isFile());
    await assert.rejects(fs.stat(path.join(proj, '.agents/skills-manifest.json')));

    await recover(proj);
    assert.ok((await fs.stat(path.join(proj, '.agents/skills-manifest.json'))).isFile());
    await assert.rejects(fs.stat(path.join(proj, TXN_FILE)));
  } finally {
    await rmrf(root);
  }
});

test('the swap installs a COMPLETE tree via a single rename (atomic visibility)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    // Pre-existing target with old content that must vanish atomically.
    await fs.mkdir(path.join(proj, '.claude/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.claude/skills/g/OLD.md'), 'old');

    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', files: { 'r/n.md': 'nested', 'b.md': 'bee' } });
    const target = path.join(proj, '.claude/skills/g');

    let absentDuringBackup = false;
    let completeAtRename = false;
    await runTransaction(proj, await onePlan(root, src), async (phase) => {
      if (phase === 'swap.0.post-backup') {
        // The old dir has been moved aside; the target is momentarily absent —
        // it is NEVER observed as a partially-populated mix of old and new.
        absentDuringBackup = !(await pathExists(target));
      }
      if (phase === 'swap.0.post-rename') {
        // After the single staged->target rename the WHOLE new tree is present at
        // once (no partially-copied intermediate), and the old file is gone.
        const hasAll =
          (await pathExists(path.join(target, 'SKILL.md'))) &&
          (await pathExists(path.join(target, 'b.md'))) &&
          (await pathExists(path.join(target, 'r/n.md')));
        const oldGone = !(await pathExists(path.join(target, 'OLD.md')));
        completeAtRename = hasAll && oldGone;
      }
    });

    assert.ok(absentDuringBackup, 'target must be absent (not partial) between backup and rename');
    assert.ok(completeAtRename, 'the whole new tree must appear in one atomic rename');
    await assert.rejects(fs.stat(path.join(target, 'OLD.md')));
  } finally {
    await rmrf(root);
  }
});

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

test('atomic swap replaces an existing dir (old content gone)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.claude/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.claude/skills/g/OLD.md'), 'old');
    await fs.mkdir(path.join(proj, '.agents/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.agents/skills/g/OLD.md'), 'old');

    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });
    await runTransaction(proj, await onePlan(root, src));

    await assert.rejects(fs.stat(path.join(proj, '.claude/skills/g/OLD.md'))); // replaced
    assert.ok((await fs.stat(path.join(proj, '.claude/skills/g/SKILL.md'))).isFile());
  } finally {
    await rmrf(root);
  }
});
