/**
 * Durability primitives (round-3 review MINOR: unsupported-fsync platforms failed
 * with a raw, unactionable error).
 *
 * skillsync's crash-safety claim rests on fsync: every staged regular file is
 * fsynced before it is journaled, and every directory whose entry changed by a
 * create/rename is fsynced before the transaction progresses. A filesystem that
 * cannot honor those calls cannot honor the guarantee, so we FAIL — but with a
 * clear `DURABILITY_UNSUPPORTED` error naming the path and the platform code,
 * never a raw errno escaping from deep inside the transaction.
 *
 * The one tolerated case is a directory fsync the platform treats as a no-op
 * (`EINVAL`/`ENOTSUP`): the directory entry is durable without the call.
 *
 * @module durable
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SkillsyncError } from './util.js';

/**
 * Directory-fsync codes that mean "this platform does not need/allow an explicit
 * directory sync"; the metadata is durable regardless. Tolerated silently.
 */
const DIR_FSYNC_NOOP = new Set(['EINVAL', 'ENOTSUP']);

/**
 * Codes that mean "this platform/filesystem cannot provide the durability
 * skillsync requires" (as opposed to EIO/ENOSPC, which are real I/O failures and
 * must surface raw).
 */
const UNSUPPORTED = new Set(['EPERM', 'EACCES', 'EISDIR', 'ENOSYS', 'EOPNOTSUPP', 'EBADF', 'ENOTTY']);

/**
 * @param {any} err
 * @param {string} p
 * @param {string} what "file" | "directory"
 * @returns {SkillsyncError}
 */
function durabilityError(err, p, what) {
  return new SkillsyncError(
    'DURABILITY_UNSUPPORTED',
    `cannot fsync ${what} ${JSON.stringify(p)} on this filesystem (${err.code}). skillsync's crash-safe ` +
      `transaction requires fsync on regular files and on the directories it renames into; a filesystem ` +
      `that rejects it cannot provide that guarantee. Local filesystems (APFS, HFS+, ext4, xfs, btrfs, tmpfs) ` +
      `are supported; some network/FUSE mounts and restricted sandboxes are not. Move the project onto a ` +
      `supported filesystem (or grant the sandbox permission to open directories) and retry.`,
  );
}

/**
 * fsync a directory so a preceding create/rename is durable. A missing directory
 * is tolerated (nothing to make durable); an unsupported platform is reported as
 * DURABILITY_UNSUPPORTED; every other error is fatal and raw.
 * @param {string} dir
 */
export async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    if (err && UNSUPPORTED.has(err.code)) throw durabilityError(err, dir, 'directory');
    throw err;
  }
  try {
    await fh.sync();
  } catch (err) {
    if (err && DIR_FSYNC_NOOP.has(err.code)) return; // platform no-op: entry is already durable
    if (err && UNSUPPORTED.has(err.code)) throw durabilityError(err, dir, 'directory');
    throw err;
  } finally {
    await fh.close();
  }
}

/**
 * fsync the immediate parent directory of a path (durability for a rename/create
 * whose directory entry must survive a crash).
 * @param {string} p
 * @returns {Promise<void>}
 */
export function fsyncParent(p) {
  return fsyncDir(path.dirname(p));
}

/**
 * fsync an open regular-file handle. Never silently ignored: a durability failure
 * on a regular file means the bytes we are about to journal/commit may not exist
 * after a crash.
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {string} p path (for diagnostics)
 */
export async function fsyncHandle(fh, p) {
  try {
    await fh.sync();
  } catch (err) {
    if (err && UNSUPPORTED.has(err.code)) throw durabilityError(err, p, 'file');
    throw err;
  }
}

/**
 * Open, fsync, and close a regular file by path.
 * @param {string} p
 */
export async function fsyncFile(p) {
  const fh = await fs.open(p, 'r');
  try {
    await fsyncHandle(fh, p);
  } finally {
    await fh.close();
  }
}
