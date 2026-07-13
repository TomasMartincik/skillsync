import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanSkillTree, detectFoldCollisions } from '../src/input-policy.js';
import { MAX_FILE_BYTES } from '../src/constants.js';
import { tmpDir, rmrf } from './helpers.js';

test('rejects symlinks anywhere in the tree', async () => {
  const d = await tmpDir();
  try {
    const dir = path.join(d, 's');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');
    await fs.symlink('/etc/passwd', path.join(dir, 'link'));
    await assert.rejects(scanSkillTree(dir), /SYMLINK_REJECTED|symlink/);
  } finally {
    await rmrf(d);
  }
});

test('rejects non-regular files (FIFO)', async () => {
  const d = await tmpDir();
  try {
    const dir = path.join(d, 's');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');
    // Make a FIFO via mkfifo if available; otherwise skip gracefully.
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    } catch {
      return; // platform without mkfifo; symlink test already covers non-regular policy
    }
    await assert.rejects(scanSkillTree(dir), /NON_REGULAR_REJECTED|non-regular/);
  } finally {
    await rmrf(d);
  }
});

test('detects case/Unicode-fold path collisions', () => {
  assert.throws(
    () =>
      detectFoldCollisions([
        { rel: 'Assets/X', abs: '', size: 0, exec: false },
        { rel: 'assets/x', abs: '', size: 0, exec: false },
      ]),
    /FOLD_COLLISION|collision/,
  );
  // no collision for genuinely distinct paths
  assert.doesNotThrow(() =>
    detectFoldCollisions([
      { rel: 'a.md', abs: '', size: 0, exec: false },
      { rel: 'b.md', abs: '', size: 0, exec: false },
    ]),
  );
});

test('detects a file-vs-directory fold collision (A vs a/x)', () => {
  assert.throws(
    () =>
      detectFoldCollisions([
        { rel: 'A', abs: '', size: 0, exec: false },
        { rel: 'a/x', abs: '', size: 0, exec: false },
      ]),
    /FOLD_COLLISION|collision|directory/,
  );
});

test('detects a folded DIRECTORY alias (Assets/x vs assets/y)', () => {
  assert.throws(
    () =>
      detectFoldCollisions([
        { rel: 'Assets/x', abs: '', size: 0, exec: false },
        { rel: 'assets/y', abs: '', size: 0, exec: false },
      ]),
    /FOLD_COLLISION|collision/,
  );
});

test('enforces per-file size limit', async () => {
  const d = await tmpDir();
  try {
    const dir = path.join(d, 's');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');
    await fs.writeFile(path.join(dir, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
    await assert.rejects(scanSkillTree(dir), /FILE_TOO_LARGE|exceeds/);
  } finally {
    await rmrf(d);
  }
});

test('returns files sorted by POSIX relpath', async () => {
  const d = await tmpDir();
  try {
    const dir = path.join(d, 's');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'z.md'), '1');
    await fs.writeFile(path.join(dir, 'a.md'), '1');
    await fs.writeFile(path.join(dir, 'sub', 'm.md'), '1');
    const files = await scanSkillTree(dir);
    assert.deepEqual(files.map((f) => f.rel), ['a.md', 'sub/m.md', 'z.md']);
  } finally {
    await rmrf(d);
  }
});
