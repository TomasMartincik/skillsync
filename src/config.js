/**
 * Per-machine global config (auto-learned source default).
 *
 * The global default source is learned ONLY from an explicit, confirmed
 * `init --source` — never merely because a manifest was read (adversarial-review
 * MAJOR: auto-learning is a trust-poisoning vector). Stored at
 * `$XDG_CONFIG_HOME/skillsync/config.json` (default `~/.config/...`).
 *
 * @module config
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_SUBPATH } from './constants.js';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, CONFIG_SUBPATH);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ defaultSource?: string }>}
 */
export async function readConfig(env) {
  try {
    const raw = await fs.readFile(configPath(env), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string|undefined>}
 */
export async function getDefaultSource(env) {
  const cfg = await readConfig(env);
  return typeof cfg.defaultSource === 'string' ? cfg.defaultSource : undefined;
}

/**
 * Persist the global default source (called only after explicit confirmation).
 * @param {string} source
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<void>}
 */
export async function setDefaultSource(source, env) {
  const p = configPath(env);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const cfg = await readConfig(env);
  cfg.defaultSource = source;
  await fs.writeFile(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/**
 * Normalize a git source for storage/identity (adversarial-review: normalize and
 * display before cloning). Deliberately conservative: it trims whitespace and a
 * trailing slash only. It must NOT strip `.git`, because the normalized value is
 * also the clone URL — dropping `.git` breaks bare-repo paths and some remotes.
 * Deeper canonicalization (ssh<->https identity) is a known future seam.
 * @param {string} source
 * @returns {string}
 */
export function normalizeSource(source) {
  return source.trim().replace(/\/+$/, '');
}
