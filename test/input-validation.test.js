import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { add } from '../src/commands/add.js';
import { remove } from '../src/commands/remove.js';
import { tmpDir, rmrf } from './helpers.js';

/**
 * Adversarial-review MAJOR: `add foo foo` produced two installs with an identical
 * target, and `add foo --agents claude,claude` wrote a manifest the tool then
 * refused to read. Both are rejected up front, BEFORE any network/clone or lock.
 */
test('add rejects duplicate positional skills before touching anything', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    await assert.rejects(add(['foo', 'foo'], { cwd: proj }), (err) => err.code === 'DUPLICATE_INPUT');
    // No manifest, lock, or staging was created.
    await assert.rejects(fs.stat(path.join(proj, '.agents')));
  } finally {
    await rmrf(root);
  }
});

test('add rejects a duplicate --agents value', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    await assert.rejects(
      add(['foo', '--agents', 'claude,claude'], { cwd: proj }),
      (err) => err.code === 'DUPLICATE_INPUT',
    );
  } finally {
    await rmrf(root);
  }
});

test('remove rejects duplicate positional skills', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    await assert.rejects(remove(['g', 'g'], { cwd: proj }), (err) => err.code === 'DUPLICATE_INPUT');
  } finally {
    await rmrf(root);
  }
});
