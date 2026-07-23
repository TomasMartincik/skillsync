/**
 * Round-3 review regressions that survive the materialization simplification — one
 * focused test per reviewed trace. Each reproduces the exact scenario the reviewer
 * described and asserts the behavior AFTER the fix. Traces:
 *   - publication boundaries         (src/fetch.js)
 *   - live-ancestor fsync            (src/materialize.js)
 *   - unsupported-fsync diagnostics  (src/durable.js)
 *   - PID-reuse self-collision       (src/lock.js)
 *   - invalid YAML escapes           (src/frontmatter.js)
 *
 * (The journal/HMAC/backup traces were retired with issue #22: crash-safety is now
 * idempotent re-run, covered by test/idempotency.test.js.)
 * @module test/round3
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTransaction } from '../src/materialize.js';
import { scanSkillTree } from '../src/input-policy.js';
import { acquireLock, procStartTime } from '../src/lock.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { fullClone, validatePublication } from '../src/fetch.js';
import { LOCK_DIR } from '../src/constants.js';
import { makeCentral, writeSkill, gitSync, tmpDir, rmrf } from './helpers.js';

const H = 'sha256:' + 'a'.repeat(64);

/** Plan that materializes one skill to `.claude/skills/g` only. */
async function claudePlan(skillSrc) {
  const files = await scanSkillTree(skillSrc);
  return {
    manifest: {
      version: 1,
      source: 'git@x:y.git',
      mode: 'plain',
      skills: { g: { version: '1.0', commit: 'abc1234', sourceHash: H, outputs: { claude: H, codex: H } } },
    },
    targets: [{ target: '.claude/skills/g', files }],
    removeDirs: [],
    excludeEntries: null,
  };
}

// --- publication boundaries --------------------------------------------------
// Trace: commit A publishes foo@1.0 with scripts/helper.js = A; commit B changes
// ONLY scripts/helper.js (no version bump). The old `git log` pathspec watched
// SKILL.md alone, so B was not a boundary and two different whole-skill trees were
// accepted under 1.0.

test('a same-version change to a non-SKILL.md file is a publication boundary (DUPLICATE_VERSION)', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1.0 (helper A)', skill: { name: 'foo', version: '1.0', files: { 'scripts/helper.js': 'A' } } },
    ]);
    // Commit B: change only scripts/helper.js, leave SKILL.md (and the version) alone.
    await fs.writeFile(path.join(central.dir, 'foo', 'scripts', 'helper.js'), 'B', 'utf8');
    gitSync(central.dir, ['add', '-A']);
    gitSync(central.dir, ['commit', '-q', '-m', 'helper B, forgot to bump']);

    const clone = await fullClone(central.dir);
    try {
      await assert.rejects(
        validatePublication(clone.dir, 'foo'),
        (err) => err.code === 'DUPLICATE_VERSION',
        'a whole-tree change under an unchanged version must be rejected',
      );
    } finally {
      await clone.cleanup();
    }
  } finally {
    await rmrf(root);
  }
});

test('a non-SKILL.md change WITH a version bump publishes cleanly and stays resolvable', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'v1.0', skill: { name: 'foo', version: '1.0', files: { 'scripts/helper.js': 'A' } } },
    ]);
    await writeSkill(path.join(central.dir, 'foo'), {
      name: 'foo',
      version: '1.1',
      files: { 'scripts/helper.js': 'B' },
    });
    gitSync(central.dir, ['add', '-A']);
    gitSync(central.dir, ['commit', '-q', '-m', 'helper B @1.1']);

    const clone = await fullClone(central.dir);
    try {
      await validatePublication(clone.dir, 'foo'); // must not throw
    } finally {
      await clone.cleanup();
    }
  } finally {
    await rmrf(root);
  }
});

// --- live-ancestor fsync and unsupported-fsync diagnostics -------------------
// Trace: on a fresh project, `.claude` and `.claude/skills` were created without
// syncing their parents, so a power loss could keep the (durable) manifest while
// losing the `.claude` directory entry. The light fsync of created live ancestors
// and rename parents is retained under the idempotent model.

/**
 * Record every path fsynced during `fn` by wrapping fs.promises.open.
 * @param {(() => Promise<void>)} fn
 * @returns {Promise<string[]>}
 */
async function recordFsyncs(fn) {
  const realOpen = fsMod.promises.open;
  /** @type {string[]} */
  const synced = [];
  fsMod.promises.open = async (p, ...rest) => {
    const fh = await realOpen.call(fsMod.promises, p, ...rest);
    const realSync = fh.sync.bind(fh);
    fh.sync = async () => {
      synced.push(String(p));
      return realSync();
    };
    return fh;
  };
  try {
    await fn();
  } finally {
    fsMod.promises.open = realOpen;
  }
  return synced;
}

test('newly created live ancestors (.claude, .claude/skills) have their parents fsynced', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });

    const plan = await claudePlan(src);
    const synced = await recordFsyncs(() => runTransaction(proj, plan));

    assert.ok(synced.includes(proj), 'the project root must be fsynced after `.claude` is created');
    assert.ok(synced.includes(path.join(proj, '.claude')), '`.claude` must be fsynced after `.claude/skills` is created');
    assert.ok(synced.includes(path.join(proj, '.claude', 'skills')), 'the rename parent must be fsynced');
  } finally {
    await rmrf(root);
  }
});

test('a filesystem that cannot fsync a directory fails with DURABILITY_UNSUPPORTED', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });
    const plan = await claudePlan(src);

    const realOpen = fsMod.promises.open;
    fsMod.promises.open = async (p, ...rest) => {
      const fh = await realOpen.call(fsMod.promises, p, ...rest);
      const st = await fh.stat();
      if (st.isDirectory()) {
        fh.sync = async () => {
          const err = new Error('operation not permitted');
          err.code = 'EPERM'; // a platform code the old ignore-list did not know
          throw err;
        };
      }
      return fh;
    };
    try {
      await assert.rejects(runTransaction(proj, plan), (err) => err.code === 'DURABILITY_UNSUPPORTED');
    } finally {
      fsMod.promises.open = realOpen;
    }
  } finally {
    await rmrf(root);
  }
});

// --- PID-reuse self-collision ------------------------------------------------
// Trace: a crashed holder recorded pid 123 with an old start time; the next
// skillsync process itself gets pid 123. The old `pid === process.pid` short
// circuit returned "not stale" BEFORE comparing start identities, so acquisition
// timed out forever.

test('a stale lock whose pid this process inherited is reclaimed (start identity differs)', async (t) => {
  if (procStartTime(process.pid) === null) {
    t.skip('process start identity unavailable here (no /proc, no `ps`) — reclaim is intentionally refused');
    return;
  }
  const root = await tmpDir();
  try {
    const dir = path.join(root, LOCK_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        token: 'crashed',
        pid: process.pid, // the SAME pid this process now has
        host: os.hostname(),
        time: Date.now() - 10_000,
        start: 'l:1', // recorded by the crashed holder — not our start identity
      }),
      'utf8',
    );

    const lock = await acquireLock(root, { timeoutMs: 2_000 });
    assert.ok(lock.token && lock.token !== 'crashed', 'the stale lock must be reclaimed, not stranded');
    await lock.release();
  } finally {
    await rmrf(root);
  }
});

test('a lock genuinely held by this process (matching start identity) is never stolen', async (t) => {
  if (procStartTime(process.pid) === null) {
    t.skip('process start identity unavailable here');
    return;
  }
  const root = await tmpDir();
  try {
    const lock = await acquireLock(root);
    await assert.rejects(acquireLock(root, { timeoutMs: 200 }), (err) => err.code === 'LOCKED');
    await lock.release();
  } finally {
    await rmrf(root);
  }
});

// --- invalid YAML escapes ----------------------------------------------------
// Trace: `name: "f\oo"` was silently normalized to `foo` and `version: "1\.0"` to
// `1.0`; `"foo"` decoded wrongly; quoted keys were invisible to the reader.

test('an invalid double-quote escape is rejected, not silently normalized', () => {
  assert.throws(
    () => parseFrontmatter('---\nname: "f\\oo"\nversion: "1.0"\n---\n'),
    (err) => err.code === 'BAD_FRONTMATTER',
  );
  assert.throws(
    () => parseFrontmatter('---\nname: foo\nversion: "1\\.0"\n---\n'),
    (err) => err.code === 'BAD_FRONTMATTER',
  );
});

test('unicode and hex escapes decode per the YAML table; incomplete ones are rejected', () => {
  const { data } = parseFrontmatter('---\nname: "\\u0066oo"\ndescription: "a\\tb\\x41\\n"\n---\n');
  assert.equal(data.name, 'foo');
  assert.equal(data.description, 'a\tbA\n');
  assert.throws(
    () => parseFrontmatter('---\nname: "\\u06"\n---\n'),
    (err) => err.code === 'BAD_FRONTMATTER',
  );
});

test('quoted top-level keys are recognized (and collide with their bare twin)', () => {
  const { data } = parseFrontmatter('---\n"name": foo\nversion: 1.0\n---\n');
  assert.equal(data.name, 'foo');
  assert.throws(
    () => parseFrontmatter('---\nname: foo\n"name": bar\nversion: 1.0\n---\n'),
    (err) => err.code === 'BAD_FRONTMATTER',
    'a quoted duplicate of an identity key must not hide behind the quotes',
  );
});
