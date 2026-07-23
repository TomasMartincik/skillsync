import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { init } from '../src/commands/init.js';
import { readManifest, pinAgents } from '../src/manifest.js';
import { hashMaterialized } from '../src/materialize.js';
import { targetDir } from '../src/plan.js';
import { makeCentral, runCli, tmpDir, rmrf } from './helpers.js';

const ADD_URL = new URL('../src/commands/add.js', import.meta.url).href;

/**
 * A runner that reaches a shared BARRIER before calling `add`, so both processes
 * are provably past startup — and would both read the initial manifest M0 in a
 * pre-lock-read design — before either commits. In the correct design the project
 * lock serializes them and the result is the UNION; a lock/ordering regression
 * makes the two racers deterministically clobber each other and this test fail.
 */
const BARRIER_RUNNER = `
import { promises as fs } from 'node:fs';
const [addUrl, proj, skill, barrierDir, self, other] = process.argv.slice(2);
const { add } = await import(addUrl);
await fs.writeFile(barrierDir + '/' + self, 'ready');
const deadline = Date.now() + 30000;
for (;;) {
  try { await fs.access(barrierDir + '/' + other); break; } catch {}
  if (Date.now() > deadline) throw new Error('barrier timeout');
  await new Promise((r) => setTimeout(r, 10));
}
await add([skill], { cwd: proj });
`;

/** @returns {Promise<{ code: number, stderr: string }>} */
function runBarrier(runnerPath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, ADD_URL, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
  });
}

test('two barrier-synchronized add processes both win: the lock forces the union', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'foo', skill: { name: 'foo', version: '1.0', body: 'FOO' } },
      { message: 'bar', skill: { name: 'bar', version: '1.0', body: 'BAR' } },
    ]);
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const barrierDir = path.join(root, 'barrier');
    await fs.mkdir(barrierDir, { recursive: true });
    const runnerPath = path.join(root, 'barrier-runner.mjs');
    await fs.writeFile(runnerPath, BARRIER_RUNNER, 'utf8');
    const env = { XDG_CONFIG_HOME: path.join(root, 'xdg'), SKILLSYNC_LOCK_TIMEOUT_MS: '60000' };

    await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });

    const [a, b] = await Promise.all([
      runBarrier(runnerPath, [proj, 'foo', barrierDir, 'A', 'B'], env),
      runBarrier(runnerPath, [proj, 'bar', barrierDir, 'B', 'A'], env),
    ]);
    assert.equal(a.code, 0, `A failed: ${a.stderr}`);
    assert.equal(b.code, 0, `B failed: ${b.stderr}`);

    const manifest = await readManifest(path.join(proj, '.agents/skills-manifest.json'));
    assert.deepEqual(Object.keys(manifest.skills).sort(), ['bar', 'foo'], 'both additions must survive');
    for (const skill of ['foo', 'bar']) {
      const pin = manifest.skills[skill];
      for (const agent of pinAgents(pin)) {
        const dir = path.join(proj, targetDir(agent, skill));
        assert.equal(await hashMaterialized(dir), pin.outputs[agent]);
      }
    }
  } finally {
    await rmrf(root);
  }
});

/**
 * THE missing test (adversarial-review): two concurrent `add`s in separate real
 * processes must both succeed and compose into the UNION of their additions —
 * neither may clobber the other, and no lock/staging residue may remain.
 *
 * The previous design read the manifest BEFORE locking, so two adds starting from
 * the same M0 both wrote M0+their-own-skill and one addition was lost. The rework
 * moves read→plan→install entirely under a blocking project lock, so the
 * second process observes the first's committed manifest and appends to it.
 */
test('two concurrent add processes both win: final manifest is the union, no residue', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'foo', skill: { name: 'foo', version: '1.0', body: 'FOO' } },
      { message: 'bar', skill: { name: 'bar', version: '1.0', body: 'BAR' } },
    ]);
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const env = { XDG_CONFIG_HOME: path.join(root, 'xdg'), SKILLSYNC_LOCK_TIMEOUT_MS: '60000' };

    await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });

    // Both start from the same initial (empty) manifest, launched together.
    const [a, b] = await Promise.all([
      runCli(['add', 'foo'], { cwd: proj, env }),
      runCli(['add', 'bar'], { cwd: proj, env }),
    ]);
    assert.equal(a.code, 0, `add foo failed: ${a.stderr}`);
    assert.equal(b.code, 0, `add bar failed: ${b.stderr}`);

    // Final manifest is the UNION.
    const manifest = await readManifest(path.join(proj, '.agents/skills-manifest.json'));
    assert.deepEqual(Object.keys(manifest.skills).sort(), ['bar', 'foo']);

    // Both outputs are materialized and match the manifest exactly.
    for (const skill of ['foo', 'bar']) {
      const pin = manifest.skills[skill];
      for (const agent of pinAgents(pin)) {
        const dir = path.join(proj, targetDir(agent, skill));
        assert.equal(await hashMaterialized(dir), pin.outputs[agent], `${skill}/${agent} hash != manifest`);
      }
    }

    // No lock / staging residue.
    await assert.rejects(fs.stat(path.join(proj, '.agents/.skillsync.lock')));
    const agentsEntries = await fs.readdir(path.join(proj, '.agents'));
    assert.ok(
      !agentsEntries.some((e) => e.includes('stage') || e.includes('lock')),
      `unexpected residue: ${agentsEntries.join(', ')}`,
    );
  } finally {
    await rmrf(root);
  }
});
