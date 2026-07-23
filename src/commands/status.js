/**
 * `skillsync status` — per-skill: the recorded version, central's latest with its
 * update class (minor / major / up to date / deleted centrally), and the local
 * copy's drift/anomaly state.
 *
 *   - default     fetches central (full clone), classifies each pin, refreshes the
 *                 version cache as a side effect.
 *   - `--cached`  zero-network: reports from the version cache, including its age
 *                 ("checked 3h ago"). Works fully offline.
 *
 * A skill present in the manifest but absent from central HEAD reports "deleted
 * centrally" (a status string only — no tombstone machinery). status also warns if
 * the same skill name exists in `$HOME/.agents/skills` (Codex reads that scope AND
 * the project's without dedup, so it would shadow/duplicate).
 *
 * Read-only: no lock. `--cached` does no network at all.
 *
 * @module commands/status
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest } from '../manifest.js';
import { fullClone, centralVersion, classifyVersion } from '../fetch.js';
import { copyStatus } from '../materialized-status.js';
import { getCacheEntry, refreshFromCentral, formatAge } from '../version-cache.js';
import { log, warn, sanitizeMetadata } from '../util.js';
import { resolveProject, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function status(argv, ctx) {
  const { flags } = parseArgs(argv);
  const project = resolveProject(ctx.cwd);
  const manifest = await readManifest(project.manifestPath);

  log(`source: ${sanitizeMetadata(manifest.source)}`);
  log(`mode:   ${manifest.mode}`);

  if (flags.cached === true) {
    await statusCached(ctx, manifest);
  } else {
    await statusOnline(ctx, manifest);
  }
}

/**
 * @param {{ cwd: string }} ctx
 * @param {import('../manifest.js').Manifest} manifest
 */
async function statusOnline(ctx, manifest) {
  const names = Object.keys(manifest.skills).sort();
  if (names.length === 0) {
    log('(no skills enabled — use "skillsync add <skill>")');
    return;
  }

  const checkout = await fullClone(manifest.source);
  try {
    /** @type {Record<string, string|null>} */
    const centralMap = {};
    for (const name of names) centralMap[name] = await centralVersion(checkout.dir, name);
    await refreshFromCentral(manifest.source, centralMap);

    log('');
    for (const skill of names) {
      const pin = manifest.skills[skill];
      const central = centralMap[skill];
      const cls = classifyVersion(pin.version, central);
      const { worst } = await copyStatus(ctx.cwd, skill, pin);
      log(`  ${skill}@${pin.version}  [${classText(cls, central)}]  copy:${worst}`);
      await warnHomeScope(skill);
    }
  } finally {
    await checkout.cleanup();
  }
}

/**
 * @param {{ cwd: string }} ctx
 * @param {import('../manifest.js').Manifest} manifest
 */
async function statusCached(ctx, manifest) {
  const names = Object.keys(manifest.skills).sort();
  const entry = await getCacheEntry(manifest.source);
  if (!entry) {
    log('cache:  (empty — run "skillsync status" online to populate)');
    return;
  }
  log(`cache:  checked ${formatAge(entry.checkedAt)}`);
  if (names.length === 0) {
    log('(no skills enabled — use "skillsync add <skill>")');
    return;
  }
  log('');
  for (const skill of names) {
    const pin = manifest.skills[skill];
    const cached = entry.skills[skill];
    const { worst } = await copyStatus(ctx.cwd, skill, pin);
    const cls = cached === undefined ? null : classifyVersion(pin.version, cached);
    log(`  ${skill}@${pin.version}  [${cls === null ? 'no cached data' : classText(cls, cached)}]  copy:${worst}`);
    await warnHomeScope(skill);
  }
}

/**
 * @param {'current'|'minor'|'major'|'deleted'} cls
 * @param {string|null|undefined} central
 * @returns {string}
 */
function classText(cls, central) {
  if (cls === 'deleted') return 'deleted centrally';
  if (cls === 'current') return 'up to date';
  return `${cls} update -> ${central}`;
}

/**
 * Warn if the same skill name also lives in the user's HOME Codex scope, which
 * Codex reads alongside the project scope without dedup (one cheap lstat).
 * @param {string} skill
 */
async function warnHomeScope(skill) {
  const p = path.join(os.homedir(), '.agents', 'skills', skill);
  try {
    await fs.lstat(p);
    warn(`${skill}: also present in ${p} — Codex reads both scopes without dedup (possible shadow/duplication)`);
  } catch {
    // absent — nothing to warn about
  }
}
