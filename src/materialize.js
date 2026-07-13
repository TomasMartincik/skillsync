/**
 * Transactional materialization (adversarial-review CRITICALs: journal is an
 * unchecked filesystem-write program; recovery destroys evidence and trusts
 * missing/modified staging; durability failures are ignored; MAJOR: staged tree
 * is never validated/hashed; target ancestry can escape the project).
 *
 * A mutation runs as one transaction under the project lock:
 *   1. STAGE   — generate each target's artifact into a private staging area,
 *                then SCAN + VALIDATE + HASH the STAGED tree (not the source) and
 *                fsync it (files AND every nested directory). The staged hash is
 *                authoritative: it is what the manifest records / is verified
 *                against, and it is what recovery revalidates before every swap.
 *   2. JOURNAL — atomically write `.skillsync-txn.json` recording the complete
 *                next state as PROJECT-RELATIVE paths, the authoritative staged
 *                hash per swap, and a MAC over the whole body under the machine
 *                secret. Its presence means "a transaction is mid-flight".
 *   3. APPLY   — for each target: revalidate the staged hash, move any existing
 *                dir aside to a backup, then atomically rename the staged dir into
 *                place; then removals; then write the manifest LAST via atomic
 *                rename. Every rename parent is fsynced before progressing.
 *   4. CLEANUP — remove staging, backups, and the journal (only after full apply).
 *
 * Recovery is ROLL-FORWARD and FAIL-CLOSED. A journal is executed only after it
 * is AUTHENTICATED (a valid MAC under this machine's secret) and every concrete
 * path is confined to allowed roots beneath the project with no symlinked
 * ancestor, on the same filesystem. When staging is present its hash is
 * revalidated before the swap; when staging is ABSENT the live target hash is
 * verified before a swap is treated as complete — "staging missing" is NEVER
 * taken as proof of completion. A corrupt/foreign/tampered journal, or any
 * ambiguity, is never executed and nothing is deleted (evidence is preserved).
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
import { getSecret, journalMac, verifyJournalMac } from './secret.js';
import { SkillsyncError } from './util.js';

/** Journal schema version (v3: authenticated MAC + per-swap staged hashes). */
const JOURNAL_SCHEMA = 3;

/** `.agents/` — the only directory skillsync creates working files under. */
const AGENTS_DIR = '.agents';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Directory-fsync error codes that are tolerated because the platform/filesystem
 * does not support fsync on a directory descriptor. Everything else is fatal.
 */
const DIR_FSYNC_IGNORE = new Set(['EINVAL', 'ENOTSUP']);

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
 * @property {string} host os.hostname() of the creating machine (diagnostic only)
 * @property {string} project absolute project dir of the creating checkout (diagnostic only)
 * @property {string} stageRel
 * @property {string} backupRel
 * @property {string} manifest serialized manifest content
 * @property {string} manifestPath repo-relative manifest path
 * @property {{ stagedRel: string, targetRel: string, backupRel: string, stagedHash: string }[]} swaps
 * @property {{ targetRel: string, backupRel: string }[]} removals
 * @property {string[]|null} excludeEntries
 * @property {string} [mac] hex HMAC over the body (added last)
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
    /** @type {Set<string>} */
    const nestedDirs = new Set();
    for (const f of spec.files) {
      await copyFile(f.abs, path.join(stagedAbs, f.rel), f.exec);
      // Record every intermediate directory so it can be fsynced for durability.
      let d = path.dirname(f.rel);
      while (d && d !== '.' && d !== '/') {
        nestedDirs.add(d);
        d = path.dirname(d);
      }
    }
    // fsync every created nested directory (deepest first), then the target root.
    for (const rel of [...nestedDirs].sort((a, b) => b.length - a.length)) {
      await fsyncDir(path.join(stagedAbs, rel));
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
 * durably (with a MAC), then apply it atomically. Assumes the project lock is
 * held and `recover()` has already run.
 * @param {string} projectDir
 * @param {{ staged: Staged, manifest: import('./manifest.js').Manifest, removeDirs: string[], excludeEntries: string[]|null }} plan
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<void>}
 */
export async function commitStaged(projectDir, plan, onPhase) {
  const { serializeManifest, validateManifest } = await import('./manifest.js');
  const { staged } = plan;

  // Validate the COMPLETE next manifest before we journal it — never write a
  // journal carrying a manifest the tool would later refuse to read (MAJOR:
  // duplicate --agents produced an unreadable manifest).
  validateManifest(plan.manifest);

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
      stagedHash: t.hash,
    })),
    removals: plan.removeDirs.map((target, i) => ({
      targetRel: target,
      backupRel: `${staged.backupRel}/r${i}`,
    })),
    excludeEntries: plan.excludeEntries,
  };

  // Authenticate + confine BEFORE journaling, so we never journal an unsafe or
  // cross-device plan (which would risk a partial, non-atomic apply).
  await assertContainerSafe(projectDir);
  validateJournal(projectDir, journal);
  await assertJournalAncestorsSafe(projectDir, journal);
  await assertSameDevice(projectDir, journal);

  // MAC the journal body under the machine secret.
  const secret = await getSecret();
  journal.mac = journalMac(secret, journal);

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
 * crash. Throws (WITHOUT cleanup) on any rename failure, staged-hash mismatch, or
 * ambiguous state, preserving all evidence.
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
      // Revalidate the staged tree against the journaled authoritative hash BEFORE
      // installing it — a staged file modified after journaling (or a durability
      // failure that truncated it) must never be swapped in (CRITICAL: recovery
      // trusted modified staging).
      const actual = await hashMaterialized(stagedAbs).catch((err) => {
        throw ambiguity(journal, `staged tree ${s.stagedRel} could not be validated: ${errMsg(err)}`);
      });
      if (actual !== s.stagedHash) {
        throw ambiguity(
          journal,
          `staged tree ${s.stagedRel} hash ${actual} != journaled ${s.stagedHash} (tampered or partially written)`,
        );
      }

      if (onPhase) await onPhase(`swap.${i}.pre-backup`);
      // Re-validate + create the target parent right before the rename to shrink
      // the check/use window against a symlinked ancestor swapped in post-journal.
      await ensureDirNoSymlink(projectDir, path.dirname(s.targetRel));
      if ((await exists(targetAbs)) && !(await exists(backupAbs))) {
        await ensureDirNoSymlink(projectDir, path.dirname(s.backupRel));
        await fs.rename(targetAbs, backupAbs);
        await fsyncParent(targetAbs);
        await fsyncParent(backupAbs);
      }
      if (onPhase) await onPhase(`swap.${i}.post-backup`);
      await fs.rename(stagedAbs, targetAbs);
      await fsyncParent(targetAbs);
      await fsyncParent(stagedAbs);
      if (onPhase) await onPhase(`swap.${i}.post-rename`);
    } else {
      // Staging is ABSENT. Do NOT assume the swap already applied. Prove it by the
      // live target hash; anything else is ambiguous and preserved for repair
      // (CRITICAL: "staging missing" is not proof of completion).
      const live = await hashMaterialized(targetAbs).catch((err) => {
        if (err && err.code === 'ENOENT') return null;
        throw ambiguity(journal, `target ${s.targetRel} is anomalous during recovery: ${errMsg(err)}`);
      });
      if (live === s.stagedHash) continue; // swap genuinely completed on a prior run
      throw ambiguity(
        journal,
        `staging ${s.stagedRel} is gone but target ${s.targetRel} ` +
          (live === null ? 'is absent' : `hash ${live} != expected ${s.stagedHash}`) +
          ` — cannot prove the swap completed`,
      );
    }
  }

  for (let i = 0; i < journal.removals.length; i++) {
    const r = journal.removals[i];
    const targetAbs = abs(r.targetRel);
    const backupAbs = abs(r.backupRel);
    if ((await exists(targetAbs)) && !(await exists(backupAbs))) {
      await ensureDirNoSymlink(projectDir, path.dirname(r.backupRel));
      await fs.rename(targetAbs, backupAbs);
      await fsyncParent(targetAbs);
      await fsyncParent(backupAbs);
    }
    if (onPhase) await onPhase(`removal.${i}.post`);
  }

  // Manifest LAST.
  if (onPhase) await onPhase('manifest');
  await ensureDirNoSymlink(projectDir, path.dirname(journal.manifestPath));
  await atomicWrite(abs(journal.manifestPath), journal.manifest);
  if (onPhase) await onPhase('post-manifest');

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
  // Confinement FIRST: validate the project container with non-following ops
  // before touching the journal or sweeping — a symlinked `.agents` must never be
  // followed (CRITICAL: sweepOrphans deleted outside the tree through it).
  await assertContainerSafe(projectDir);

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
    const secret = await getSecret();
    if (!verifyJournalMac(secret, journal)) {
      throw new Error('journal MAC is missing or invalid (not authored by skillsync on this machine)');
    }
    await assertJournalAncestorsSafe(projectDir, journal);
    await assertSameDevice(projectDir, journal);
  } catch (err) {
    // Unreadable / foreign / tampered journal. We do NOT execute it and we delete
    // NOTHING (we cannot prove how much, if any, was applied). Fail closed.
    throw new SkillsyncError(
      'JOURNAL_INVALID',
      `refusing to recover ${TXN_FILE}: ${errMsg(err)}. ` +
        `The transaction journal is corrupt, tampered, or was not created by a skillsync transaction on this machine. ` +
        `Inspect it and, if you are sure no transaction is mid-flight, remove ${TXN_FILE} together with any ` +
        `${STAGE_PREFIX}-* / ${BACKUP_PREFIX}-* directories under ${AGENTS_DIR}/, then retry.`,
    );
  }

  await applyJournal(projectDir, journal);
  return true;
}

/**
 * Build the preserve-evidence error thrown from a failed/ambiguous apply. The
 * caller (or `recover`) never cleans up after this, so staging/backups/journal
 * survive for manual repair.
 * @param {Journal} journal
 * @param {string} why
 * @returns {SkillsyncError}
 */
function ambiguity(journal, why) {
  return new SkillsyncError(
    'JOURNAL_APPLY_FAILED',
    `recovery of an in-flight transaction could not be completed safely: ${why}. ` +
      `Staging (${journal.stageRel}), backups (${journal.backupRel}), and the journal have been PRESERVED for repair — do NOT delete them. ` +
      `Inspect the state and resolve it manually before re-running any mutating command.`,
  );
}

/**
 * Structural validation of a journal (synchronous; no fs writes). Throws on any
 * problem. Confines every path to an allowed root beneath the project and rejects
 * duplicate target/backup/staged paths. Ownership/authentication is the MAC (see
 * recover); the recorded host/project are diagnostic and NOT enforced, so a
 * hostname change or a same-filesystem project move does not strand recovery.
 * @param {string} projectDir
 * @param {unknown} j
 * @returns {asserts j is Journal}
 */
function validateJournal(projectDir, j) {
  void projectDir;
  if (j === null || typeof j !== 'object') throw new Error('journal is not an object');
  const journal = /** @type {Record<string, unknown>} */ (j);
  if (journal.schema !== JOURNAL_SCHEMA) throw new Error(`unsupported journal schema ${String(journal.schema)}`);
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
    if (typeof s.stagedHash !== 'string' || !HASH_RE.test(s.stagedHash)) {
      throw new Error(`swap for ${JSON.stringify(s.targetRel)} has no valid stagedHash`);
    }
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

  // Uniqueness: no two operations may share a target, backup, or staged path — an
  // `add foo foo` otherwise produces a journal that can never apply (MAJOR).
  assertUnique(
    [...journal.swaps.map((s) => s.targetRel), ...journal.removals.map((r) => r.targetRel)],
    'target',
  );
  assertUnique(
    [...journal.swaps.map((s) => s.backupRel), ...journal.removals.map((r) => r.backupRel)],
    'backup',
  );
  assertUnique(journal.swaps.map((s) => s.stagedRel), 'staged');
}

/**
 * @param {string[]} values
 * @param {string} label
 */
function assertUnique(values, label) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) throw new Error(`duplicate ${label} path in journal: ${JSON.stringify(v)}`);
    seen.add(v);
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
    return remainder.length > 0 && !remainder.includes('/');
  });
  if (!ok) {
    throw new Error(`target ${JSON.stringify(rel)} is not under an allowed skills root (${roots.join(', ')})`);
  }
}

/**
 * A per-operation staging/backup ROOT is a single directory directly under
 * `.agents/`, named `<prefix>-<uid>`.
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
    throw new Error(`${label} ${JSON.stringify(rel)} must be a single directory under ${AGENTS_DIR}/`);
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
 * Reject a symlinked `.agents` (or a non-directory in its place) with a
 * non-following lstat, before the lock/recovery ever touch it. The project root
 * itself must exist and be a directory.
 * @param {string} projectDir
 */
export async function assertContainerSafe(projectDir) {
  let rootSt;
  try {
    rootSt = await fs.lstat(projectDir);
  } catch (err) {
    throw new SkillsyncError('NO_PROJECT', `project directory does not exist: ${projectDir} (${errMsg(err)})`);
  }
  if (!rootSt.isDirectory()) {
    throw new SkillsyncError('UNSAFE_ANCESTOR', `project path is not a directory: ${projectDir}`);
  }
  const agents = path.join(projectDir, AGENTS_DIR);
  let st;
  try {
    st = await fs.lstat(agents);
  } catch {
    return; // .agents not created yet — safe
  }
  if (st.isSymbolicLink()) {
    throw new SkillsyncError(
      'UNSAFE_ANCESTOR',
      `refusing to operate: ${AGENTS_DIR}/ is a symlink; skillsync will not follow it out of the project`,
    );
  }
  if (!st.isDirectory()) {
    throw new SkillsyncError('UNSAFE_ANCESTOR', `${AGENTS_DIR}/ exists but is not a directory`);
  }
}

/**
 * Reject any journal path whose existing ancestors include a symlink or a
 * non-directory component. Covers EVERY concrete path — stage/backup roots, and
 * each swap staged/target/backup and removal target/backup (MAJOR: nested backup
 * symlink escape was unchecked).
 * @param {string} projectDir
 * @param {Journal} journal
 */
async function assertJournalAncestorsSafe(projectDir, journal) {
  const rels = new Set([journal.manifestPath, journal.stageRel, journal.backupRel]);
  for (const s of journal.swaps) {
    rels.add(s.stagedRel);
    rels.add(s.targetRel);
    rels.add(s.backupRel);
  }
  for (const r of journal.removals) {
    rels.add(r.targetRel);
    rels.add(r.backupRel);
  }
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
 * Create `relDir` beneath the project, verifying with a non-following lstat that
 * no existing component is a symlink. Used right before a rename so a symlinked
 * ancestor introduced after journal validation cannot redirect the write.
 * @param {string} projectDir
 * @param {string} relDir POSIX project-relative directory
 */
async function ensureDirNoSymlink(projectDir, relDir) {
  if (relDir === '' || relDir === '.') return;
  assertProjectRelative(relDir);
  const parts = relDir.split('/');
  let cur = projectDir;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        await fs.mkdir(cur);
        continue;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new SkillsyncError(
        'UNSAFE_ANCESTOR',
        `refusing to operate through a symlinked path component: ${path.relative(projectDir, cur)}`,
      );
    }
    if (!st.isDirectory()) {
      throw new SkillsyncError('UNSAFE_ANCESTOR', `path component is not a directory: ${path.relative(projectDir, cur)}`);
    }
  }
}

/**
 * Verify staging, every target/removal, and every backup live on the SAME
 * filesystem as `.agents/`, so a staged→target rename (and a target→backup move)
 * is a true atomic rename and can never fail with EXDEV partway. Runs at commit
 * AND during recovery (MAJOR: same-device was not re-checked on recovery and
 * excluded backups).
 * @param {string} projectDir
 * @param {Journal} journal
 */
async function assertSameDevice(projectDir, journal) {
  const refDev = (await fs.stat(path.join(projectDir, AGENTS_DIR))).dev;
  const rels = new Set([journal.stageRel, journal.backupRel]);
  for (const s of journal.swaps) {
    rels.add(s.stagedRel);
    rels.add(s.targetRel);
    rels.add(s.backupRel);
  }
  for (const r of journal.removals) {
    rels.add(r.targetRel);
    rels.add(r.backupRel);
  }
  for (const rel of rels) {
    const dev = await nearestExistingDev(path.join(projectDir, rel));
    if (dev !== refDev) {
      throw new SkillsyncError(
        'CROSS_DEVICE',
        `${rel} resolves to a different filesystem than ${AGENTS_DIR}/ (a mounted/symlinked ancestor?); atomic rename is impossible`,
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
 * crash left nothing applied). Only removes REAL directories named with the
 * stage/backup prefix directly under a verified-real `.agents/`; a symlink in
 * that namespace is left untouched (never followed). Never called while a journal
 * exists.
 * @param {string} projectDir
 */
async function sweepOrphans(projectDir) {
  const agentsDir = path.join(projectDir, AGENTS_DIR);
  let entries;
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return;
  }
  const stageBase = path.basename(STAGE_PREFIX);
  const backupBase = path.basename(BACKUP_PREFIX);
  for (const name of entries) {
    if (!name.startsWith(stageBase) && !name.startsWith(backupBase)) continue;
    const abs = path.join(agentsDir, name);
    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      continue;
    }
    // Only sweep a real directory — never follow/delete through a symlink.
    if (st.isDirectory() && !st.isSymbolicLink()) {
      await fs.rm(abs, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// File / dir primitives.
// ---------------------------------------------------------------------------

/**
 * Copy one file into staging using file descriptors: open the source, fstat it to
 * confirm it is a regular file at open time, stream the bytes, normalize the mode
 * class, and fsync before close. A regular-file fsync error is FATAL (durability:
 * EIO/ENOSPC must never be swallowed).
 * @param {string} srcAbs
 * @param {string} destAbs
 * @param {boolean} exec
 */
async function copyFile(srcAbs, destAbs, exec) {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
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
  // fsync the staged file for durability before the journal is written. A failure
  // here (EIO/ENOSPC/...) is fatal — silently continuing risks committing a false
  // manifest over a partially-written staged tree.
  const dfh = await fs.open(destAbs, 'r');
  try {
    await dfh.sync();
  } finally {
    await dfh.close();
  }
}

/**
 * fsync a directory so a preceding rename/create is durable. Only platform
 * "unsupported" codes (EINVAL/ENOTSUP) are tolerated; every other error is fatal.
 * A missing directory is tolerated (nothing to make durable).
 * @param {string} dir
 */
async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  try {
    await fh.sync();
  } catch (err) {
    if (!(err && DIR_FSYNC_IGNORE.has(err.code))) throw err;
  } finally {
    await fh.close();
  }
}

/**
 * fsync the immediate parent directory of a path (durability for a rename/create
 * whose directory entry must survive a crash).
 * @param {string} p
 */
function fsyncParent(p) {
  return fsyncDir(path.dirname(p));
}

/**
 * Atomically write a file: temp in the same dir, fsync, rename over the target,
 * then fsync the directory.
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
 * ENOENT for an absent root and SkillsyncError for an anomalous tree, so callers
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
 * Stable per-target backup key derived from the target path.
 * @param {string} targetRel
 * @returns {string}
 */
function swapKey(targetRel) {
  return targetRel.replace(/[^a-zA-Z0-9]+/g, '_');
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
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
