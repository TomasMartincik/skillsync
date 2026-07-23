/**
 * Classify a materialized skill copy against its recorded output hash. Shared by
 * `list`, `sync`, `update`, and `status` so drift/anomaly detection is defined in
 * exactly one place.
 *
 * Only a genuinely absent copy (ENOENT on a non-following lstat) is `missing`; any
 * other hashing failure — a symlinked root, a mid-scan race, an unreadable or
 * swapped-in non-regular file — is an `anomaly` (integrity violation), never a
 * silent overwrite.
 *
 * @module materialized-status
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hashMaterialized } from './materialize.js';
import { pinAgents } from './manifest.js';
import { targetDir } from './plan.js';

/**
 * @param {string} projectDir
 * @param {string} agent
 * @param {string} skill
 * @param {string} recorded recorded output hash
 * @returns {Promise<'ok'|'missing'|'drifted'|'anomaly'>}
 */
export async function materializedStatus(projectDir, agent, skill, recorded) {
  const dir = path.join(projectDir, targetDir(agent, skill));
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

const RANK = { ok: 0, missing: 1, drifted: 2, anomaly: 3 };

/**
 * Per-agent statuses plus the worst-case across a skill's agents.
 * @param {string} projectDir
 * @param {string} skill
 * @param {import('./manifest.js').SkillPin} pin
 * @returns {Promise<{ perAgent: Record<string,'ok'|'missing'|'drifted'|'anomaly'>, worst: 'ok'|'missing'|'drifted'|'anomaly' }>}
 */
export async function copyStatus(projectDir, skill, pin) {
  /** @type {Record<string, 'ok'|'missing'|'drifted'|'anomaly'>} */
  const perAgent = {};
  let worst = /** @type {'ok'|'missing'|'drifted'|'anomaly'} */ ('ok');
  for (const agent of pinAgents(pin)) {
    const s = await materializedStatus(projectDir, agent, skill, pin.outputs[agent]);
    perAgent[agent] = s;
    if (RANK[s] > RANK[worst]) worst = s;
  }
  return { perAgent, worst };
}
