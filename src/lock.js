/**
 * Project-scoped exclusive lock (adversarial-review CRITICAL: unsafe acquisition
 * and incomplete coverage).
 *
 * Acquisition is race-free by ATOMIC PUBLISH: we build a fully-populated temp
 * directory containing a `meta.json` (random ownership token + pid + host), then
 * `rename()` it onto the lock path. `rename` onto an already-populated directory
 * fails, so exactly one contender can ever win, and the lock is NEVER visible in
 * a half-created state — closing the "pid file not yet written ⇒ looks stale"
 * race of the previous `mkdir`-then-`writeFile` design.
 *
 * Acquisition BLOCKS (polls) until the lock is free or a timeout elapses, so two
 * concurrent commands queue and both complete instead of one failing. A lock is
 * reclaimed only when its recorded pid is provably dead ON THE SAME HOST; reclaim
 * itself is race-safe (rename-aside, single winner). Release removes the lock
 * only if the on-disk token still matches ours, so a process that was wrongly
 * deemed stale can never delete a lock another process now owns.
 *
 * @module lock
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { LOCK_DIR } from './constants.js';
import { SkillsyncError } from './util.js';

const DEFAULT_TIMEOUT_MS = envInt('SKILLSYNC_LOCK_TIMEOUT_MS', 30_000);
const POLL_MS = envInt('SKILLSYNC_LOCK_POLL_MS', 40);

/**
 * @typedef {Object} Lock
 * @property {string} token this holder's random ownership token
 * @property {() => Promise<void>} release
 */

/**
 * Acquire the project lock, waiting up to the timeout for a concurrent holder to
 * release. Throws LOCKED only if the timeout elapses while a *live* process holds
 * it.
 * @param {string} projectDir
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Lock>}
 */
export async function acquireLock(projectDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dir = path.join(projectDir, LOCK_DIR);
  const metaFile = path.join(dir, 'meta.json');
  const token = randomBytes(16).toString('hex');
  const meta = { token, pid: process.pid, host: os.hostname(), time: Date.now() };

  await fs.mkdir(path.dirname(dir), { recursive: true }); // ensure `.agents/` exists
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const tmp = `${dir}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta), 'utf8');
    try {
      await fs.rename(tmp, dir); // atomic; fails if `dir` already populated
      return makeLock(dir, metaFile, token);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      if (!isExistsError(err)) throw err;
    }

    // Held by someone else. Reclaim if provably dead, otherwise wait.
    if (await tryReclaimIfStale(dir, metaFile)) continue;
    if (Date.now() >= deadline) {
      throw new SkillsyncError(
        'LOCKED',
        'another skillsync operation is in progress in this project (timed out waiting for the lock)',
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * @param {string} dir
 * @param {string} metaFile
 * @param {string} token
 * @returns {Lock}
 */
function makeLock(dir, metaFile, token) {
  let released = false;
  return {
    token,
    async release() {
      if (released) return;
      released = true;
      // Remove the lock only if it is still OURS. If we were wrongly reclaimed as
      // stale and another process now holds it, its token differs and we leave it.
      try {
        const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
        if (meta && meta.token === token) {
          await fs.rm(dir, { recursive: true, force: true });
        }
      } catch {
        // meta unreadable/gone: nothing that is safely ours to remove.
      }
    },
  };
}

/**
 * Reclaim the lock if its recorded holder is provably dead on this host. The
 * reclaim is race-safe: we rename the stale lock aside (atomic, single winner)
 * then delete it, so concurrent reclaimers do not stomp each other.
 * @param {string} dir
 * @param {string} metaFile
 * @returns {Promise<boolean>} true if reclaimed (caller should retry immediately)
 */
async function tryReclaimIfStale(dir, metaFile) {
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  } catch {
    // Missing/corrupt meta. Atomic publish means this should not happen for a
    // live lock; fail closed (wait) rather than steal a lock we cannot reason
    // about — the acquire timeout still bounds the wait.
    return false;
  }
  if (!isStaleMeta(meta)) return false;

  const trash = `${dir}.stale-${randomBytes(6).toString('hex')}`;
  try {
    await fs.rename(dir, trash);
  } catch {
    return false; // someone else already moved/reclaimed it
  }
  await fs.rm(trash, { recursive: true, force: true });
  return true;
}

/**
 * @param {any} meta
 * @returns {boolean}
 */
function isStaleMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.host !== os.hostname()) return false; // cross-host: cannot probe pid; never steal
  const pid = meta.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false; // our own lock is not stale
  try {
    process.kill(pid, 0); // signal 0 only tests existence
    return false; // process alive => held, not stale
  } catch (err) {
    return Boolean(err && err.code === 'ESRCH'); // no such process => stale
  }
}

/**
 * @param {any} err
 * @returns {boolean}
 */
function isExistsError(err) {
  return Boolean(err && (err.code === 'EEXIST' || err.code === 'ENOTEMPTY' || err.code === 'EPERM'));
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} name
 * @param {number} dflt
 * @returns {number}
 */
function envInt(name, dflt) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(v) && v >= 0 ? v : dflt;
}
