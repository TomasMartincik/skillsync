/**
 * Filesystem input policy for skill trees (adversarial-review MAJOR: input policy).
 *
 * A skill tree fetched from central (or read back from a materialized copy) must
 * be validated before it is hashed or copied. This module enforces:
 *   - no symlinks, and no non-regular files (FIFO/socket/device) anywhere;
 *   - per-file and per-skill size limits, and a file-count cap;
 *   - case/Unicode-fold path collision detection (macOS case-insensitive FS vs
 *     Linux case-sensitive FS would otherwise materialize different trees).
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
 */

/**
 * Recursively collect regular files under `root`, rejecting disallowed entries.
 * @param {string} root absolute path to the skill directory
 * @returns {Promise<SkillFile[]>} files sorted ascending by POSIX relative path
 */
export async function scanSkillTree(root) {
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

  await walk(root, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  detectFoldCollisions(files);
  return files;
}

/**
 * Reject trees whose paths collide under Unicode NFC + case folding. Such a tree
 * would materialize as two files on Linux but one (clobbered) on macOS.
 * @param {SkillFile[]} files
 */
export function detectFoldCollisions(files) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const f of files) {
    const key = f.rel.normalize('NFC').toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined && prev !== f.rel) {
      throw new SkillsyncError(
        'FOLD_COLLISION',
        `case/Unicode-fold path collision: "${prev}" vs "${f.rel}"`,
      );
    }
    seen.set(key, f.rel);
  }
}
