/**
 * Per-agent adaptation seam.
 *
 * The real adaptation layer (Claude/Codex frontmatter differences, dropped
 * fields, `agents/openai.yaml` generation) is ticket #13. This module is the
 * clean seam it will plug into: given a validated source tree and a target agent,
 * produce the file list to materialize for that agent.
 *
 * v1 behavior is a deliberate NO-OP: every agent gets a verbatim copy of the
 * source tree. Because the transform is identity, all output hashes currently
 * equal the source hash — but each output is scanned/hashed independently so the
 * drift machinery and the future non-identity transform need no rewiring.
 *
 * @module adapt
 */

import { scanSkillTree } from './input-policy.js';

/**
 * Produce the list of files to materialize for `agent` from a source tree.
 * @param {string} sourceDir absolute path to the validated source skill dir
 * @param {string} agent agent id ('claude' | 'codex')
 * @returns {Promise<import('./input-policy.js').SkillFile[]>}
 */
export async function adaptForAgent(sourceDir, agent) {
  // #13 will branch on `agent` here. For now: identity transform.
  void agent;
  return scanSkillTree(sourceDir);
}
