/**
 * Manifest schema v1 (amended per #6): read, validate, serialize.
 *
 * Shape:
 * {
 *   "version": 1,
 *   "source": "git@github.com:owner/skills.git",
 *   "mode": "committed" | "gitignored" | "plain",
 *   "skills": {
 *     "<name>": {
 *       "version": "1.2",          // THE PIN — sync is exact to this
 *       "commit": "9f3ab12…",      // resolution cache only
 *       "sourceHash": "sha256:…",  // canonical source tree hash
 *       "outputs": {                // per-materialized-copy hashes (drift guard)
 *         "claude": "sha256:…",
 *         "codex":  "sha256:…"
 *       },
 *       "agents": ["codex"]        // optional filter; omitted => all agents
 *     }
 *   }
 * }
 *
 * Serialization is deterministic (sorted skill keys, stable field order, trailing
 * newline) so committed manifests diff cleanly and round-trip byte-stably.
 *
 * @module manifest
 */

import { promises as fs } from 'node:fs';
import { AGENTS, MANIFEST_VERSION, MODES } from './constants.js';
import { isValidSkillName } from './skill-name.js';
import { SkillsyncError } from './util.js';

/**
 * @typedef {Object} SkillPin
 * @property {string} version
 * @property {string} commit
 * @property {string} sourceHash
 * @property {Record<string, string>} outputs agent-id -> `sha256:…`
 * @property {string[]} [agents] optional agent filter
 */

/**
 * @typedef {Object} Manifest
 * @property {number} version
 * @property {string} source
 * @property {string} mode
 * @property {Record<string, SkillPin>} skills
 */

/**
 * Build an empty manifest.
 * @param {{ source: string, mode: string }} opts
 * @returns {Manifest}
 */
export function emptyManifest(opts) {
  return { version: MANIFEST_VERSION, source: opts.source, mode: opts.mode, skills: {} };
}

/**
 * Which agents a pin materializes to (respects the optional filter).
 * @param {SkillPin} pin
 * @returns {string[]}
 */
export function pinAgents(pin) {
  if (Array.isArray(pin.agents) && pin.agents.length > 0) {
    return AGENTS.filter((a) => pin.agents.includes(a));
  }
  return [...AGENTS];
}

/**
 * Validate a parsed manifest object, throwing on any structural problem.
 * @param {unknown} obj
 * @returns {Manifest}
 */
export function validateManifest(obj) {
  if (obj === null || typeof obj !== 'object') {
    throw new SkillsyncError('BAD_MANIFEST', 'manifest is not an object');
  }
  const m = /** @type {Record<string, unknown>} */ (obj);
  if (m.version !== MANIFEST_VERSION) {
    throw new SkillsyncError('BAD_MANIFEST', `unsupported manifest version: ${String(m.version)}`);
  }
  if (typeof m.source !== 'string' || m.source === '') {
    throw new SkillsyncError('BAD_MANIFEST', 'manifest.source must be a non-empty string');
  }
  if (typeof m.mode !== 'string' || !MODES.includes(/** @type {any} */ (m.mode))) {
    throw new SkillsyncError('BAD_MANIFEST', `manifest.mode must be one of ${MODES.join(', ')}`);
  }
  if (m.skills === null || typeof m.skills !== 'object') {
    throw new SkillsyncError('BAD_MANIFEST', 'manifest.skills must be an object');
  }
  /** @type {Record<string, SkillPin>} */
  const skills = {};
  for (const [name, rawPin] of Object.entries(/** @type {Record<string, unknown>} */ (m.skills))) {
    if (!isValidSkillName(name)) {
      throw new SkillsyncError(
        'BAD_MANIFEST',
        `skill key ${JSON.stringify(name)} is not a valid skill name (Agent Skills grammar)`,
      );
    }
    skills[name] = validatePin(name, rawPin);
  }
  return { version: MANIFEST_VERSION, source: m.source, mode: m.mode, skills };
}

/**
 * @param {string} name
 * @param {unknown} rawPin
 * @returns {SkillPin}
 */
function validatePin(name, rawPin) {
  if (rawPin === null || typeof rawPin !== 'object') {
    throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" pin is not an object`);
  }
  const p = /** @type {Record<string, unknown>} */ (rawPin);
  if (typeof p.version !== 'string' || !/^\d+\.\d+$/.test(p.version)) {
    throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" has an invalid version`);
  }
  if (typeof p.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(p.commit)) {
    throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" has an invalid commit`);
  }
  if (typeof p.sourceHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(p.sourceHash)) {
    throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" has an invalid sourceHash`);
  }
  if (p.outputs === null || typeof p.outputs !== 'object') {
    throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" has invalid outputs`);
  }
  /** @type {Record<string, string>} */
  const outputs = {};
  for (const [agent, hash] of Object.entries(/** @type {Record<string, unknown>} */ (p.outputs))) {
    if (!AGENTS.includes(/** @type {any} */ (agent))) {
      throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" outputs has unknown agent "${agent}"`);
    }
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" outputs.${agent} is not a sha256 hash`);
    }
    outputs[agent] = hash;
  }
  /** @type {SkillPin} */
  const pin = { version: p.version, commit: p.commit, sourceHash: p.sourceHash, outputs };
  if (p.agents !== undefined) {
    if (
      !Array.isArray(p.agents) ||
      p.agents.length === 0 ||
      !p.agents.every((a) => AGENTS.includes(/** @type {any} */ (a))) ||
      new Set(p.agents).size !== p.agents.length
    ) {
      throw new SkillsyncError('BAD_MANIFEST', `skill "${name}" agents filter is invalid`);
    }
    pin.agents = [...p.agents];
  }
  // Outputs must be exactly one hash per selected agent — no more, no fewer. A
  // hand-edited pin with agents:["codex"] but outputs:{} (or an extra agent) is
  // invalid state and is rejected here rather than failing mysteriously later.
  const expected = pinAgents(pin);
  const got = Object.keys(outputs);
  if (got.length !== expected.length || !expected.every((a) => outputs[a] !== undefined)) {
    throw new SkillsyncError(
      'BAD_MANIFEST',
      `skill "${name}" outputs must have exactly one hash per selected agent (expected: ${expected.join(', ')})`,
    );
  }
  return pin;
}

/**
 * Read and validate the manifest at `manifestPath`.
 * @param {string} manifestPath
 * @returns {Promise<Manifest>}
 */
export async function readManifest(manifestPath) {
  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    throw new SkillsyncError('NO_MANIFEST', `no manifest at ${manifestPath}; run "skillsync init" first`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SkillsyncError('BAD_MANIFEST', `manifest is not valid JSON: ${(err && err.message) || err}`);
  }
  return validateManifest(parsed);
}

/**
 * Deterministically serialize a manifest to a JSON string (trailing newline).
 * @param {Manifest} manifest
 * @returns {string}
 */
export function serializeManifest(manifest) {
  const skills = {};
  for (const name of Object.keys(manifest.skills).sort()) {
    const pin = manifest.skills[name];
    /** @type {Record<string, unknown>} */
    const out = {
      version: pin.version,
      commit: pin.commit,
      sourceHash: pin.sourceHash,
      outputs: sortedOutputs(pin.outputs),
    };
    if (pin.agents) out.agents = [...pin.agents];
    skills[name] = out;
  }
  const ordered = { version: manifest.version, source: manifest.source, mode: manifest.mode, skills };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * @param {Record<string, string>} outputs
 * @returns {Record<string, string>}
 */
function sortedOutputs(outputs) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const agent of AGENTS) {
    if (outputs[agent] !== undefined) out[agent] = outputs[agent];
  }
  return out;
}
