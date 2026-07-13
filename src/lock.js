/**
 * Project-scoped exclusive lock (adversarial-review CRITICAL: unsafe acquisition
 * and incomplete coverage; MINOR: temp-dir leak, EPERM misclassification; MAJOR:
 * PID reuse strands the lock).
 *
 * Acquisition is race-free by ATOMIC PUBLISH: we build a fully-populated temp
 * directory containing a `meta.json` (random ownership token + pid + host +
 * process start identity), then `rename()` it onto the lock path. `rename` onto an
 * already-populated directory fails, so exactly one contender can ever win, and
 * the lock is NEVER visible half-created.
 *
 * Acquisition BLOCKS (polls) until the lock is free or a timeout elapses. A lock
 * is reclaimed only when its recorded holder is provably gone ON THE SAME HOST:
 * either the pid no longer exists, or the pid exists but its process START TIME
 * differs from the recorded one (the pid was reused by an unrelated process). When
 * liveness cannot be verified and the lock is older than a conservative age, the
 * timeout error explains the manual-recovery path rather than stealing it.
 *
 * @module lock
 */

import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { LOCK_DIR } from './constants.js';
import { SkillsyncError } from './util.js';

const DEFAULT_TIMEOUT_MS = envInt('SKILLSYNC_LOCK_TIMEOUT_MS', 30_000);
const POLL_MS = envInt('SKILLSYNC_LOCK_POLL_MS', 40);
/** A lock older than this whose holder liveness cannot be verified is reported as suspected-stale. */
const MAX_AGE_MS = envInt('SKILLSYNC_LOCK_MAX_AGE_MS', 3_600_000);

/**
 * @typedef {Object} Lock
 * @property {string} token this holder's random ownership token
 * @property {() => Promise<void>} release
 */

/**
 * Acquire the project lock, waiting up to the timeout for a concurrent holder to
 * release.
 * @param {string} projectDir
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Lock>}
 */
export async function acquireLock(projectDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dir = path.join(projectDir, LOCK_DIR);
  const metaFile = path.join(dir, 'meta.json');
  const token = randomBytes(16).toString('hex');
  const meta = {
    token,
    pid: process.pid,
    host: os.hostname(),
    time: Date.now(),
    start: procStartTime(process.pid),
  };

  await fs.mkdir(path.dirname(dir), { recursive: true }); // ensure `.agents/` exists
  await sweepLockTempOrphans(path.dirname(dir)); // clean crashed temp/stale dirs
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const tmp = `${dir}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    // Exclusive create: never reuse a colliding directory.
    await fs.mkdir(tmp);
    try {
      await fs.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta), 'utf8');
      await fs.rename(tmp, dir); // atomic; fails if `dir` already populated
      return makeLock(dir, metaFile, token);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      // Real permission failures must surface immediately, not masquerade as a
      // held lock and burn the whole timeout (MINOR: EPERM misclassified).
      if (err && err.code === 'EPERM') throw err;
      if (!isCollisionError(err)) throw err;
    }

    // Held by someone else. Reclaim if provably gone, otherwise wait.
    if (await tryReclaimIfStale(dir, metaFile)) continue;
    if (Date.now() >= deadline) throw lockedError(metaFile);
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
 * Reclaim the lock if its recorded holder is provably gone on this host.
 * @param {string} dir
 * @param {string} metaFile
 * @returns {Promise<boolean>} true if reclaimed (caller should retry immediately)
 */
async function tryReclaimIfStale(dir, metaFile) {
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  } catch {
    return false; // missing/corrupt meta for a live lock should not happen; wait.
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
  if (meta.host !== os.hostname()) return false; // cross-host: cannot probe; never steal
  const pid = meta.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false; // our own lock is not stale
  let alive;
  try {
    process.kill(pid, 0); // signal 0 only tests existence
    alive = true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return true; // no such process => stale
    return false; // EPERM etc.: exists but not ours to probe — treat as held
  }
  if (!alive) return true;
  // The pid exists. If we recorded a process start time and can read the current
  // one, a MISMATCH means the pid was reused by an unrelated process => stale.
  if (typeof meta.start === 'string' && meta.start) {
    const now = procStartTime(pid);
    if (now && now !== meta.start) return true;
  }
  return false; // genuinely alive (or unverifiable) => held
}

/**
 * Best-effort process start identity, used to detect PID reuse. Linux: field 22
 * of /proc/<pid>/stat (jiffies since boot). macOS/BSD: `ps -o lstart`. Returns
 * null when unavailable — callers then fall back to the age-based message.
 * @param {number} pid
 * @returns {string|null}
 */
export function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = stat.lastIndexOf(')');
    if (rparen !== -1) {
      const fields = stat.slice(rparen + 2).trim().split(/\s+/);
      // After ')' the next field is `state` (field 3); starttime is field 22.
      const starttime = fields[19];
      if (starttime) return `l:${starttime}`;
    }
  } catch {
    // not Linux, or no /proc — fall through
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? `p:${out}` : null;
  } catch {
    return null;
  }
}

/**
 * Build the acquire-timeout error. If the holder's liveness could not be verified
 * and the lock is old, point at manual recovery instead of an opaque timeout.
 * @param {string} metaFile
 * @returns {SkillsyncError}
 */
function lockedError(metaFile) {
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  } catch {
    // fall through with generic message
  }
  const dir = path.dirname(metaFile);
  if (
    meta &&
    typeof meta.time === 'number' &&
    Date.now() - meta.time > MAX_AGE_MS &&
    (!meta.start || !procStartTime(meta.pid))
  ) {
    return new SkillsyncError(
      'LOCK_STALE_SUSPECTED',
      `the project lock has been held since ${new Date(meta.time).toISOString()} by pid ${meta.pid} on ` +
        `${meta.host}, and its liveness cannot be verified on this machine. If no skillsync operation is ` +
        `actually running, remove the lock directory manually: rm -rf ${JSON.stringify(dir)}`,
    );
  }
  return new SkillsyncError(
    'LOCKED',
    'another skillsync operation is in progress in this project (timed out waiting for the lock)',
  );
}

/**
 * Remove crashed lock temp/stale directories left under `.agents/` by a process
 * that died between `mkdir` and `rename` (MINOR: temp-dir leak). Conservative:
 * only sweeps `.skillsync.lock.tmp-*` / `.skillsync.lock.stale-*` older than a
 * few seconds, so a live acquirer's in-flight temp dir is never removed.
 * @param {string} agentsDir
 */
async function sweepLockTempOrphans(agentsDir) {
  const base = path.basename(LOCK_DIR);
  let entries;
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(`${base}.tmp-`) && !name.startsWith(`${base}.stale-`)) continue;
    const abs = path.join(agentsDir, name);
    try {
      const st = await fs.lstat(abs);
      if (now - st.mtimeMs > 5_000) await fs.rm(abs, { recursive: true, force: true });
    } catch {
      // gone already / racing another sweeper — ignore
    }
  }
}

/**
 * A `rename`-onto-populated-directory collision (someone else holds the lock).
 * @param {any} err
 * @returns {boolean}
 */
function isCollisionError(err) {
  return Boolean(err && (err.code === 'EEXIST' || err.code === 'ENOTEMPTY'));
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
