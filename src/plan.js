/**
 * Helpers for turning a desired manifest + source checkouts into a materialization
 * Plan (see materialize.js). Keeps the verb commands lean and consistent.
 * @module plan
 */

import { AGENT_TARGETS, MANIFEST_PATH } from './constants.js';
import { pinAgents } from './manifest.js';

/**
 * Repo-relative dir where `agent`'s copy of `skill` is materialized.
 * @param {string} agent
 * @param {string} skill
 * @returns {string}
 */
export function targetDir(agent, skill) {
  return `${AGENT_TARGETS[agent]}/${skill}`;
}

/**
 * Compute the `.git/info/exclude` entries for gitignored mode: the manifest plus
 * every materialized skill dir. Returns null for non-gitignored modes.
 * @param {import('./manifest.js').Manifest} manifest
 * @returns {string[]|null}
 */
export function excludeEntriesFor(manifest) {
  if (manifest.mode !== 'gitignored') return null;
  const entries = [MANIFEST_PATH];
  for (const [name, pin] of Object.entries(manifest.skills)) {
    for (const agent of pinAgents(pin)) entries.push(targetDir(agent, name));
  }
  return entries;
}
