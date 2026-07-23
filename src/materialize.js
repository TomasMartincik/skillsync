/**
 * Idempotent materialization.
 *
 * skillsync copies Markdown skill folders into a project. Crash-safety comes from
 * IDEMPOTENCE, not a transaction log:
 *
 *   1. STAGE   — generate each target's artifact into a private staging dir under
 *                `.agents/`, then SCAN + VALIDATE + HASH the STAGED tree (not the
 *                source). The staged hash is authoritative: it is what the manifest
 *                records (`add`) or is verified against (`sync`).
 *   2. INSTALL — for each target, atomically `rename` the staged dir into place
 *                (replacing any existing copy), so an agent never observes a
 *                half-written skill; then apply removals.
 *   3. MANIFEST— write the manifest LAST via write-temp + atomic rename. Because it
 *                lands last and atomically, the manifest ALWAYS describes the last
 *                fully-completed state.
 *
 * There is no journal, no backup, and no recovery state machine. Recovery IS
 * re-running: a crash mid-operation leaves at most (a) stale staging dirs, swept on
 * the next lock acquisition, and (b) copies whose on-disk hash does not match the
 * manifest, which the next `sync`/`add` re-materializes. This assumes a non-hostile
 * local user (see README).
 *
 * @module materialize
 */

import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { AGENT_TARGETS, MANIFEST_PATH, STAGE_PREFIX } from './constants.js';
import { fsyncDir, fsyncHandle, fsyncParent } from './durable.js';
import { writeExclude } from './exclude.js';
import { hashFiles } from './hash.js';
import { SkillsyncError } from './util.js';

/** `.agents/` — the only directory skillsync creates working files under. */
const AGENTS_DIR = '.agents';

/**
 * Age (ms) above which an ORPHANED staging dir is swept on lock acquisition. The
 * sweep runs while the project lock is held, so no live operation can own a staging
 * dir at that moment; the default (0) therefore sweeps every leftover immediately.
 * Raise it (env) only to keep young orphans around for inspection.
 */
const STAGE_MAX_AGE_MS = envInt('SKILLSYNC_STAGE_MAX_AGE_MS', 0);

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
 * @property {StagedTarget[]} targets
 */

// ---------------------------------------------------------------------------
// Phase 1: STAGE — the adaptation/generation interface (#14 plugs in here).
// ---------------------------------------------------------------------------

/**
 * Generate + validate + hash staged artifacts for a set of targets. This is the
 * seam where per-agent adaptation produces the concrete bytes to materialize:
 * callers pass the file list to stage, and the STAGED tree is what gets hashed
 * and (later) atomically renamed in.
 * @param {string} projectDir
 * @param {TargetWrite[]} targetSpecs
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<Staged>}
 */
export async function stageTargets(projectDir, targetSpecs, onPhase) {
  const { scanSkillTree } = await import('./input-policy.js');
  const uid = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stageRel = `${STAGE_PREFIX}-${uid}`;
  const stageDir = path.join(projectDir, stageRel);

  await fs.mkdir(path.join(projectDir, AGENTS_DIR), { recursive: true });
  // Staging is PRIVATE (0700): it narrows the window in which another *user* on the
  // machine could tamper with bytes we have already hashed. It BECOMES the skill dir
  // after the rename, so the per-target dir below keeps normal permissions.
  await fs.mkdir(stageDir, { recursive: true, mode: 0o700 });
  await phase(onPhase, 'stage');

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
    // Light durability: fsync the staged target root so a crash after the manifest
    // is written cannot leave the renamed-in tree's top-level entries unflushed.
    await fsyncDir(stagedAbs);
    maybeCrash(`stage.${i}.copied`);
    // Authoritative: hash the STAGED tree we just wrote, not the source checkout.
    const staged = await scanSkillTree(stagedAbs);
    const hash = await hashFiles(staged);
    targets.push({ target: spec.target, stagedRel: `${stageRel}/${stagedName}`, hash });
  }
  await fsyncDir(stageDir);

  return { uid, stageRel, targets };
}

// ---------------------------------------------------------------------------
// Phase 2+3: INSTALL, then MANIFEST last.
// ---------------------------------------------------------------------------

/**
 * Install a staged set: atomically rename each staged dir into place, apply
 * removals, then write the manifest LAST. Assumes the project lock is held.
 * @param {string} projectDir
 * @param {{ staged: Staged, manifest: import('./manifest.js').Manifest, removeDirs: string[], excludeEntries: string[]|null }} plan
 * @param {(phase: string) => void|Promise<void>} [onPhase]
 * @returns {Promise<void>}
 */
export async function commitStaged(projectDir, plan, onPhase) {
  const { serializeManifest, validateManifest } = await import('./manifest.js');
  const { staged } = plan;

  // Validate the COMPLETE next manifest before writing anything — never leave a
  // manifest the tool would later refuse to read (duplicate --agents, etc.).
  validateManifest(plan.manifest);
  // A symlinked `.agents/` must never be followed out of the project.
  await assertContainerSafe(projectDir);

  const abs = (rel) => path.join(projectDir, rel);

  // INSTALL each staged target. A single `rename` makes the whole new tree appear
  // at once; any existing copy is removed just before it (a plain existence check —
  // `rename` cannot overwrite a populated directory). A crash between the remove and
  // the rename leaves the target ABSENT, which the next sync re-materializes.
  for (let i = 0; i < staged.targets.length; i++) {
    const t = staged.targets[i];
    assertTargetRel(t.target);
    const stagedAbs = abs(t.stagedRel);
    const targetAbs = abs(t.target);
    await ensureDirNoSymlink(projectDir, path.dirname(t.target));
    await assertNoSymlinkAncestors(projectDir, t.target);
    if (await exists(targetAbs)) {
      await fs.rm(targetAbs, { recursive: true, force: true });
    }
    await phase(onPhase, `swap.${i}.pre-rename`);
    await fs.rename(stagedAbs, targetAbs);
    await fsyncParent(targetAbs);
    await phase(onPhase, `swap.${i}.post-rename`);
  }

  // Removals.
  for (let i = 0; i < plan.removeDirs.length; i++) {
    const rel = plan.removeDirs[i];
    assertTargetRel(rel);
    await assertNoSymlinkAncestors(projectDir, rel);
    const targetAbs = abs(rel);
    if (await exists(targetAbs)) {
      await fs.rm(targetAbs, { recursive: true, force: true });
      await fsyncParent(targetAbs);
    }
    await phase(onPhase, `removal.${i}.post`);
  }

  // Manifest LAST.
  await phase(onPhase, 'manifest');
  await ensureDirNoSymlink(projectDir, path.dirname(MANIFEST_PATH));
  await atomicWrite(abs(MANIFEST_PATH), serializeManifest(plan.manifest));
  await phase(onPhase, 'post-manifest');

  // Exclude handling (idempotent; lives under .git, outside the atomic set).
  if (plan.excludeEntries) {
    await writeExclude(projectDir, plan.excludeEntries);
  }

  // Remove our own staging dir.
  await fs.rm(abs(staged.stageRel), { recursive: true, force: true });
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
 * Housekeeping run at the start of every mutating command, under the lock: verify
 * the project container and sweep orphaned staging dirs left by a crashed run.
 * @param {string} projectDir
 * @returns {Promise<void>}
 */
export async function sweepStaging(projectDir) {
  await assertContainerSafe(projectDir);
  const agentsDir = path.join(projectDir, AGENTS_DIR);
  let entries;
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return;
  }
  const stageBase = path.basename(STAGE_PREFIX);
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(stageBase)) continue;
    const absPath = path.join(agentsDir, name);
    let st;
    try {
      st = await fs.lstat(absPath);
    } catch {
      continue;
    }
    // Only sweep a real directory — never follow/delete through a symlink — and only
    // once it is older than the (lock-protected) age threshold.
    if (st.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs >= STAGE_MAX_AGE_MS) {
      await fs.rm(absPath, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Confinement helpers (cheap, non-following lstat checks; non-hostile-user model).
// ---------------------------------------------------------------------------

/**
 * A materialization target must live directly under one of the known agent skills
 * roots (`.claude/skills/<name>` or `.agents/skills/<name>`), be project-relative,
 * and contain no `..` traversal.
 * @param {unknown} rel
 */
function assertTargetRel(rel) {
  if (typeof rel !== 'string' || rel === '') throw new SkillsyncError('UNSAFE_ANCESTOR', 'target path is empty');
  assertProjectRelative(rel);
  const roots = Object.values(AGENT_TARGETS);
  const ok = roots.some((root) => {
    if (!rel.startsWith(`${root}/`)) return false;
    const remainder = rel.slice(root.length + 1);
    return remainder.length > 0 && !remainder.includes('/');
  });
  if (!ok) {
    throw new SkillsyncError(
      'UNSAFE_ANCESTOR',
      `target ${JSON.stringify(rel)} is not under an allowed skills root (${roots.join(', ')})`,
    );
  }
}

/**
 * @param {string} rel
 */
function assertProjectRelative(rel) {
  if (path.isAbsolute(rel)) throw new SkillsyncError('UNSAFE_ANCESTOR', `path ${JSON.stringify(rel)} is absolute`);
  if (rel.includes('\\')) throw new SkillsyncError('UNSAFE_ANCESTOR', `path ${JSON.stringify(rel)} contains a backslash`);
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) {
    throw new SkillsyncError('UNSAFE_ANCESTOR', `path ${JSON.stringify(rel)} contains a traversal or empty segment`);
  }
}

/**
 * Reject a symlinked `.agents` (or a non-directory in its place) with a
 * non-following lstat. The project root itself must exist and be a directory.
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
 * Create `relDir` beneath the project, verifying with a non-following lstat that no
 * existing component is a symlink. Every directory we CREATE here is a live ancestor
 * of a materialized skill (`.claude`, `.claude/skills`, `.agents`, …), so its parent
 * is fsynced right after the mkdir — a crash must not keep the (durable) manifest
 * while losing the directory entry it depends on.
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
        await fsyncParent(cur);
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

// ---------------------------------------------------------------------------
// File / dir primitives.
// ---------------------------------------------------------------------------

/**
 * Copy one file into staging using file descriptors: open the source, fstat it to
 * confirm it is a regular file at open time, stream the bytes, normalize the mode
 * class, and fsync before close. A regular-file fsync error is fatal (EIO/ENOSPC
 * must never be swallowed).
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
  const dfh = await fs.open(destAbs, 'r');
  try {
    await fsyncHandle(dfh, destAbs);
  } finally {
    await dfh.close();
  }
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
    await fsyncHandle(fh, tmp);
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

// ---------------------------------------------------------------------------
// Misc.
// ---------------------------------------------------------------------------

/**
 * Reach an operation phase: crash here if a test asked for it, then invoke the
 * caller's observer. `maybeCrash` is inert unless SKILLSYNC_TEST_CRASH_PHASE is set.
 * @param {((phase: string) => void|Promise<void>)|undefined} onPhase
 * @param {string} label
 */
async function phase(onPhase, label) {
  maybeCrash(label);
  if (onPhase) await onPhase(label);
}

/**
 * Test-only crash injection: hard-kill this process at a named phase to exercise
 * idempotent re-run. Gated entirely behind an env var, so it is a no-op in normal
 * use (like the SKILLSYNC_LOCK_* knobs in lock.js).
 * @param {string} label
 */
function maybeCrash(label) {
  if (process.env.SKILLSYNC_TEST_CRASH_PHASE === label) {
    process.kill(process.pid, 'SIGKILL');
  }
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
