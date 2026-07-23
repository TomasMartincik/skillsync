/**
 * Idempotent re-run replaces the old journal/recovery machinery: a crash mid-copy
 * is recovered simply by RE-RUNNING. Each case runs a real `skillsync sync` child
 * that hard-kills itself (SIGKILL) at a named phase — mid-copy, mid-install, and
 * just before the manifest — proving the child died mid-operation (a staging orphan
 * is left), then re-runs `sync` normally and asserts convergence to the manifest
 * with zero staging residue.
 * @module test/idempotency
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest, pinAgents } from '../src/manifest.js';
import { hashMaterialized } from '../src/materialize.js';
import { targetDir } from '../src/plan.js';
import { makeCentral, runCli, tmpDir, rmrf } from './helpers.js';

/** @param {string} agentsDir @returns {Promise<string[]>} staging dirs present */
async function stagingDirs(agentsDir) {
  const entries = await fs.readdir(agentsDir).catch(() => []);
  return entries.filter((e) => e.includes('.skillsync-stage'));
}

/** Delete the materialized copies but KEEP the manifest, so `sync` has work to do. */
async function clearMaterialized(proj) {
  await rmrf(path.join(proj, '.claude'));
  await rmrf(path.join(proj, '.agents/skills'));
}

async function assertConverged(proj, manifest) {
  for (const skill of Object.keys(manifest.skills)) {
    const pin = manifest.skills[skill];
    for (const agent of pinAgents(pin)) {
      const dir = path.join(proj, targetDir(agent, skill));
      assert.equal(await hashMaterialized(dir), pin.outputs[agent], `${skill}/${agent} must match the manifest`);
    }
  }
}

// Phases that all occur while `sync` materializes two missing skills, BEFORE the
// staging dir is cleaned up — so a crash at each leaves a sweepable orphan.
const CRASH_PHASES = ['stage', 'stage.0.copied', 'swap.0.post-rename', 'manifest'];

for (const phase of CRASH_PHASES) {
  test(`crash at "${phase}" then re-run sync converges with no residue`, async () => {
    const root = await tmpDir();
    try {
      const central = await makeCentral(path.join(root, 'central'), [
        { message: 'foo', skill: { name: 'foo', version: '1.0', body: 'FOO', files: { 'r/a.md': 'A' } } },
        { message: 'bar', skill: { name: 'bar', version: '1.0', body: 'BAR' } },
      ]);
      const proj = path.join(root, 'proj');
      await fs.mkdir(proj, { recursive: true });
      const env = {
        XDG_CONFIG_HOME: path.join(root, 'xdg'),
        SKILLSYNC_LOCK_TIMEOUT_MS: '20000',
      };

      assert.equal((await runCli(['init', '--source', central.dir, '--mode', 'plain'], { cwd: proj, env })).code, 0);
      assert.equal((await runCli(['add', 'foo', 'bar'], { cwd: proj, env })).code, 0);
      const manifest = await readManifest(path.join(proj, '.agents/skills-manifest.json'));

      // Remove the materialized copies so the crashing sync has real work.
      await clearMaterialized(proj);

      // Crashing child: it SIGKILLs itself at `phase`, leaving a staging orphan.
      await runCli(['sync'], { cwd: proj, env: { ...env, SKILLSYNC_TEST_CRASH_PHASE: phase } });
      const orphans = await stagingDirs(path.join(proj, '.agents'));
      assert.ok(orphans.length >= 1, `the crash must leave a staging orphan (got: ${orphans.join(', ') || 'none'})`);

      // Recovery IS re-running: a plain `sync` converges and sweeps the orphan.
      const rerun = await runCli(['sync'], { cwd: proj, env });
      assert.equal(rerun.code, 0, `re-run sync failed: ${rerun.stderr}`);

      await assertConverged(proj, manifest);
      assert.deepEqual(await stagingDirs(path.join(proj, '.agents')), [], 'no staging residue after re-run');
    } finally {
      await rmrf(root);
    }
  });
}
