import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  emptyManifest,
  validateManifest,
  serializeManifest,
  readManifest,
  pinAgents,
} from '../src/manifest.js';
import { tmpDir, rmrf } from './helpers.js';

const H = 'sha256:' + 'a'.repeat(64);

function sampleManifest() {
  return {
    version: 1,
    source: 'git@github.com:o/r.git',
    mode: 'committed',
    skills: {
      zeta: { version: '1.0', commit: '9f3ab12', sourceHash: H, outputs: { claude: H, codex: H } },
      alpha: { version: '2.1', commit: 'abcdef0', sourceHash: H, outputs: { codex: H }, agents: ['codex'] },
    },
  };
}

test('round-trip: serialize -> validate is stable and sorts skills', () => {
  const m = sampleManifest();
  const str = serializeManifest(m);
  // deterministic key order: skills sorted alpha
  assert.ok(str.indexOf('"alpha"') < str.indexOf('"zeta"'));
  assert.ok(str.endsWith('\n'));
  const back = validateManifest(JSON.parse(str));
  assert.equal(serializeManifest(back), str); // idempotent
});

test('pinAgents respects the optional filter', () => {
  const m = sampleManifest();
  assert.deepEqual(pinAgents(m.skills.zeta), ['claude', 'codex']);
  assert.deepEqual(pinAgents(m.skills.alpha), ['codex']);
});

test('validation rejects bad version/commit/hash/mode', () => {
  assert.throws(() => validateManifest({ version: 2, source: 'x', mode: 'committed', skills: {} }), /manifest version/);
  assert.throws(() => validateManifest({ version: 1, source: '', mode: 'committed', skills: {} }), /source/);
  assert.throws(() => validateManifest({ version: 1, source: 'x', mode: 'nope', skills: {} }), /mode/);
  const bad = sampleManifest();
  bad.skills.zeta.version = 'v1';
  assert.throws(() => validateManifest(bad), /invalid version/);
  const bad2 = sampleManifest();
  bad2.skills.zeta.outputs.claude = 'notahash';
  assert.throws(() => validateManifest(bad2), /sha256/);
  const bad3 = sampleManifest();
  bad3.skills.zeta.outputs.mystery = H;
  assert.throws(() => validateManifest(bad3), /unknown agent/);
});

test('emptyManifest + read from disk', async () => {
  const dir = await tmpDir();
  try {
    const m = emptyManifest({ source: 'git@x:y.git', mode: 'plain' });
    const p = path.join(dir, 'm.json');
    await fs.writeFile(p, serializeManifest(m));
    const read = await readManifest(p);
    assert.equal(read.source, 'git@x:y.git');
    assert.equal(read.mode, 'plain');
    assert.deepEqual(read.skills, {});
  } finally {
    await rmrf(dir);
  }
});

test('readManifest throws NO_MANIFEST when absent', async () => {
  await assert.rejects(readManifest('/no/such/manifest.json'), /NO_MANIFEST|no manifest/);
});
