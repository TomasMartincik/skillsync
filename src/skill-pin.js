/**
 * Build a manifest pin and its materialization targets from a source skill dir.
 * Shared by `add` (materialize at current HEAD) and `sync` (materialize at the
 * recorded version). This is where the source tree is validated, hashed, and run
 * through the adaptation seam once per agent.
 * @module skill-pin
 */

import { adaptForAgent } from './adapt.js';
import { hashSkillTree, hashFiles } from './hash.js';
import { readSkillVersion } from './fetch.js';
import { pinAgents } from './manifest.js';
import { targetDir } from './plan.js';

/**
 * @param {Object} args
 * @param {string} args.skill skill name
 * @param {string} args.skillDir absolute path to the source skill dir
 * @param {string} args.commit resolved commit SHA to record
 * @param {string[]} [args.agentsFilter] optional agents filter to record
 * @returns {Promise<{ pin: import('./manifest.js').SkillPin, targets: import('./materialize.js').TargetWrite[] }>}
 */
export async function buildPinAndTargets({ skill, skillDir, commit, agentsFilter }) {
  const version = await readSkillVersion(skillDir);
  const sourceHash = await hashSkillTree(skillDir);

  /** @type {import('./manifest.js').SkillPin} */
  const pin = { version, commit, sourceHash, outputs: {} };
  if (agentsFilter && agentsFilter.length > 0) pin.agents = [...agentsFilter];

  /** @type {import('./materialize.js').TargetWrite[]} */
  const targets = [];
  for (const agent of pinAgents(pin)) {
    const files = await adaptForAgent(skillDir, agent);
    pin.outputs[agent] = await hashFiles(files);
    targets.push({ target: targetDir(agent, skill), files });
  }
  return { pin, targets };
}
