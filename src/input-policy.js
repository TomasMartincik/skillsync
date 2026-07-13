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
 * Case/Unicode-folding policy for collision detection.
 *
 * A tree that is two distinct entries on a case-sensitive filesystem (Linux) but
 * one entry on a case-insensitive one (default macOS/Windows) would materialize
 * differently per machine, breaking reproducibility and enabling one file to
 * silently clobber another. We reject such trees.
 *
 * The policy is explicitly defined (not bare `toLowerCase()` on whole paths):
 * fold = Unicode NFC normalization, then `toLocaleLowerCase('en-US')` for a
 * locale-independent full-case fold, applied PER PATH COMPONENT. Collisions are
 * checked at every component (directories included), and a name used once as a
 * file and once as a directory prefix is a collision too.
 *
 * @param {string} s a single path component
 * @returns {string}
 */
export function foldComponent(s) {
  return s.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Reject trees whose paths collide under the folding policy. Tracks every path
 * COMPONENT (directories as well as files) and rejects:
 *   - two distinct real components that fold to the same key (case/Unicode alias);
 *   - a component used as both a leaf file and a directory prefix (file/dir clash).
 * @param {Pick<SkillFile, 'rel'>[]} files
 */
export function detectFoldCollisions(files) {
  // foldedPath -> { real: original-cased path, kind: 'dir'|'file' }
  /** @type {Map<string, { real: string, kind: 'dir'|'file' }>} */
  const seen = new Map();

  /**
   * @param {string} foldedPath
   * @param {string} realPath
   * @param {'dir'|'file'} kind
   */
  function record(foldedPath, realPath, kind) {
    const prev = seen.get(foldedPath);
    if (prev === undefined) {
      seen.set(foldedPath, { real: realPath, kind });
      return;
    }
    if (prev.real !== realPath) {
      throw new SkillsyncError(
        'FOLD_COLLISION',
        `case/Unicode-fold path collision: "${prev.real}" vs "${realPath}"`,
      );
    }
    if (prev.kind !== kind) {
      throw new SkillsyncError(
        'FOLD_COLLISION',
        `path used as both a file and a directory: "${realPath}"`,
      );
    }
  }

  for (const f of files) {
    const parts = f.rel.split('/');
    const foldedParts = [];
    const realParts = [];
    for (let i = 0; i < parts.length; i++) {
      foldedParts.push(foldComponent(parts[i]));
      realParts.push(parts[i]);
      const isLeaf = i === parts.length - 1;
      record(foldedParts.join('/'), realParts.join('/'), isLeaf ? 'file' : 'dir');
    }
  }
}
