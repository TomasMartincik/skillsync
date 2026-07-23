/**
 * Per-machine version cache: the primitive `status --cached` reads with zero
 * network cost, refreshed for free by any command that already fetched central
 * (`add`/`update`/`status`).
 *
 * A single JSON file beside the global config, keyed by NORMALIZED source URL:
 *
 *   {
 *     "version": 1,
 *     "sources": {
 *       "<normalized-source>": {
 *         "checkedAt": 1721000000000,      // epoch ms of the last refresh
 *         "skills": { "<skill>": "1.2" }   // central latest version per skill
 *       }
 *     }
 *   }
 *
 * Written atomically (temp + rename). No locking, no schema versioning beyond the
 * top-level `version` field — it is a convenience cache, never authoritative.
 *
 * @module version-cache
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE_SUBPATH } from './constants.js';
import { normalizeSource } from './config.js';
import { warn } from './util.js';

const CACHE_VERSION = 1;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function cachePath(env = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, CACHE_SUBPATH);
}

/**
 * Read the whole cache, returning an empty shell on any problem.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ version: number, sources: Record<string, { checkedAt: number, skills: Record<string,string> }> }>}
 */
export async function readCache(env) {
  try {
    const obj = JSON.parse(await fs.readFile(cachePath(env), 'utf8'));
    if (obj && typeof obj === 'object' && obj.version === CACHE_VERSION && obj.sources && typeof obj.sources === 'object') {
      return obj;
    }
  } catch {
    // fall through
  }
  return { version: CACHE_VERSION, sources: {} };
}

/**
 * The cache entry for a source (normalized), or null if never recorded.
 * @param {string} source
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ checkedAt: number, skills: Record<string,string> }|null>}
 */
export async function getCacheEntry(source, env) {
  const cache = await readCache(env);
  const entry = cache.sources[normalizeSource(source)];
  if (entry && typeof entry === 'object' && entry.skills && typeof entry.skills === 'object') {
    return { checkedAt: Number(entry.checkedAt) || 0, skills: entry.skills };
  }
  return null;
}

/**
 * Merge observed central versions into a source's entry and stamp `checkedAt`.
 * Merges (rather than replaces) so a single-skill `add` keeps the rest of the
 * source's cache. Atomic temp + rename; never throws for a missing dir.
 * @param {string} source
 * @param {Record<string,string>} skills observed skill -> central version
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<void>}
 */
export async function refreshCacheEntry(source, skills, env) {
  const key = normalizeSource(source);
  const cache = await readCache(env);
  const prev = cache.sources[key];
  const merged = prev && prev.skills && typeof prev.skills === 'object' ? { ...prev.skills } : {};
  for (const [name, version] of Object.entries(skills)) {
    if (version != null) merged[name] = version;
  }
  cache.sources[key] = { checkedAt: Date.now(), skills: merged };

  const p = cachePath(env);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * Best-effort refresh from an already-computed central map (skill -> version|null).
 * A cache write is a free side effect; it must never fail the calling command, so
 * any error is downgraded to a warning.
 * @param {string} source
 * @param {Record<string, string|null>} centralMap
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<void>}
 */
export async function refreshFromCentral(source, centralMap, env) {
  try {
    /** @type {Record<string,string>} */
    const skills = {};
    for (const [name, version] of Object.entries(centralMap)) if (version != null) skills[name] = version;
    await refreshCacheEntry(source, skills, env);
  } catch (err) {
    warn(`could not refresh version cache: ${(err && err.message) || err}`);
  }
}

/**
 * Human age string, e.g. "just now", "5m ago", "3h ago", "2d ago".
 * @param {number} checkedAt epoch ms
 * @param {number} [now]
 * @returns {string}
 */
export function formatAge(checkedAt, now = Date.now()) {
  const s = Math.floor(Math.max(0, now - checkedAt) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
