/**
 * Filesystem input policy for skill trees (adversarial-review MAJOR: input policy).
 *
 * A skill tree fetched from central (or read back from a materialized copy) must
 * be validated before it is hashed or copied. This module enforces:
 *   - no symlinks, and no non-regular files (FIFO/socket/device) anywhere;
 *   - per-file and per-skill size limits, and a file-count cap;
 *   - case-fold path collision detection (two paths that differ only by case would
 *     materialize as one file on a case-insensitive FS like default macOS).
 *
 * The result is a deterministic, sorted list of regular files that hashing and
 * copying both consume, so every stage sees the exact same view of the tree.
 *
 * @module input-policy
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MAX_FILE_BYTES,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
} from './constants.js';
import { SkillsyncError } from './util.js';

/**
 * @typedef {Object} SkillFile
 * @property {string} rel POSIX relative path within the skill tree
 * @property {string} abs absolute path on disk
 * @property {number} size bytes
 * @property {boolean} exec whether the owner-execute bit is set
 * @property {string} [content] adapter-synthesized bytes to stage inline instead
 *   of streaming from `abs` (see adapt.js). scanSkillTree never sets this; it is a
 *   forward-only extension the adaptation layer attaches to modified/generated files.
 */

/**
 * Recursively collect regular files under `root`, rejecting disallowed entries.
 * @param {string} root absolute path to the skill directory
 * @returns {Promise<SkillFile[]>} files sorted ascending by POSIX relative path
 */
export async function scanSkillTree(root) {
  // Inspect the ROOT itself with a non-following lstat FIRST. A genuinely absent
  // root propagates ENOENT (callers read that as "missing"); a symlinked or
  // non-directory root is an anomaly, never silently followed/reported ok
  // (MAJOR: the root was never lstat'd, so a symlinked skill dir read as ok).
  const rootSt = await fs.lstat(root); // ENOENT propagates verbatim = missing
  if (rootSt.isSymbolicLink()) {
    throw new SkillsyncError('SYMLINK_REJECTED', `skill tree root is a symlink: ${root}`);
  }
  if (!rootSt.isDirectory()) {
    throw new SkillsyncError('NON_REGULAR_REJECTED', `skill tree root is not a directory: ${root}`);
  }

  /** @type {SkillFile[]} */
  const files = [];
  let total = 0;

  /**
   * @param {string} dir
   * @param {string} rel
   */
  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;

      // lstat (do NOT follow) so symlinks are seen as symlinks.
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) {
        throw new SkillsyncError(
          'SYMLINK_REJECTED',
          `symlink not allowed in skill tree: ${childRel}`,
        );
      }
      if (st.isDirectory()) {
        await walk(abs, childRel);
        continue;
      }
      if (!st.isFile()) {
        throw new SkillsyncError(
          'NON_REGULAR_REJECTED',
          `non-regular file not allowed in skill tree: ${childRel}`,
        );
      }
      if (st.size > MAX_FILE_BYTES) {
        throw new SkillsyncError(
          'FILE_TOO_LARGE',
          `file exceeds ${MAX_FILE_BYTES} bytes: ${childRel} (${st.size})`,
        );
      }
      total += st.size;
      if (total > MAX_SKILL_BYTES) {
        throw new SkillsyncError(
          'SKILL_TOO_LARGE',
          `skill tree exceeds ${MAX_SKILL_BYTES} bytes`,
        );
      }
      files.push({
        rel: childRel,
        abs,
        size: st.size,
        exec: (st.mode & 0o100) !== 0,
      });
      if (files.length > MAX_SKILL_FILES) {
        throw new SkillsyncError(
          'TOO_MANY_FILES',
          `skill tree exceeds ${MAX_SKILL_FILES} files`,
        );
      }
    }
  }

  try {
    await walk(root, '');
  } catch (err) {
    // The root existed at lstat time, so an ENOENT DURING the walk is a concurrent
    // deletion of a child (a race/anomaly), never proof the whole target is
    // absent. Reclassify it so callers do not misread it as "missing" (MAJOR: a
    // transient child ENOENT was treated as whole-target absence).
    if (err && err.code === 'ENOENT') {
      throw new SkillsyncError('SCAN_RACE', `skill tree changed during scan: ${root}`);
    }
    throw err;
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  detectFoldCollisions(files);
  return files;
}

/**
 * Reject trees whose relative paths collide under a plain lowercase fold: two
 * distinct paths that lowercase to the same string would materialize as one file on
 * a case-insensitive filesystem (default macOS), breaking reproducibility and
 * letting one file silently clobber another.
 * @param {Pick<SkillFile, 'rel'>[]} files
 */
export function detectFoldCollisions(files) {
  /** @type {Map<string, string>} lowercased rel path -> first real rel path */
  const seen = new Map();
  for (const f of files) {
    const key = f.rel.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined && prev !== f.rel) {
      throw new SkillsyncError('FOLD_COLLISION', `case path collision: "${prev}" vs "${f.rel}"`);
    }
    if (prev === undefined) seen.set(key, f.rel);
  }
}
