/**
 * Transactional materialization (adversarial-review CRITICALs: journal is an
 * unchecked filesystem-write program; recovery destroys evidence; MAJOR: staged
 * tree is never validated/hashed; target ancestry can escape the project).
 *
 * A mutation runs as one transaction under the project lock:
 *   1. STAGE   — generate each target's artifact into a private staging area,
 *                then SCAN + VALIDATE + HASH the STAGED tree (not the source) and
 *                fsync it. The staged hash is authoritative: it is what the
 *                manifest records / is verified against.
 *   2. JOURNAL — atomically write `.skillsync-txn.json` recording the complete
 *                next state as PROJECT-RELATIVE paths, plus this machine/project
 *                identity. Its presence means "a transaction is mid-flight".
 *   3. APPLY   — for each target: move any existing dir aside to a backup, then
 *                atomically rename the staged dir into place; then removals; then
 *                write the manifest LAST via atomic rename.
 *   4. CLEANUP — remove staging, backups, and the journal (only after full apply).
 *
 * Recovery is ROLL-FORWARD and FAIL-CLOSED. A journal is executed only after it
 * is authenticated (created by a skillsync transaction for THIS project on THIS
 * host) and every path is confined to allowed roots beneath the project with no
 * symlinked ancestor. A corrupt/foreign/malicious journal is never executed and
 * nothing is deleted. If roll-forward fails partway, staging/backups/journal are
 * PRESERVED for repair — never swept.
 *
 * @module materialize
 */

import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_TARGETS,
  BACKUP_PREFIX,
  MANIFEST_PATH,
  STAGE_PREFIX,
  TXN_FILE,
} from './constants.js';
import { writeExclude } from './exclude.js';
import { hashFiles } from './hash.js';
import { SkillsyncError } from './util.js';

/** Journal schema version (bumped from the pre-review absolute-path format). */
const JOURNAL_SCHEMA = 2;

/**
 * @typedef {Object} TargetWrite
 * @property {string} target repo-relative dir to materialize (e.g. ".claude/skills/foo")
 * @property {import('./input-policy.js').SkillFile[]} files files to place under it
 */

/**
 * @typedef {Object} StagedTarget
 * @property {string} target repo-relative destination dir
 * @property {string} stagedRel repo-relative path of the staged artifact
 * @property {string} hash authoritative `sha256:…` of the STAGED tree
 */

/**
 * @typedef {Object} Staged
 * @property {string} uid
 * @property {string} stageRel repo-relative staging root
 * @property {string} backupRel repo-relative backup root
 * @property {StagedTarget[]} targets
 */

/**
 * @typedef {Object} Journal
 * @property {number} schema
 * @property {string} txnId
 * @property {string} host os.hostname() of the creating machine
 * @property {string} project absolute project dir of the creating checkout
 * @property {string} stageRel
 * @property {string} backupRel
 * @property {string} manifest serialized manifest content
 * @property {string} manifestPath repo-relative manifest path
 * @property {{ stagedRel: string, targetRel: string, backupRel: string }[]} swaps
 * @property {{ targetRel: string, backupRel: string }[]} removals
 * @property {string[]|null} excludeEntries
 */

// ---------------------------------------------------------------------------
// Phase 1: STAGE — the adaptation/generation interface (#14 plugs in here).
// ---------------------------------------------------------------------------

/**
 * Generate + validate + hash staged artifacts for a set of targets. This is the
 * seam where per-agent adaptation produces the concrete bytes to materialize:
 * callers pass the file list to stage, and the STAGED tree is what gets hashed
 * and (later) atomically swapped in.
 * @param {string} projectDir
 * @param {TargetWrite[]} targetSpecs
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<Staged>}
 */
export async function stageTargets(projectDir, targetSpecs, onPhase) {
  const { scanSkillTree } = await import('./input-policy.js');
  const uid = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stageRel = `${STAGE_PREFIX}-${uid}`;
  const backupRel = `${BACKUP_PREFIX}-${uid}`;
  const stageDir = path.join(projectDir, stageRel);

  if (onPhase) await onPhase('stage');
  await fs.mkdir(stageDir, { recursive: true });

  /** @type {StagedTarget[]} */
  const targets = [];
  for (let i = 0; i < targetSpecs.length; i++) {
    const spec = targetSpecs[i];
    const stagedName = `t${i}`;
    const stagedAbs = path.join(stageDir, stagedName);
    await fs.mkdir(stagedAbs, { recursive: true });
    for (const f of spec.files) {
      await copyFile(f.abs, path.join(stagedAbs, f.rel), f.exec);
    }
    await fsyncDir(stagedAbs);
    // Authoritative: hash the STAGED tree we just wrote, not the source checkout.
    const staged = await scanSkillTree(stagedAbs);
    const hash = await hashFiles(staged);
    targets.push({ target: spec.target, stagedRel: `${stageRel}/${stagedName}`, hash });
  }
  await fsyncDir(stageDir);

  return { uid, stageRel, backupRel, targets };
}

// ---------------------------------------------------------------------------
// Phase 2+3+4: JOURNAL, APPLY, CLEANUP.
// ---------------------------------------------------------------------------

/**
 * Commit a staged set: authenticate the plan against the filesystem, journal it
 * durably, then apply it atomically. Assumes the project lock is held and
 * `recover()` has already run.
 * @param {string} projectDir
 * @param {{ staged: Staged, manifest: import('./manifest.js').Manifest, removeDirs: string[], excludeEntries: string[]|null }} plan
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<void>}
 */
export async function commitStaged(projectDir, plan, onPhase) {
  const { serializeManifest } = await import('./manifest.js');
  const { staged } = plan;

  /** @type {Journal} */
  const journal = {
    schema: JOURNAL_SCHEMA,
    txnId: staged.uid,
    host: os.hostname(),
    project: path.resolve(projectDir),
    stageRel: staged.stageRel,
    backupRel: staged.backupRel,
    manifest: serializeManifest(plan.manifest),
    manifestPath: MANIFEST_PATH,
    swaps: staged.targets.map((t) => ({
      stagedRel: t.stagedRel,
      targetRel: t.target,
      backupRel: `${staged.backupRel}/${swapKey(t.target)}`,
    })),
    removals: plan.removeDirs.map((target, i) => ({
      targetRel: target,
      backupRel: `${staged.backupRel}/r${i}`,
    })),
    excludeEntries: plan.excludeEntries,
  };

  // Authenticate + confine BEFORE journaling, so we never journal an unsafe or
  // cross-device plan (which would risk a partial, non-atomic apply).
  validateJournal(projectDir, journal);
  await assertJournalAncestorsSafe(projectDir, journal);
  await assertSameDevice(projectDir, journal);

  if (onPhase) await onPhase('journal');
  await fs.mkdir(path.join(projectDir, staged.backupRel), { recursive: true });
  await atomicWrite(path.join(projectDir, TXN_FILE), JSON.stringify(journal, null, 2));

  if (onPhase) await onPhase('apply');
  await applyJournal(projectDir, journal, onPhase);
}

/**
 * Convenience for callers whose manifest and output hashes are already known
 * (e.g. `init`/`remove`, which stage no targets). Stages then commits.
 * @param {string} projectDir
 * @param {{ manifest: import('./manifest.js').Manifest, targets: TargetWrite[], removeDirs: string[], excludeEntries: string[]|null }} plan
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<void>}
 */
export async function runTransaction(projectDir, plan, onPhase) {
  const staged = await stageTargets(projectDir, plan.targets, onPhase);
  await commitStaged(
    projectDir,
    {
      staged,
      manifest: plan.manifest,
      removeDirs: plan.removeDirs,
      excludeEntries: plan.excludeEntries,
    },
    onPhase,
  );
}

/**
 * Idempotently apply a validated journal, then clean up. Safe to re-run after a
 * crash. Throws (WITHOUT cleanup) if any rename fails, preserving all evidence.
 * @param {string} projectDir
 * @param {Journal} journal
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<void>}
 */
async function applyJournal(projectDir, journal, onPhase) {
  const abs = (rel) => path.join(projectDir, rel);

  for (let i = 0; i < journal.swaps.length; i++) {
    const s = journal.swaps[i];
    const stagedAbs = abs(s.stagedRel);
    const targetAbs = abs(s.targetRel);
    const backupAbs = abs(s.backupRel);
    if (await exists(stagedAbs)) {
      if (onPhase) await onPhase(`swap.${i}.pre-backup`);
      if ((await exists(targetAbs)) && !(await exists(backupAbs))) {
        await fs.mkdir(path.dirname(backupAbs), { recursive: true });
        await fs.rename(targetAbs, backupAbs);
      }
      if (onPhase) await onPhase(`swap.${i}.post-backup`);
      await fs.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.rename(stagedAbs, targetAbs);
      if (onPhase) await onPhase(`swap.${i}.post-rename`);
    }
    // staged gone => this swap already applied in a prior run.
  }

  for (let i = 0; i < journal.removals.length; i++) {
    const r = journal.removals[i];
    const targetAbs = abs(r.targetRel);
    const backupAbs = abs(r.backupRel);
    if ((await exists(targetAbs)) && !(await exists(backupAbs))) {
      await fs.mkdir(path.dirname(backupAbs), { recursive: true });
      await fs.rename(targetAbs, backupAbs);
    }
    if (onPhase) await onPhase(`removal.${i}.post`);
  }

  // Manifest LAST.
  if (onPhase) await onPhase('manifest');
  await fs.mkdir(path.dirname(abs(journal.manifestPath)), { recursive: true });
  await atomicWrite(abs(journal.manifestPath), journal.manifest);

  // Exclude handling (idempotent; lives under .git, outside the atomic set).
  if (journal.excludeEntries) {
    await writeExclude(projectDir, journal.excludeEntries);
  }

  // CLEANUP — only reached after a fully successful apply.
  if (onPhase) await onPhase('cleanup');
  await fs.rm(abs(journal.stageRel), { recursive: true, force: true });
  await fs.rm(abs(journal.backupRel), { recursive: true, force: true });
  await fs.rm(abs(TXN_FILE), { force: true });
}

/**
 * Roll forward any interrupted transaction. Call at command start under the lock.
 * @param {string} projectDir
 * @returns {Promise<boolean>} true if a transaction was recovered
 */
export async function recover(projectDir) {
  const journalPath = path.join(projectDir, TXN_FILE);
  let raw;
  try {
    raw = await fs.readFile(journalPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No transaction in flight. A pre-journal crash may have left staging
      // orphans (nothing was applied) — those are safe to sweep.
      await sweepOrphans(projectDir);
      return false;
    }
    throw err;
  }

  /** @type {Journal} */
  let journal;
  try {
    journal = JSON.parse(raw);
    validateJournal(projectDir, journal);
    await assertJournalAncestorsSafe(projectDir, journal);
  } catch (err) {
    // Unreadable / foreign / malicious journal. It may have been committed into
    // the repo from another machine or hand-crafted to escape the project. We do
    // NOT execute it and we delete NOTHING (we cannot prove how much, if any,
    // was applied). Fail closed with explicit repair guidance.
    throw new SkillsyncError(
      'JOURNAL_INVALID',
      `refusing to recover ${TXN_FILE}: ${err instanceof Error ? err.message : String(err)}. ` +
        `The transaction journal is corrupt, or was not created by a skillsync transaction for this project on this machine. ` +
        `Inspect it and, if you are sure no transaction is mid-flight, remove ${TXN_FILE} together with any ` +
        `${STAGE_PREFIX}-* / ${BACKUP_PREFIX}-* directories under .agents/, then retry.`,
    );
  }

  try {
    await applyJournal(projectDir, journal);
  } catch (err) {
    // Roll-forward failed partway (e.g. EXDEV / EACCES between swap steps).
    // PRESERVE journal, staging, and backups — they are the only recovery data.
    throw new SkillsyncError(
      'JOURNAL_APPLY_FAILED',
      `recovery of an in-flight transaction failed partway: ${err instanceof Error ? err.message : String(err)}. ` +
        `Staging (${journal.stageRel}), backups (${journal.backupRel}), and the journal have been PRESERVED for repair — do NOT delete them. ` +
        `Resolve the underlying filesystem error and re-run any mutating command to roll forward.`,
    );
  }
  return true;
}

/**
 * Structural + ownership validation of a journal (synchronous; no fs writes).
 * Throws on any problem. Confines every path to an allowed root beneath the
 * project and rejects journals not authored for this project on this host.
 * @param {string} projectDir
 * @param {unknown} j
 * @returns {asserts j is Journal}
 */
function validateJournal(projectDir, j) {
  if (j === null || typeof j !== 'object') throw new Error('journal is not an object');
  const journal = /** @type {Record<string, unknown>} */ (j);
  if (journal.schema !== JOURNAL_SCHEMA) throw new Error(`unsupported journal schema ${String(journal.schema)}`);
  if (journal.host !== os.hostname()) throw new Error('journal was created on a different host');
  if (typeof journal.project !== 'string' || path.resolve(journal.project) !== path.resolve(projectDir)) {
    throw new Error('journal was created for a different project directory');
  }
  if (journal.manifestPath !== MANIFEST_PATH) throw new Error('journal manifestPath is not the project manifest');
  if (typeof journal.manifest !== 'string') throw new Error('journal manifest content is missing');
  assertStageRoot(journal.stageRel, STAGE_PREFIX, 'stageRel');
  assertStageRoot(journal.backupRel, BACKUP_PREFIX, 'backupRel');

  if (!Array.isArray(journal.swaps)) throw new Error('journal swaps is not an array');
  for (const s of journal.swaps) {
    if (s === null || typeof s !== 'object') throw new Error('journal swap is not an object');
    assertRelUnder(s.stagedRel, journal.stageRel, 'swap.stagedRel');
    assertTargetRel(s.targetRel);
    assertRelUnder(s.backupRel, journal.backupRel, 'swap.backupRel');
  }
  if (!Array.isArray(journal.removals)) throw new Error('journal removals is not an array');
  for (const r of journal.removals) {
    if (r === null || typeof r !== 'object') throw new Error('journal removal is not an object');
    assertTargetRel(r.targetRel);
    assertRelUnder(r.backupRel, journal.backupRel, 'removal.backupRel');
  }
  if (journal.excludeEntries !== null && !Array.isArray(journal.excludeEntries)) {
    throw new Error('journal excludeEntries must be an array or null');
  }
}

/**
 * A materialization target must live directly under one of the known agent
 * skills roots (`.claude/skills/<name>` or `.agents/skills/<name>`), be
 * project-relative, and contain no `..` traversal.
 * @param {unknown} rel
 */
function assertTargetRel(rel) {
  if (typeof rel !== 'string' || rel === '') throw new Error('target path is empty');
  assertProjectRelative(rel);
  const roots = Object.values(AGENT_TARGETS);
  const ok = roots.some((root) => {
    if (!rel.startsWith(`${root}/`)) return false;
    const remainder = rel.slice(root.length + 1);
    // exactly one path segment (the skill dir) — no nesting, no empty.
    return remainder.length > 0 && !remainder.includes('/');
  });
  if (!ok) {
    throw new Error(`target ${JSON.stringify(rel)} is not under an allowed skills root (${roots.join(', ')})`);
  }
}

/**
 * A per-operation staging/backup ROOT is a single directory directly under
 * `.agents/`, named `<prefix>-<uid>` (a suffix sibling of the prefix, not a
 * slash-child). Validate that shape and confinement.
 * @param {unknown} rel
 * @param {string} prefix STAGE_PREFIX or BACKUP_PREFIX
 * @param {string} label
 */
function assertStageRoot(rel, prefix, label) {
  if (typeof rel !== 'string' || rel === '') throw new Error(`${label} is empty`);
  assertProjectRelative(rel);
  if (rel !== prefix && !rel.startsWith(`${prefix}-`)) {
    throw new Error(`${label} ${JSON.stringify(rel)} is not a ${JSON.stringify(prefix)} directory`);
  }
  if (rel.slice(prefix.length).includes('/')) {
    throw new Error(`${label} ${JSON.stringify(rel)} must be a single directory under .agents/`);
  }
}

/**
 * @param {unknown} rel
 * @param {string} prefix required path prefix (or exact match)
 * @param {string} label
 */
function assertRelUnder(rel, prefix, label) {
  if (typeof rel !== 'string' || rel === '') throw new Error(`${label} is empty`);
  assertProjectRelative(rel);
  if (rel !== prefix && !rel.startsWith(`${prefix}/`)) {
    throw new Error(`${label} ${JSON.stringify(rel)} escapes ${JSON.stringify(prefix)}`);
  }
}

/**
 * @param {string} rel
 */
function assertProjectRelative(rel) {
  if (path.isAbsolute(rel)) throw new Error(`path ${JSON.stringify(rel)} is absolute`);
  if (rel.includes('\\')) throw new Error(`path ${JSON.stringify(rel)} contains a backslash`);
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`path ${JSON.stringify(rel)} contains a traversal or empty segment`);
  }
}

/**
 * Reject any journal path whose existing ancestors include a symlink (which
 * could redirect a write outside the project) or a non-directory component.
 * @param {string} projectDir
 * @param {Journal} journal
 */
async function assertJournalAncestorsSafe(projectDir, journal) {
  const rels = new Set([journal.manifestPath, journal.stageRel, journal.backupRel]);
  for (const s of journal.swaps) rels.add(s.targetRel);
  for (const r of journal.removals) rels.add(r.targetRel);
  for (const rel of rels) await assertNoSymlinkAncestors(projectDir, rel);
}

/**
 * @param {string} projectDir
 * @param {string} rel POSIX project-relative path
 */
async function assertNoSymlinkAncestors(projectDir, rel) {
  const parts = rel.split('/');
  let cur = projectDir;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch {
      return; // does not exist yet — will be created beneath the (safe) project root
    }
    if (st.isSymbolicLink()) {
      throw new SkillsyncError(
        'UNSAFE_ANCESTOR',
        `refusing to operate through a symlinked path component: ${path.relative(projectDir, cur)}`,
      );
    }
    if (i < parts.length - 1 && !st.isDirectory()) {
      throw new SkillsyncError(
        'UNSAFE_ANCESTOR',
        `path component is not a directory: ${path.relative(projectDir, cur)}`,
      );
    }
  }
}

/**
 * Verify staging and every target/removal live on the SAME filesystem, so the
 * staged→target rename is a true atomic rename and can never fail with EXDEV
 * partway through the apply.
 * @param {string} projectDir
 * @param {Journal} journal
 */
async function assertSameDevice(projectDir, journal) {
  const stageDev = (await fs.stat(path.join(projectDir, journal.stageRel))).dev;
  const targetRels = [
    ...journal.swaps.map((s) => s.targetRel),
    ...journal.removals.map((r) => r.targetRel),
  ];
  for (const rel of targetRels) {
    const dev = await nearestExistingDev(path.join(projectDir, rel));
    if (dev !== stageDev) {
      throw new SkillsyncError(
        'CROSS_DEVICE',
        `target ${rel} resolves to a different filesystem than staging (a mounted/symlinked ancestor?); atomic rename is impossible`,
      );
    }
  }
}

/**
 * @param {string} target
 * @returns {Promise<number>} st.dev of the nearest existing ancestor of `target`
 */
async function nearestExistingDev(target) {
  let cur = target;
  for (;;) {
    try {
      return (await fs.stat(cur)).dev;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) throw new SkillsyncError('CROSS_DEVICE', `cannot stat any ancestor of ${target}`);
      cur = parent;
    }
  }
}

/**
 * Remove leftover staging/backup dirs when NO journal is present (a pre-journal
 * crash left nothing applied). Never called while a journal exists.
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

// ---------------------------------------------------------------------------
// File / dir primitives.
// ---------------------------------------------------------------------------

/**
 * Copy one file into staging using file descriptors: open the source, fstat it
 * to confirm it is a regular file at open time (defending against a source entry
 * swapped to a symlink/FIFO after the scan), stream the bytes, normalize the
 * mode class, and fsync before close.
 * @param {string} srcAbs
 * @param {string} destAbs
 * @param {boolean} exec
 */
async function copyFile(srcAbs, destAbs, exec) {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  // Confirm the source is a regular file at open time (defends against a source
  // entry swapped to a symlink/FIFO after the scan). The staged tree is re-scanned
  // and re-hashed after copying, so the recorded hash always reflects the bytes we
  // actually wrote.
  const probe = await fs.open(srcAbs, 'r');
  try {
    const st = await probe.stat();
    if (!st.isFile()) {
      throw new SkillsyncError('NON_REGULAR_REJECTED', `source is not a regular file at copy time: ${srcAbs}`);
    }
  } finally {
    await probe.close();
  }
  await new Promise((resolve, reject) => {
    const rs = createReadStream(srcAbs);
    const ws = createWriteStream(destAbs, { mode: exec ? 0o755 : 0o644 });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  await fs.chmod(destAbs, exec ? 0o755 : 0o644);
  // fsync the staged file for durability before the journal is written.
  const dfh = await fs.open(destAbs, 'r');
  try {
    await dfh.sync();
  } catch {
    // best-effort; directory fsync still provides ordering for the rename
  } finally {
    await dfh.close();
  }
}

/**
 * fsync a directory so a preceding rename/create is durable. Best-effort:
 * platforms that reject directory fsync are tolerated.
 * @param {string} dir
 */
async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
  } catch {
    return;
  }
  try {
    await fh.sync();
  } catch {
    // EISDIR/EINVAL/EPERM on some platforms — durability is best-effort here.
  } finally {
    await fh.close();
  }
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
  await fsyncDir(path.dirname(filePath));
}

/**
 * Hash a materialized target dir back off disk (drift/verification). Propagates
 * ENOENT for an absent dir and SkillsyncError for an anomalous one, so callers
 * can distinguish "missing" from "anomaly".
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function hashMaterialized(dir) {
  const { scanSkillTree } = await import('./input-policy.js');
  const files = await scanSkillTree(dir);
  return hashFiles(files);
}

/**
 * Stable per-target backup key derived from the target path (deterministic so a
 * recovered apply reuses the same backup slot).
 * @param {string} targetRel
 * @returns {string}
 */
function swapKey(targetRel) {
  return targetRel.replace(/[^a-zA-Z0-9]+/g, '_');
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
