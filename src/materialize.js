/**
 * Transactional materialization (adversarial-review CRITICAL: no transaction or
 * concurrency model).
 *
 * A mutation runs as one transaction:
 *   1. STAGE   — copy each target dir's files into a private staging area and
 *                validate/hash them there; nothing under the project's live
 *                skill dirs is touched yet.
 *   2. JOURNAL — write `.skillsync-txn.json` atomically. It records the complete
 *                next state: the final manifest string and every swap/removal.
 *                Its presence means "a transaction is mid-flight".
 *   3. APPLY   — for each target: move any existing dir aside to a backup, then
 *                atomically rename the staged dir into place; then remove dirs;
 *                then write the manifest LAST via atomic rename.
 *   4. CLEANUP — remove staging, backups, and the journal.
 *
 * Recovery is ROLL-FORWARD: because the journal is written only after staging is
 * complete and durable, `recover()` simply re-runs APPLY (which is idempotent)
 * and CLEANUP, deterministically completing whatever was interrupted. All target
 * renames are same-filesystem (staging lives under `.agents/`), so they are
 * atomic.
 *
 * @module materialize
 */

import { promises as fs } from 'node:fs';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { BACKUP_PREFIX, STAGE_PREFIX, TXN_FILE } from './constants.js';
import { writeExclude } from './exclude.js';
import { hashFiles } from './hash.js';

/**
 * @typedef {Object} TargetWrite
 * @property {string} target repo-relative dir to materialize (e.g. ".claude/skills/foo")
 * @property {import('./input-policy.js').SkillFile[]} files files to place under it
 */

/**
 * @typedef {Object} Plan
 * @property {import('./manifest.js').Manifest} manifest final manifest to write last
 * @property {TargetWrite[]} targets dirs to (re)materialize
 * @property {string[]} removeDirs existing dirs to delete
 * @property {string[]|null} excludeEntries gitignored-mode entries, or null to skip
 */

/**
 * @typedef {Object} Journal
 * @property {string} stageDir
 * @property {string} backupDir
 * @property {string} manifest serialized manifest content
 * @property {string} manifestPath
 * @property {{ staged: string, target: string, backup: string }[]} swaps
 * @property {{ target: string, backup: string }[]} removals
 * @property {string[]|null} excludeEntries
 */

const MANIFEST_REL = '.agents/skills-manifest.json';

/**
 * Execute a plan as a single transaction. Assumes the project lock is held and
 * `recover()` has already run.
 * @param {string} projectDir
 * @param {Plan} plan
 * @param {(phase: string) => void|Promise<void>} [onPhase] test hook fired before each phase
 * @returns {Promise<void>}
 */
export async function runTransaction(projectDir, plan, onPhase) {
  const uid = `${process.pid}-${Date.now()}`;
  const stageDir = path.join(projectDir, `${STAGE_PREFIX}-${uid}`);
  const backupDir = path.join(projectDir, `${BACKUP_PREFIX}-${uid}`);

  // 1. STAGE
  if (onPhase) await onPhase('stage');
  await fs.mkdir(stageDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  /** @type {Journal['swaps']} */
  const swaps = [];
  for (let i = 0; i < plan.targets.length; i++) {
    const t = plan.targets[i];
    const staged = path.join(stageDir, `t${i}`);
    await copyTree(staged, t.files);
    swaps.push({
      staged,
      target: path.join(projectDir, t.target),
      backup: path.join(backupDir, `t${i}`),
    });
  }
  /** @type {Journal['removals']} */
  const removals = plan.removeDirs.map((target, i) => ({
    target: path.join(projectDir, target),
    backup: path.join(backupDir, `r${i}`),
  }));

  const { serializeManifest } = await import('./manifest.js');
  /** @type {Journal} */
  const journal = {
    stageDir,
    backupDir,
    manifest: serializeManifest(plan.manifest),
    manifestPath: path.join(projectDir, MANIFEST_REL),
    swaps,
    removals,
    excludeEntries: plan.excludeEntries,
  };

  // 2. JOURNAL (atomic)
  if (onPhase) await onPhase('journal');
  const journalPath = path.join(projectDir, TXN_FILE);
  await atomicWrite(journalPath, JSON.stringify(journal, null, 2));

  // 3. APPLY + 4. CLEANUP
  if (onPhase) await onPhase('apply');
  await applyJournal(projectDir, journal, onPhase);
}

/**
 * Idempotently apply a journal, then clean up. Safe to re-run after a crash.
 * @param {string} projectDir
 * @param {Journal} journal
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<void>}
 */
async function applyJournal(projectDir, journal, onPhase) {
  for (const s of journal.swaps) {
    if (await exists(s.staged)) {
      if ((await exists(s.target)) && !(await exists(s.backup))) {
        await fs.mkdir(path.dirname(s.backup), { recursive: true });
        await fs.rename(s.target, s.backup);
      }
      await fs.mkdir(path.dirname(s.target), { recursive: true });
      await fs.rename(s.staged, s.target);
    }
    // staged gone => this swap already applied in a prior run.
  }
  for (const r of journal.removals) {
    if ((await exists(r.target)) && !(await exists(r.backup))) {
      await fs.mkdir(path.dirname(r.backup), { recursive: true });
      await fs.rename(r.target, r.backup);
    }
  }

  // Manifest LAST.
  if (onPhase) await onPhase('manifest');
  await fs.mkdir(path.dirname(journal.manifestPath), { recursive: true });
  await atomicWrite(journal.manifestPath, journal.manifest);

  // Exclude handling (idempotent; lives under .git, outside the atomic set).
  if (journal.excludeEntries) {
    await writeExclude(projectDir, journal.excludeEntries);
  }

  // CLEANUP
  if (onPhase) await onPhase('cleanup');
  await fs.rm(journal.stageDir, { recursive: true, force: true });
  await fs.rm(journal.backupDir, { recursive: true, force: true });
  await fs.rm(path.join(projectDir, TXN_FILE), { force: true });
}

/**
 * Roll forward any interrupted transaction. Call at command start under the lock.
 * Also sweeps orphan staging/backup dirs left by a crash before journaling.
 * @param {string} projectDir
 * @returns {Promise<boolean>} true if a transaction was recovered
 */
export async function recover(projectDir) {
  const journalPath = path.join(projectDir, TXN_FILE);
  let recovered = false;
  try {
    const raw = await fs.readFile(journalPath, 'utf8');
    /** @type {Journal} */
    const journal = JSON.parse(raw);
    await applyJournal(projectDir, journal);
    recovered = true;
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      // Corrupt journal: remove it so the project is usable; the interrupted
      // op left a validated-but-unswapped staging area — safe to discard.
      await fs.rm(journalPath, { force: true });
    }
  }
  await sweepOrphans(projectDir);
  return recovered;
}

/**
 * Remove leftover staging/backup dirs when no journal is present.
 * @param {string} projectDir
 */
async function sweepOrphans(projectDir) {
  const agentsDir = path.join(projectDir, '.agents');
  let entries;
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return;
  }
  const stageBase = path.basename(STAGE_PREFIX);
  const backupBase = path.basename(BACKUP_PREFIX);
  for (const name of entries) {
    if (name.startsWith(stageBase) || name.startsWith(backupBase)) {
      await fs.rm(path.join(agentsDir, name), { recursive: true, force: true });
    }
  }
}

/**
 * Copy a validated file list into `destRoot`, preserving relative layout and
 * normalizing mode to a deterministic class (0o755 exec / 0o644 non-exec).
 * @param {string} destRoot
 * @param {import('./input-policy.js').SkillFile[]} files
 */
async function copyTree(destRoot, files) {
  for (const f of files) {
    const dest = path.join(destRoot, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await streamCopy(f.abs, dest);
    await fs.chmod(dest, f.exec ? 0o755 : 0o644);
  }
}

/**
 * Stream-copy a file (bounded memory regardless of size).
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
function streamCopy(src, dest) {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(src);
    const ws = createWriteStream(dest);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

/**
 * Atomically write a file: temp in the same dir, fsync, rename over the target.
 * @param {string} filePath
 * @param {string} content
 */
async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Hash a materialized target dir back off disk (drift/verification).
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function hashMaterialized(dir) {
  const { scanSkillTree } = await import('./input-policy.js');
  const files = await scanSkillTree(dir);
  return hashFiles(files);
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
