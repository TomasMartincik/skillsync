import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTransaction, recover } from '../src/materialize.js';
import { scanSkillTree } from '../src/input-policy.js';
import { TXN_FILE } from '../src/constants.js';
import { writeSkill, tmpDir, rmrf } from './helpers.js';
import { getSecret, journalMac } from '../src/secret.js';

// Isolate the machine secret into a throwaway dir (these tests craft and recover
// journals directly and must not touch the real ~/.config/skillsync).
process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), `skillsync-secret-recovery-${process.pid}`);

const H = 'sha256:' + 'a'.repeat(64);

/** Sign a journal with this machine's (isolated) secret so it authenticates. */
async function sign(journal) {
  const secret = await getSecret();
  return { ...journal, mac: journalMac(secret, journal) };
}

async function onePlan(skillSrc) {
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
  };
}

test('a corrupt journal is refused (fail closed) and PRESERVED, not swept', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.agents'), { recursive: true });
    const journalPath = path.join(proj, TXN_FILE);
    await fs.writeFile(journalPath, '{ this is not valid json ', 'utf8');
    // A stage dir that must NOT be swept while a journal is present.
    const stage = path.join(proj, '.agents', '.skillsync-stage-x');
    await fs.mkdir(stage, { recursive: true });

    await assert.rejects(recover(proj), (err) => err.code === 'JOURNAL_INVALID');
    assert.ok((await fs.stat(journalPath)).isFile(), 'journal must be preserved');
    assert.ok((await fs.stat(stage)).isDirectory(), 'staging must be preserved alongside a journal');
  } finally {
    await rmrf(root);
  }
});

test('a malicious journal (path escape) is refused and writes nothing outside the project', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.agents'), { recursive: true });
    const evil = path.join(root, 'pwned.json'); // OUTSIDE the project
    const journal = {
      schema: 2,
      txnId: 'x',
      host: os.hostname(),
      project: path.resolve(proj),
      stageRel: '.agents/.skillsync-stage-x',
      backupRel: '.agents/.skillsync-backup-x',
      manifest: 'PWNED',
      manifestPath: '../pwned.json', // escapes the project
      swaps: [],
      removals: [],
      excludeEntries: null,
    };
    await fs.writeFile(path.join(proj, TXN_FILE), JSON.stringify(journal), 'utf8');

    await assert.rejects(recover(proj), (err) => err.code === 'JOURNAL_INVALID');
    await assert.rejects(fs.stat(evil), 'must not write outside the project');
    assert.ok((await fs.stat(path.join(proj, TXN_FILE))).isFile(), 'journal preserved');
  } finally {
    await rmrf(root);
  }
});

test('a malicious target root outside the skills dirs is refused', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.agents'), { recursive: true });
    const journal = {
      schema: 2,
      txnId: 'x',
      host: os.hostname(),
      project: path.resolve(proj),
      stageRel: '.agents/.skillsync-stage-x',
      backupRel: '.agents/.skillsync-backup-x',
      manifest: '{}',
      manifestPath: '.agents/skills-manifest.json',
      swaps: [{ stagedRel: '.agents/.skillsync-stage-x/t0', targetRel: '.ssh/authorized_keys', backupRel: '.agents/.skillsync-backup-x/b0' }],
      removals: [],
      excludeEntries: null,
    };
    await fs.writeFile(path.join(proj, TXN_FILE), JSON.stringify(journal), 'utf8');
    await assert.rejects(recover(proj), (err) => err.code === 'JOURNAL_INVALID');
  } finally {
    await rmrf(root);
  }
});

test('a journal authored on another host is refused (foreign)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.agents'), { recursive: true });
    const journal = {
      schema: 2,
      txnId: 'x',
      host: `${os.hostname()}-not-this-machine`,
      project: path.resolve(proj),
      stageRel: '.agents/.skillsync-stage-x',
      backupRel: '.agents/.skillsync-backup-x',
      manifest: '{}',
      manifestPath: '.agents/skills-manifest.json',
      swaps: [],
      removals: [],
      excludeEntries: null,
    };
    await fs.writeFile(path.join(proj, TXN_FILE), JSON.stringify(journal), 'utf8');
    await assert.rejects(recover(proj), (err) => err.code === 'JOURNAL_INVALID');
    assert.ok((await fs.stat(path.join(proj, TXN_FILE))).isFile(), 'foreign journal preserved, not executed');
  } finally {
    await rmrf(root);
  }
});

test('a symlinked target ancestor is rejected before any swap (no escape)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    // .claude is a symlink pointing outside the project.
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(proj, '.claude'));

    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', body: 'NEW' });
    const plan = await onePlan(src);

    await assert.rejects(runTransaction(proj, plan), (err) => err.code === 'UNSAFE_ANCESTOR' || err.code === 'CROSS_DEVICE');
    // Nothing was written through the symlink.
    await assert.rejects(fs.stat(path.join(outside, 'skills/g/SKILL.md')));
    await assert.rejects(fs.stat(path.join(proj, TXN_FILE)));
  } finally {
    await rmrf(root);
  }
});

test('recovery completes idempotently after a crash AFTER the manifest rename', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', body: 'NEW' });
    const plan = await onePlan(src);

    // Crash right after the manifest is renamed into place but before cleanup:
    // swaps are applied, staging is gone, manifest exists, journal still present.
    await assert.rejects(
      runTransaction(proj, plan, (phase) => {
        if (phase === 'post-manifest') throw new Error('crash after manifest');
      }),
      /crash after manifest/,
    );
    assert.ok((await fs.stat(path.join(proj, '.agents/skills-manifest.json'))).isFile());
    assert.ok((await fs.stat(path.join(proj, TXN_FILE))).isFile(), 'journal still present');

    // Recovery must complete: with staging absent it proves each swap by the LIVE
    // target hash (never assuming "staging gone" == applied), rewrites the manifest
    // idempotently, and clears all residue.
    assert.equal(await recover(proj), true);
    await assert.rejects(fs.stat(path.join(proj, TXN_FILE)));
    const agentsEntries = await fs.readdir(path.join(proj, '.agents'));
    assert.ok(!agentsEntries.some((e) => e.includes('stage') || e.includes('backup')));
    assert.match(await fs.readFile(path.join(proj, '.claude/skills/g/SKILL.md'), 'utf8'), /NEW/);
  } finally {
    await rmrf(root);
  }
});

test('a spoofed journal (valid structure, wrong MAC) is refused and preserved', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.agents'), { recursive: true });
    const journal = {
      schema: 3,
      txnId: 'x',
      host: os.hostname(),
      project: path.resolve(proj),
      stageRel: '.agents/.skillsync-stage-x',
      backupRel: '.agents/.skillsync-backup-x',
      manifest: 'PWNED',
      manifestPath: '.agents/skills-manifest.json',
      swaps: [],
      removals: [],
      excludeEntries: null,
      mac: 'deadbeef'.repeat(8), // a plausible-looking but WRONG mac
    };
    await fs.writeFile(path.join(proj, TXN_FILE), JSON.stringify(journal), 'utf8');
    await assert.rejects(recover(proj), (err) => err.code === 'JOURNAL_INVALID');
    assert.ok((await fs.stat(path.join(proj, TXN_FILE))).isFile(), 'spoofed journal preserved, not executed');
    // The forged manifest content must never have been written.
    await assert.rejects(fs.stat(path.join(proj, '.agents/skills-manifest.json')));
  } finally {
    await rmrf(root);
  }
});

test('a correctly-MAC-d journal that still escapes confinement is refused', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.agents'), { recursive: true });
    // Authenticate with the real machine secret, but point a target outside the
    // allowed skills roots — authentication must not bypass confinement.
    const journal = await sign({
      schema: 3,
      txnId: 'x',
      host: os.hostname(),
      project: path.resolve(proj),
      stageRel: '.agents/.skillsync-stage-x',
      backupRel: '.agents/.skillsync-backup-x',
      manifest: '{}',
      manifestPath: '.agents/skills-manifest.json',
      swaps: [
        {
          stagedRel: '.agents/.skillsync-stage-x/t0',
          targetRel: '.ssh/authorized_keys',
          backupRel: '.agents/.skillsync-backup-x/b0',
          stagedHash: H,
        },
      ],
      removals: [],
      excludeEntries: null,
    });
    await fs.writeFile(path.join(proj, TXN_FILE), JSON.stringify(journal), 'utf8');
    await assert.rejects(recover(proj), (err) => err.code === 'JOURNAL_INVALID');
  } finally {
    await rmrf(root);
  }
});

test('a symlinked .agents is refused before recovery/sweep (no escape, nothing deleted)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    // .agents is a symlink to an outside dir that must NOT be swept/followed.
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, '.skillsync-stage-victim'), 'precious');
    await fs.symlink(outside, path.join(proj, '.agents'));

    await assert.rejects(recover(proj), (err) => err.code === 'UNSAFE_ANCESTOR');
    // The outside directory and its contents survive untouched.
    assert.equal(await fs.readFile(path.join(outside, '.skillsync-stage-victim'), 'utf8'), 'precious');
  } finally {
    await rmrf(root);
  }
});

test('staged tampering after journaling is detected during recovery (evidence preserved)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', body: 'NEW' });
    const plan = await onePlan(src);

    // Crash after journaling but before apply: staging + journal exist, no swap yet.
    await assert.rejects(
      runTransaction(proj, plan, (phase) => {
        if (phase === 'apply') throw new Error('crash before apply');
      }),
      /crash before apply/,
    );

    // Tamper with a staged file. Recovery must NOT install the modified bytes; it
    // revalidates the staged tree against the journaled hash and fails closed.
    const stageEntries = (await fs.readdir(path.join(proj, '.agents'))).filter((e) => e.includes('stage'));
    assert.equal(stageEntries.length, 1);
    const stagedFile = path.join(proj, '.agents', stageEntries[0], 't0', 'SKILL.md');
    await fs.writeFile(stagedFile, 'TAMPERED-BYTES');

    await assert.rejects(recover(proj), (err) => err.code === 'JOURNAL_APPLY_FAILED');
    // Nothing installed; journal + staging preserved for repair.
    await assert.rejects(fs.stat(path.join(proj, '.claude/skills/g/SKILL.md')));
    assert.ok((await fs.stat(path.join(proj, TXN_FILE))).isFile(), 'journal preserved after tamper detection');
    assert.ok((await fs.stat(stagedFile)).isFile(), 'staging preserved as evidence');
  } finally {
    await rmrf(root);
  }
});

test('recovery completes a crash BETWEEN target->backup and staged->target (mid-swap)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    // Pre-existing live copies so a backup step actually runs.
    await fs.mkdir(path.join(proj, '.claude/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.claude/skills/g/OLD.md'), 'old');
    await fs.mkdir(path.join(proj, '.agents/skills/g'), { recursive: true });
    await fs.writeFile(path.join(proj, '.agents/skills/g/OLD.md'), 'old');

    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0', body: 'NEW' });
    const plan = await onePlan(src);

    // Crash after the first target is moved aside to backup but before its staged
    // replacement is renamed into place.
    await assert.rejects(
      runTransaction(proj, plan, (phase) => {
        if (phase === 'swap.0.post-backup') throw new Error('crash mid-swap');
      }),
      /crash mid-swap/,
    );
    assert.ok((await fs.stat(path.join(proj, TXN_FILE))).isFile(), 'journal present after mid-swap crash');

    const did = await recover(proj);
    assert.equal(did, true);
    // Both targets rolled forward to NEW content; OLD gone; manifest written.
    assert.match(await fs.readFile(path.join(proj, '.claude/skills/g/SKILL.md'), 'utf8'), /NEW/);
    await assert.rejects(fs.stat(path.join(proj, '.claude/skills/g/OLD.md')));
    assert.match(await fs.readFile(path.join(proj, '.agents/skills/g/SKILL.md'), 'utf8'), /NEW/);
    assert.ok((await fs.stat(path.join(proj, '.agents/skills-manifest.json'))).isFile());
    // No residue.
    await assert.rejects(fs.stat(path.join(proj, TXN_FILE)));
    const agentsEntries = await fs.readdir(path.join(proj, '.agents'));
    assert.ok(!agentsEntries.some((e) => e.includes('stage') || e.includes('backup')));
  } finally {
    await rmrf(root);
  }
});
