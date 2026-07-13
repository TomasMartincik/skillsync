/**
 * Project-scoped exclusive lock (adversarial-review CRITICAL: no concurrency model).
 *
 * Uses `mkdir` for atomic acquisition — it fails if the directory already exists,
 * which is the classic race-free lock primitive on POSIX and Windows alike. The
 * lock records the holder's pid so a stale lock from a dead process can be
 * reclaimed.
 *
 * @module lock
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LOCK_DIR } from './constants.js';
import { SkillsyncError } from './util.js';

/**
 * @typedef {Object} Lock
 * @property {() => Promise<void>} release
 */

/**
 * Acquire the project lock. Throws LOCKED if another live process holds it.
 * @param {string} projectDir
 * @returns {Promise<Lock>}
 */
export async function acquireLock(projectDir) {
  const dir = path.join(projectDir, LOCK_DIR);
  const pidFile = path.join(dir, 'pid');
  await fs.mkdir(path.dirname(dir), { recursive: true }); // ensure `.agents/` exists
  try {
    await fs.mkdir(dir, { recursive: false });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      if (await isStale(pidFile)) {
        await fs.rm(dir, { recursive: true, force: true });
        return acquireLock(projectDir);
      }
      throw new SkillsyncError('LOCKED', 'another skillsync operation is in progress in this project');
    }
    throw err;
  }
  await fs.writeFile(pidFile, String(process.pid), 'utf8');
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} pidFile
 * @returns {Promise<boolean>} true if the recorded pid is not a running process
 */
async function isStale(pidFile) {
  let pid;
  try {
    pid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);
  } catch {
    return true; // no/unreadable pid file => treat as stale
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 only checks existence
    return false; // process alive => not stale
  } catch (err) {
    return err && err.code === 'ESRCH'; // no such process => stale
  }
}
