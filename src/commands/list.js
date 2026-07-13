/**
 * `skillsync list` — show the skills this project pins and their materialization
 * status (present / missing / drifted). Read-only; no lock, no network.
 * @module commands/list
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readManifest, pinAgents } from '../manifest.js';
import { hashMaterialized } from '../materialize.js';
import { targetDir } from '../plan.js';
import { log, sanitizeMetadata } from '../util.js';
import { resolveProject, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function list(argv, ctx) {
  parseArgs(argv);
  const project = resolveProject(ctx.cwd);
  const manifest = await readManifest(project.manifestPath);

  const names = Object.keys(manifest.skills).sort();
  log(`source: ${sanitizeMetadata(manifest.source)}`);
  log(`mode:   ${manifest.mode}`);
  if (names.length === 0) {
    log('(no skills enabled — use "skillsync add <skill>")');
    return;
  }
  log('');
  for (const skill of names) {
    const pin = manifest.skills[skill];
    const agents = pinAgents(pin);
    /** @type {string[]} */
    const parts = [];
    for (const agent of agents) {
      const status = await statusFor(ctx.cwd, agent, skill, pin.outputs[agent]);
      parts.push(`${agent}:${status}`);
    }
    log(`  ${skill}@${pin.version}  [${parts.join(' ')}]`);
  }
}

/**
 * Only a genuinely absent copy is `missing`; any other hashing failure is an
 * `anomaly` (integrity violation), not `missing` (adversarial-review MAJOR:
 * anomalies were reported as missing).
 * @param {string} projectDir
 * @param {string} agent
 * @param {string} skill
 * @param {string} recorded
 * @returns {Promise<'ok'|'missing'|'drifted'|'anomaly'>}
 */
async function statusFor(projectDir, agent, skill, recorded) {
  const dir = path.join(projectDir, targetDir(agent, skill));
  // `missing` ONLY when a non-following lstat proves the root itself is absent;
  // any other failure (symlinked root, mid-scan race, unreadable file) is an
  // anomaly (MAJOR: anomalies were reported as missing).
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
