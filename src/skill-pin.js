/**
 * Build a manifest pin (minus staged output hashes) and its materialization
 * target specs from a source skill dir. Shared by `add` (materialize at current
 * HEAD) and `sync` (materialize at the recorded version). This is where the
 * source tree's identity is validated and hashed and the adaptation seam is run
 * once per agent to produce the file list to STAGE.
 *
 * Output hashes are intentionally NOT computed here: they are hashed off the
 * STAGED tree by materialize (adversarial-review MAJOR: "stage and hash there"),
 * and the caller fills `pin.outputs` from the staged result.
 *
 * @module skill-pin
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adaptForAgent } from './adapt.js';
import { hashSkillTree } from './hash.js';
import { parseFrontmatter } from './frontmatter.js';
import { normalizeVersion } from './fetch.js';
import { pinAgents } from './manifest.js';
import { assertSkillName } from './skill-name.js';
import { targetDir } from './plan.js';
import { SkillsyncError } from './util.js';

/**
 * @typedef {Object} SkillPlan
 * @property {import('./manifest.js').SkillPin} pin pin with EMPTY outputs (filled from staged hashes)
 * @property {{ agent: string, target: string, files: import('./input-policy.js').SkillFile[] }[]} specs
 */

/**
 * @param {Object} args
 * @param {string} args.skill skill name
 * @param {string} args.skillDir absolute path to the source skill dir
 * @param {string} args.commit resolved commit SHA to record
 * @param {string[]} [args.agentsFilter] optional agents filter to record
 * @returns {Promise<SkillPlan>}
 */
export async function buildSkillPlan({ skill, skillDir, commit, agentsFilter }) {
  assertSkillName(skill);

  // The directory basename AND the frontmatter `name` must both equal the skill.
  if (path.basename(skillDir) !== skill) {
    throw new SkillsyncError(
      'NAME_MISMATCH',
      `skill directory basename ${JSON.stringify(path.basename(skillDir))} != requested skill ${JSON.stringify(skill)}`,
    );
  }
  const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  const { data } = parseFrontmatter(raw);
  if (data.name !== skill) {
    throw new SkillsyncError(
      'NAME_MISMATCH',
      `SKILL.md frontmatter name ${JSON.stringify(data.name)} != directory name ${JSON.stringify(skill)}`,
    );
  }
  const version = normalizeVersion(data.version);
  if (version === null) {
    throw new SkillsyncError(
      'MISSING_VERSION',
      `skill "${skill}" has no valid "version: <major>.<minor>" frontmatter`,
    );
  }
  const sourceHash = await hashSkillTree(skillDir);

  /** @type {import('./manifest.js').SkillPin} */
  const pin = { version, commit, sourceHash, outputs: {} };
  if (agentsFilter && agentsFilter.length > 0) pin.agents = [...agentsFilter];

  /** @type {SkillPlan['specs']} */
  const specs = [];
  for (const agent of pinAgents(pin)) {
    const files = await adaptForAgent(skillDir, agent);
    specs.push({ agent, target: targetDir(agent, skill), files });
  }
  return { pin, specs };
}
