import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest } from '../src/manifest.js';
import { makeCentral, writeSkill, gitSync, runCli, tmpDir, rmrf } from './helpers.js';

const MANIFEST_REL = '.agents/skills-manifest.json';
const CLAUDE = (skill) => `.claude/skills/${skill}/SKILL.md`;

/** Subprocess env: isolated global config + isolated HOME (for the Codex-scope check). */
function envFor(root) {
  return { XDG_CONFIG_HOME: path.join(root, 'xdg'), HOME: root };
}

/** Add a new commit to central that (re)writes a skill at a version/body. */
function advance(centralDir, skill, version, body) {
  return writeSkill(path.join(centralDir, skill), { name: skill, version, body }).then(() => {
    gitSync(centralDir, ['add', '-A']);
    gitSync(centralDir, ['commit', '-q', '-m', `${skill}@${version}`]);
  });
}

async function readManifestAt(proj) {
  return readManifest(path.join(proj, MANIFEST_REL));
}

/** init + add a set of skills in one project. */
async function setup(root, commits) {
  const central = await makeCentral(path.join(root, 'central'), commits);
  const proj = path.join(root, 'proj');
  await fs.mkdir(proj, { recursive: true });
  const env = envFor(root);
  await runCli(['init', '--source', central.dir, '--mode', 'plain'], { cwd: proj, env });
  return { central, proj, env };
}

test('update: pending minor is auto-applied', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
    ]);
    await runCli(['add', 'g'], { cwd: proj, env });
    await advance(central.dir, 'g', '1.1', 'TWO');

    const r = await runCli(['update'], { cwd: proj, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /update g 1\.0 -> 1\.1 \(minor\)/);

    const m = await readManifestAt(proj);
    assert.equal(m.skills.g.version, '1.1');
    assert.match(await fs.readFile(path.join(proj, CLAUDE('g')), 'utf8'), /TWO/);
  } finally {
    await rmrf(root);
  }
});

test('update: pending major is listed but NOT applied', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'v1.0', skill: { name: 'h', version: '1.0', body: 'ONE' } },
    ]);
    await runCli(['add', 'h'], { cwd: proj, env });
    await advance(central.dir, 'h', '2.0', 'TWO');

    const r = await runCli(['update'], { cwd: proj, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /major update 1\.0 -> 2\.0 available/);

    const m = await readManifestAt(proj);
    assert.equal(m.skills.h.version, '1.0'); // untouched
    assert.match(await fs.readFile(path.join(proj, CLAUDE('h')), 'utf8'), /ONE/);
  } finally {
    await rmrf(root);
  }
});

test('update --major applies a pending major', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'v1.0', skill: { name: 'h', version: '1.0', body: 'ONE' } },
    ]);
    await runCli(['add', 'h'], { cwd: proj, env });
    await advance(central.dir, 'h', '2.0', 'TWO');

    const r = await runCli(['update', 'h', '--major'], { cwd: proj, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /update h 1\.0 -> 2\.0 \(major\)/);

    const m = await readManifestAt(proj);
    assert.equal(m.skills.h.version, '2.0');
    assert.match(await fs.readFile(path.join(proj, CLAUDE('h')), 'utf8'), /TWO/);
  } finally {
    await rmrf(root);
  }
});

test('update --to downgrades to an exact earlier version', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
    ]);
    await runCli(['add', 'g'], { cwd: proj, env });
    await advance(central.dir, 'g', '1.1', 'TWO');
    await runCli(['update', 'g'], { cwd: proj, env }); // now at 1.1
    assert.equal((await readManifestAt(proj)).skills.g.version, '1.1');

    const r = await runCli(['update', 'g', '--to', '1.0'], { cwd: proj, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /update g 1\.1 -> 1\.0 \(downgrade\)/);

    const m = await readManifestAt(proj);
    assert.equal(m.skills.g.version, '1.0');
    const body = await fs.readFile(path.join(proj, CLAUDE('g')), 'utf8');
    assert.match(body, /ONE/);
    assert.doesNotMatch(body, /TWO/);
  } finally {
    await rmrf(root);
  }
});

test('update --preview touches nothing', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
    ]);
    await runCli(['add', 'g'], { cwd: proj, env });
    await advance(central.dir, 'g', '1.1', 'TWO');

    const manifestBefore = await fs.readFile(path.join(proj, MANIFEST_REL), 'utf8');
    const copyBefore = await fs.readFile(path.join(proj, CLAUDE('g')), 'utf8');

    const r = await runCli(['update', '--preview'], { cwd: proj, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would update g 1\.0 -> 1\.1 \(minor\)/);

    assert.equal(await fs.readFile(path.join(proj, MANIFEST_REL), 'utf8'), manifestBefore);
    assert.equal(await fs.readFile(path.join(proj, CLAUDE('g')), 'utf8'), copyBefore);
  } finally {
    await rmrf(root);
  }
});

test('update skips a drifted copy unless --force', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
    ]);
    await runCli(['add', 'g'], { cwd: proj, env });
    await advance(central.dir, 'g', '1.1', 'TWO');

    // Tamper the materialized claude copy => drift.
    const claude = path.join(proj, CLAUDE('g'));
    await fs.writeFile(claude, 'TAMPERED');

    const skipped = await runCli(['update'], { cwd: proj, env });
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.match(skipped.stderr, /drifted or anomalous/);
    assert.equal((await readManifestAt(proj)).skills.g.version, '1.0'); // not advanced
    assert.equal(await fs.readFile(claude, 'utf8'), 'TAMPERED'); // left intact

    const forced = await runCli(['update', '--force'], { cwd: proj, env });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal((await readManifestAt(proj)).skills.g.version, '1.1');
    assert.match(await fs.readFile(claude, 'utf8'), /TWO/);
  } finally {
    await rmrf(root);
  }
});

test('status classifies minor / major / current / deleted-centrally', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'a', skill: { name: 'a', version: '1.0', body: 'A' } },
      { message: 'b', skill: { name: 'b', version: '1.0', body: 'B' } },
      { message: 'c', skill: { name: 'c', version: '1.0', body: 'C' } },
      { message: 'd', skill: { name: 'd', version: '1.0', body: 'D' } },
    ]);
    await runCli(['add', 'a', 'b', 'c', 'd'], { cwd: proj, env });

    await advance(central.dir, 'a', '1.1', 'A2'); // minor
    await advance(central.dir, 'b', '2.0', 'B2'); // major
    // c unchanged (current)
    await fs.rm(path.join(central.dir, 'd'), { recursive: true, force: true }); // deleted
    gitSync(central.dir, ['add', '-A']);
    gitSync(central.dir, ['commit', '-q', '-m', 'delete d']);

    const r = await runCli(['status'], { cwd: proj, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /a@1\.0 +\[minor update -> 1\.1\]/);
    assert.match(r.stdout, /b@1\.0 +\[major update -> 2\.0\]/);
    assert.match(r.stdout, /c@1\.0 +\[up to date\]/);
    assert.match(r.stdout, /d@1\.0 +\[deleted centrally\]/);
  } finally {
    await rmrf(root);
  }
});

test('status --cached works offline and reports age', async () => {
  const root = await tmpDir();
  try {
    const { central, proj, env } = await setup(root, [
      { message: 'v1.0', skill: { name: 'g', version: '1.0', body: 'ONE' } },
    ]);
    // `add` seeds the version cache as a side effect.
    await runCli(['add', 'g'], { cwd: proj, env });

    // Make central unreachable: any command that fetches would now fail.
    await rmrf(central.dir);

    // Zero-network read from the cache still works.
    const fresh = await runCli(['status', '--cached'], { cwd: proj, env });
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.match(fresh.stdout, /cache: +checked /);
    assert.match(fresh.stdout, /g@1\.0 +\[up to date\]/);

    // Backdate the cache to exercise the age formatter.
    const cacheFile = path.join(root, 'xdg', 'skillsync', 'version-cache.json');
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    for (const key of Object.keys(cache.sources)) {
      cache.sources[key].checkedAt = Date.now() - 3 * 60 * 60 * 1000; // 3h ago
    }
    await fs.writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');

    const aged = await runCli(['status', '--cached'], { cwd: proj, env });
    assert.equal(aged.code, 0, aged.stderr);
    assert.match(aged.stdout, /checked 3h ago/);
  } finally {
    await rmrf(root);
  }
});
