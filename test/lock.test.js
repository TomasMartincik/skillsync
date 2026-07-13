import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../src/lock.js';
import { LOCK_DIR } from '../src/constants.js';
import { tmpDir, rmrf } from './helpers.js';

test('a held lock blocks a second acquirer until it times out', async () => {
  const root = await tmpDir();
  try {
    const lock = await acquireLock(root);
    await assert.rejects(acquireLock(root, { timeoutMs: 150 }), (err) => err.code === 'LOCKED');
    await lock.release();
    // Now free again.
    const lock2 = await acquireLock(root, { timeoutMs: 150 });
    await lock2.release();
  } finally {
    await rmrf(root);
  }
});

test('a lock whose recorded pid is dead is reclaimed (never on a briefly-absent pid)', async () => {
  const root = await tmpDir();
  try {
    // Fabricate a stale lock owned by a definitely-dead pid on this host.
    const dir = path.join(root, LOCK_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({ token: 'old', pid: 2147483646, host: os.hostname(), time: Date.now() }),
      'utf8',
    );
    const lock = await acquireLock(root, { timeoutMs: 1000 });
    assert.ok(lock.token && lock.token !== 'old');
    await lock.release();
  } finally {
    await rmrf(root);
  }
});

test('release only removes the lock if the token still matches', async () => {
  const root = await tmpDir();
  try {
    const lock = await acquireLock(root);
    // Simulate another process reclaiming and re-publishing the lock under a new token.
    const metaFile = path.join(root, LOCK_DIR, 'meta.json');
    await fs.writeFile(
      metaFile,
      JSON.stringify({ token: 'someone-else', pid: process.pid, host: os.hostname(), time: Date.now() }),
      'utf8',
    );
    await lock.release(); // must be a no-op: not our token
    assert.ok((await fs.stat(path.join(root, LOCK_DIR))).isDirectory(), 'foreign-owned lock must survive our release');
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    assert.equal(meta.token, 'someone-else');
  } finally {
    await rmrf(root);
  }
});
