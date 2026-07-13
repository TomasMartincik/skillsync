import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hashSkillTree } from '../src/hash.js';
import { writeSkill, tmpDir, rmrf } from './helpers.js';

test('hash is deterministic and independent of file creation order', async () => {
  const a = await tmpDir();
  const b = await tmpDir();
  try {
    // Same content, different write order.
    await fs.mkdir(path.join(a, 's'), { recursive: true });
    await fs.writeFile(path.join(a, 's', 'SKILL.md'), 'x');
    await fs.writeFile(path.join(a, 's', 'b.txt'), 'bb');
    await fs.writeFile(path.join(a, 's', 'a.txt'), 'aa');

    await fs.mkdir(path.join(b, 's'), { recursive: true });
    await fs.writeFile(path.join(b, 's', 'a.txt'), 'aa');
    await fs.writeFile(path.join(b, 's', 'SKILL.md'), 'x');
    await fs.writeFile(path.join(b, 's', 'b.txt'), 'bb');

    const ha = await hashSkillTree(path.join(a, 's'));
    const hb = await hashSkillTree(path.join(b, 's'));
    assert.equal(ha, hb);
    assert.match(ha, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await rmrf(a);
    await rmrf(b);
  }
});

test('content change changes the hash', async () => {
  const d = await tmpDir();
  try {
    await writeSkill(path.join(d, 's'), { name: 's', version: '1.0', body: 'one' });
    const h1 = await hashSkillTree(path.join(d, 's'));
    await writeSkill(path.join(d, 's'), { name: 's', version: '1.0', body: 'two' });
    const h2 = await hashSkillTree(path.join(d, 's'));
    assert.notEqual(h1, h2);
  } finally {
    await rmrf(d);
  }
});

test('the executable bit (mode-class) is part of the hash', async () => {
  const d = await tmpDir();
  try {
    const dir = path.join(d, 's');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'run.sh'), '#!/bin/sh\n');
    await fs.chmod(path.join(dir, 'run.sh'), 0o644);
    const nonExec = await hashSkillTree(dir);
    await fs.chmod(path.join(dir, 'run.sh'), 0o755);
    const exec = await hashSkillTree(dir);
    assert.notEqual(nonExec, exec);
  } finally {
    await rmrf(d);
  }
});

test('nested paths contribute to the hash', async () => {
  const d = await tmpDir();
  try {
    await writeSkill(path.join(d, 's'), {
      name: 's',
      version: '1.0',
      files: { 'refs/a.md': 'hello' },
    });
    const h1 = await hashSkillTree(path.join(d, 's'));
    await writeSkill(path.join(d, 's2'), {
      name: 's',
      version: '1.0',
      files: { 'refs/b.md': 'hello' },
    });
    const h2 = await hashSkillTree(path.join(d, 's2'));
    assert.notEqual(h1, h2); // path differs -> hash differs
  } finally {
    await rmrf(d);
  }
});
