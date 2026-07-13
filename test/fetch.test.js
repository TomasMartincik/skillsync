import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  checkoutCommit,
  fullClone,
  resolveVersionToCommit,
  findSkillRel,
  readSkillVersion,
  normalizeVersion,
  compareVersions,
} from '../src/fetch.js';
import { makeCentral, tmpDir, rmrf } from './helpers.js';

test('normalizeVersion / compareVersions', () => {
  assert.equal(normalizeVersion('1.2'), '1.2');
  assert.equal(normalizeVersion('3'), '3.0');
  assert.equal(normalizeVersion('bad'), null);
  assert.ok(compareVersions('1.2', '1.10') < 0);
  assert.ok(compareVersions('2.0', '1.9') > 0);
  assert.equal(compareVersions('1.1', '1.1'), 0);
});

test('checkoutCommit reproduces an exact historical commit', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1', skill: { name: 'g', version: '1.0', body: 'ONE' } },
      { message: 'v1.1', skill: { name: 'g', version: '1.1', body: 'TWO' } },
    ]);
    const [c10] = central.commits;
    const co = await checkoutCommit(central.dir, c10);
    try {
      const v = await readSkillVersion(path.join(co.dir, 'g'));
      assert.equal(v, '1.0');
    } finally {
      await co.cleanup();
    }
  } finally {
    await rmrf(root);
  }
});

test('resolveVersionToCommit maps version -> commit via first-parent history', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1', skill: { name: 'g', version: '1.0', body: 'ONE' } },
      { message: 'v1.1', skill: { name: 'g', version: '1.1', body: 'TWO' } },
      { message: 'v1.2', skill: { name: 'g', version: '1.2', body: 'THREE' } },
    ]);
    const [c10, c11, c12] = central.commits;
    const clone = await fullClone(central.dir);
    try {
      assert.equal(await resolveVersionToCommit(clone.dir, 'g', '1.0'), c10);
      assert.equal(await resolveVersionToCommit(clone.dir, 'g', '1.1'), c11);
      assert.equal(await resolveVersionToCommit(clone.dir, 'g', '1.2'), c12);
      await assert.rejects(resolveVersionToCommit(clone.dir, 'g', '9.9'), /UNRESOLVABLE_PIN|no commit/);
    } finally {
      await clone.cleanup();
    }
  } finally {
    await rmrf(root);
  }
});

test('resolveVersionToCommit rejects a regressed (non-monotonic) history', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1.1', skill: { name: 'g', version: '1.1', body: 'A' } },
      { message: 'regress to 1.0', skill: { name: 'g', version: '1.0', body: 'B' } },
    ]);
    const clone = await fullClone(central.dir);
    try {
      await assert.rejects(resolveVersionToCommit(clone.dir, 'g', '1.0'), /VERSION_REGRESSION|monotonic/);
    } finally {
      await clone.cleanup();
    }
  } finally {
    await rmrf(root);
  }
});

test('findSkillRel finds nested skills and errors on missing', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1', skill: { name: 'g', version: '1.0' } },
    ]);
    const clone = await fullClone(central.dir);
    try {
      assert.equal(await findSkillRel(clone.dir, 'g'), 'g');
      await assert.rejects(findSkillRel(clone.dir, 'nope'), /SKILL_NOT_FOUND|not found/);
    } finally {
      await clone.cleanup();
    }
  } finally {
    await rmrf(root);
  }
});
