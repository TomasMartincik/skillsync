/**
 * `skillsync sync` — materialize EXACTLY what the manifest records.
 *
 * The pin is the recorded `version`; the recorded `commit` is only a resolution
 * cache and is NOT authoritative — if it declares a different version than the
 * pin (a stale/wrong cache) we ignore it and resolve the version from history.
 * sync never advances pins even if central has moved on (reproducibility is the
 * core promise). The fetched tree's `sourceHash` and each STAGED output hash are
 * verified before the atomic swap.
 *
 * Drift/anomaly protection: a materialized copy whose hash ≠ the recorded output
 * hash (drift), or which cannot be hashed for any reason other than being absent
 * (anomaly — a symlink/FIFO/oversized/unreadable file swapped in), is skipped
 * with a warning; only `--force` overwrites it. Only a genuinely absent copy
 * (ENOENT) is treated as "missing" and re-materialized without `--force`.
 *
 * The whole read → plan → install runs under the project lock.
 *
 * @module commands/sync
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest, pinAgents } from '../manifest.js';
import { preflight } from '../git.js';
import { hashSkillTree } from '../hash.js';
import { adaptForAgent } from '../adapt.js';
import { stageTargets, commitStaged, hashMaterialized } from '../materialize.js';
import { PinResolver } from '../pin-resolver.js';
import { excludeEntriesFor, targetDir } from '../plan.js';
import { SkillsyncError, log, warn } from '../util.js';
import { resolveProject, withLock, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function sync(argv, ctx) {
  const { flags } = parseArgs(argv);
  const force = flags.force === true;
  const project = resolveProject(ctx.cwd);

  await withLock(ctx.cwd, async () => {
    const manifest = await readManifest(project.manifestPath);
    const { warnings } = await preflight(ctx.cwd, { mode: manifest.mode, manifestPath: project.manifestPath });
    for (const w of warnings) warn(w);

    const names = Object.keys(manifest.skills);
    if (names.length === 0) {
      log('nothing to sync (no skills in manifest)');
      return;
    }

    // Decide which skills need (re)materialization.
    /** @type {string[]} */
    const toMaterialize = [];
    for (const skill of names) {
      const pin = manifest.skills[skill];
      const statuses = await Promise.all(
        pinAgents(pin).map((agent) => materializedStatus(ctx.cwd, agent, skill, pin.outputs[agent])),
      );
      if (statuses.every((s) => s === 'ok')) continue;
      if (!force && statuses.some((s) => s === 'drifted' || s === 'anomaly')) {
        warn(`${skill}: materialized copy has drifted or anomalous content; skipping (use --force to overwrite)`);
        continue;
      }
      toMaterialize.push(skill);
    }

    if (toMaterialize.length === 0) {
      log('already in sync');
      return;
    }

    const resolver = new PinResolver(manifest.source);
    try {
      /** @type {{ skill: string, agent: string, target: string, files: import('../input-policy.js').SkillFile[], expected: string }[]} */
      const flatSpecs = [];
      for (const skill of toMaterialize) {
        const pin = manifest.skills[skill];
        const skillDir = await resolver.resolve(skill, pin);
        // Integrity: the fetched source tree must match the recorded source hash.
        const sourceHash = await hashSkillTree(skillDir);
        if (sourceHash !== pin.sourceHash) {
          throw new SkillsyncError(
            'PIN_MISMATCH',
            `${skill}: fetched tree hash ${sourceHash} != recorded ${pin.sourceHash}; refusing to materialize`,
          );
        }
        for (const agent of pinAgents(pin)) {
          const files = await adaptForAgent(skillDir, agent);
          flatSpecs.push({ skill, agent, target: targetDir(agent, skill), files, expected: pin.outputs[agent] });
        }
        log(`sync ${skill}@${pin.version}`);
      }

      // Stage, then verify each STAGED output hash equals the recorded pin.
      const staged = await stageTargets(ctx.cwd, flatSpecs.map((s) => ({ target: s.target, files: s.files })));
      for (let i = 0; i < flatSpecs.length; i++) {
        const { skill, agent, expected } = flatSpecs[i];
        if (staged.targets[i].hash !== expected) {
          throw new SkillsyncError(
            'PIN_MISMATCH',
            `${skill}: ${agent} staged output hash ${staged.targets[i].hash} != recorded ${expected}`,
          );
        }
      }

      await commitStaged(ctx.cwd, {
        staged,
        manifest, // unchanged: sync does not advance pins
        removeDirs: [],
        excludeEntries: excludeEntriesFor(manifest),
      });
    } finally {
      await resolver.cleanup();
    }
  });
}

/**
 * Classify a materialized copy. Only a genuinely absent target is `missing`;
 * every other failure (integrity/scan/hash error) is an `anomaly` that requires
 * `--force`, never a silent overwrite (adversarial-review MAJOR: anomalies were
 * misclassified as missing).
 * @param {string} projectDir
 * @param {string} agent
 * @param {string} skill
 * @param {string} recorded recorded output hash
 * @returns {Promise<'ok'|'missing'|'drifted'|'anomaly'>}
 */
async function materializedStatus(projectDir, agent, skill, recorded) {
  const dir = path.join(projectDir, targetDir(agent, skill));
  // `missing` ONLY when a non-following lstat proves the root itself is absent.
  // Any other outcome — a symlinked root, a mid-scan race, an unreadable file —
  // is an anomaly, never a silent overwrite (MAJOR: anomalies read as missing).
  try {
    await fs.lstat(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'missing';
    return 'anomaly';
  }
  try {
    const actual = await hashMaterialized(dir);
    return actual === recorded ? 'ok' : 'drifted';
  } catch {
    return 'anomaly';
  }
}
