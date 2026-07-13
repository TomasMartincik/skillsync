/**
 * Round-3 review regressions — one focused test per reviewed trace.
 *
 * Each test reproduces the exact scenario the reviewer described and asserts the
 * behavior AFTER the fix. Traces:
 *   1. secret creation race           (src/secret.js)
 *   2. publication boundaries         (src/fetch.js)
 *   3. rename-time revalidation       (src/materialize.js)
 *   4. live-ancestor fsync            (src/materialize.js)
 *   5. PID-reuse self-collision       (src/lock.js)
 *   6. invalid YAML escapes           (src/frontmatter.js)
 *   7. unsupported-fsync diagnostics  (src/durable.js)
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
import { getSecret, secretPath } from '../src/secret.js';
import { acquireLock, procStartTime } from '../src/lock.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { fullClone, validatePublication } from '../src/fetch.js';
import { LOCK_DIR } from '../src/constants.js';
import { makeCentral, writeSkill, gitSync, tmpDir, rmrf } from './helpers.js';

// Isolate the machine secret away from the real ~/.config/skillsync.
process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), `skillsync-secret-round3-${process.pid}`);

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

/** Run `fn` with XDG_CONFIG_HOME pointed at a throwaway dir. */
async function withConfigHome(dir, fn) {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

// --- 1. secret creation race -------------------------------------------------
// Trace: `wx` published a ZERO-LENGTH secret before the bytes landed, so a racing
// process could read an empty/partial key, sign a journal with it, and have that
// journal permanently rejected once the real key finished. A short secret must now
// be refused loudly, and concurrent creators must all end up with the SAME 32
// bytes (link() publishes atomically and never clobbers the winner).

test('a truncated/empty secret is refused, never used to sign', async () => {
  const root = await tmpDir();
  try {
    await withConfigHome(path.join(root, 'xdg'), async () => {
      const p = secretPath();
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, Buffer.alloc(0), { mode: 0o600 }); // exactly what the race published
      await assert.rejects(getSecret(), (err) => err.code === 'SECRET_INVALID');
    });
  } finally {
    await rmrf(root);
  }
});

test('concurrent secret creation converges on one valid 32-byte 0600 key', async () => {
  const root = await tmpDir();
  try {
    await withConfigHome(path.join(root, 'xdg'), async () => {
      const results = await Promise.all(Array.from({ length: 16 }, () => getSecret()));
      const first = results[0].toString('hex');
      for (const r of results) {
        assert.equal(r.length, 32);
        assert.equal(r.toString('hex'), first, 'every racing creator must see the same published key');
      }
      const st = await fs.stat(secretPath());
      assert.equal(st.size, 32);
      assert.equal(st.mode & 0o777, 0o600);
      // No temp file left behind.
      const entries = await fs.readdir(path.dirname(secretPath()));
      assert.deepEqual(entries.filter((e) => e.startsWith('.secret.tmp-')), []);
    });
  } finally {
    await rmrf(root);
  }
});

test('a loosened secret mode is repaired in place', async () => {
  const root = await tmpDir();
  try {
    await withConfigHome(path.join(root, 'xdg'), async () => {
      const first = await getSecret();
      await fs.chmod(secretPath(), 0o644);
      const again = await getSecret();
      assert.equal(again.toString('hex'), first.toString('hex'), 'the key itself must not change');
      assert.equal((await fs.stat(secretPath())).mode & 0o777, 0o600);
    });
  } finally {
    await rmrf(root);
  }
});

// --- 2. publication boundaries ----------------------------------------------
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

// --- 3. rename-time revalidation --------------------------------------------
// Trace (a): during `swap.0.post-backup`, modify stagedAbs/SKILL.md — the old code
// installed those unchecked bytes because the hash was verified before the hook.
// Trace (b): during `swap.0.post-backup`, replace `.claude` with a symlink to an
// outside directory — the old code followed it for `staged -> target`.

test('staged bytes modified after the hash check are NOT installed (re-hash at rename time)', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });

    await assert.rejects(
      runTransaction(proj, await claudePlan(src), async (phase) => {
        if (phase !== 'swap.0.post-backup') return;
        const stage = (await fs.readdir(path.join(proj, '.agents'))).find((e) => e.includes('stage'));
        await fs.writeFile(path.join(proj, '.agents', stage, 't0', 'SKILL.md'), 'TAMPERED', 'utf8');
      }),
      (err) => err.code === 'JOURNAL_APPLY_FAILED',
    );

    // Nothing tampered was installed, and evidence is preserved.
    await assert.rejects(fs.stat(path.join(proj, '.claude/skills/g/SKILL.md')));
  } finally {
    await rmrf(root);
  }
});

test('a live ancestor swapped for a symlink after journaling is refused at rename time', async () => {
  const root = await tmpDir();
  try {
    const proj = path.join(root, 'proj');
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(outside, 'skills'), { recursive: true });
    await fs.mkdir(proj, { recursive: true });
    const src = path.join(root, 'src', 'g');
    await writeSkill(src, { name: 'g', version: '1.0' });

    await assert.rejects(
      runTransaction(proj, await claudePlan(src), async (phase) => {
        if (phase !== 'swap.0.post-backup') return;
        // Replace the validated `.claude` directory with a symlink out of the project.
        await fs.rm(path.join(proj, '.claude'), { recursive: true, force: true });
        await fs.symlink(outside, path.join(proj, '.claude'));
      }),
      (err) => err.code === 'UNSAFE_ANCESTOR' || err.code === 'JOURNAL_APPLY_FAILED',
    );

    // The skill never escaped into the outside directory.
    await assert.rejects(fs.stat(path.join(outside, 'skills', 'g')));
  } finally {
    await rmrf(root);
  }
});

// --- 4 + 7. live-ancestor fsync and unsupported-fsync diagnostics ------------
// Trace: on a fresh project, `.claude` and `.claude/skills` were created without
// syncing their parents, so a power loss could keep the (durable) manifest while
// losing the `.claude` directory entry.

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

// --- 5. PID-reuse self-collision --------------------------------------------
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

// --- 6. invalid YAML escapes -------------------------------------------------
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
