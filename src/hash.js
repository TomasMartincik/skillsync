/**
 * Deterministic tree hashing.
 *
 * The hash is defined over the validated, sorted list of regular files in a
 * skill tree (see input-policy). It is stable across machines and filesystems.
 *
 * Scheme (documented in README):
 *   files := scanSkillTree(root)  // regular files only, sorted by POSIX relpath
 *   h := sha256()
 *   for each file f in files (ascending f.rel):
 *       h.update( f.rel + "\n" + modeClass(f) + "\n" + f.size + "\n" )   // header, utf-8
 *       h.update( <raw content bytes of f, streamed> )
 *       h.update( "\n" )                                                  // record separator
 *   digest := "sha256:" + hex(h)
 *
 * where modeClass(f) is "exec" if the owner-execute bit is set, else "file".
 * Only the execute bit is considered (mode-class), not the full mode. Symlinks
 * and non-regular files never reach here — they are rejected upstream.
 *
 * Streaming keeps memory bounded regardless of file size.
 *
 * @module hash
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { scanSkillTree } from './input-policy.js';

/**
 * @param {import('./input-policy.js').SkillFile} f
 * @returns {string}
 */
function modeClass(f) {
  return f.exec ? 'exec' : 'file';
}

/**
 * Stream a file's bytes into a hash object.
 * @param {import('node:crypto').Hash} h
 * @param {string} abs
 * @returns {Promise<void>}
 */
function streamInto(h, abs) {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(abs);
    rs.on('data', (chunk) => h.update(chunk));
    rs.on('error', reject);
    rs.on('end', resolve);
  });
}

/**
 * Compute the deterministic hash of a skill tree at `root`.
 * @param {string} root absolute path to the skill directory
 * @returns {Promise<string>} `sha256:<hex>`
 */
export async function hashSkillTree(root) {
  const files = await scanSkillTree(root);
  return hashFiles(files);
}

/**
 * Compute the hash from an already-scanned file list (avoids a second scan when
 * the caller has validated the tree already).
 * @param {import('./input-policy.js').SkillFile[]} files sorted regular files
 * @returns {Promise<string>} `sha256:<hex>`
 */
export async function hashFiles(files) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f.rel}\n${modeClass(f)}\n${f.size}\n`, 'utf8');
    await streamInto(h, f.abs);
    h.update('\n', 'utf8');
  }
  return `sha256:${h.digest('hex')}`;
}
