/**
 * Remote-first, tool-owned fetch protocol (ADR 0001, refined by the adversarial
 * review's CRITICAL "exact pinned sync vs shallow fetch").
 *
 * Everything happens in a per-operation temp clone using the machine's own
 * git/gh credentials; no persistent per-machine clone of the skills repo exists.
 *
 * Pin retrieval protocol (`ensureCommit`):
 *   1. fast path  — `git fetch --depth 1 origin <commit>` (direct SHA fetch);
 *   2. deepen     — shallow-fetch the default branch, then `--deepen` in steps
 *                   until the object appears;
 *   3. full       — unshallow / full fetch of all branches.
 *   If the object is still absent, throw UNRESOLVABLE_PIN *before* any project
 *   file is touched.
 *
 * Version pins resolve to commits via `resolveVersionToCommit`, which walks
 * first-parent history (adversarial-review MAJOR-2) and rejects regressed
 * versions.
 *
 * @module fetch
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitOrThrow } from './git.js';
import { parseFrontmatter } from './frontmatter.js';
import { assertSkillName } from './skill-name.js';
import { SkillsyncError } from './util.js';

/** @returns {Promise<string>} a fresh temp directory */
export async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skillsync-'));
}

/**
 * Normalize a clone source for safe use as a git operand. A URL or scp-like
 * remote (`https://…`, `git@host:…`) is passed through unchanged; anything else
 * is treated as a local path and resolved to an absolute path so a relative name
 * beginning with `-` can never be mistaken for a git option. The caller also
 * places `--` before the operand as belt-and-suspenders.
 * @param {string} source
 * @returns {string}
 */
export function cloneOperand(source) {
  const s = String(source);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s; // scheme://…
  if (s.startsWith('file://')) return s;
  // Git scp-like shorthand: `[user@]host:path`. Git treats a source as scp syntax
  // when a colon appears BEFORE the first slash (so `host:path` without a username
  // is valid too — MINOR regression). A colon after a slash (e.g. `./a:b`) or no
  // colon is a local path, resolved to absolute so a leading `-` is never an
  // option.
  const colon = s.indexOf(':');
  const slash = s.indexOf('/');
  if (colon > 0 && (slash === -1 || colon < slash)) return s;
  return path.resolve(s); // local path -> absolute
}

/**
 * @typedef {Object} Checkout
 * @property {string} dir working directory with the tree checked out
 * @property {string} commit resolved commit SHA
 * @property {() => Promise<void>} cleanup remove the temp clone
 */

/**
 * Shallow clone the source at its current default-branch HEAD (the fast path used
 * by `add`, where we want "whatever is published now").
 * @param {string} source git URL or local path
 * @returns {Promise<Checkout>}
 */
export async function shallowClone(source) {
  const dir = await mkTmp();
  try {
    await gitOrThrow(['clone', '--depth', '1', '--quiet', '--', cloneOperand(source), dir], {
      code: 'CLONE_FAILED',
    });
  } catch (err) {
    await rm(dir);
    throw err;
  }
  const commit = await gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir });
  return { dir, commit, cleanup: () => rm(dir) };
}

/**
 * Produce a checkout of `source` at exactly `commit`, using the layered pin
 * retrieval protocol. Throws before creating any project artifact if the commit
 * cannot be resolved.
 * @param {string} source
 * @param {string} commit full or abbreviated SHA
 * @returns {Promise<Checkout>}
 */
export async function checkoutCommit(source, commit) {
  const dir = await mkTmp();
  try {
    await gitOrThrow(['init', '-q'], { cwd: dir });
    await gitOrThrow(['remote', 'add', 'origin', cloneOperand(source)], { cwd: dir });
    await ensureCommit(dir, commit);
    // Detach onto the commit and populate the working tree.
    await gitOrThrow(['-c', 'advice.detachedHead=false', 'checkout', '-q', commit], { cwd: dir });
    const resolved = await gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir });
    return { dir, commit: resolved, cleanup: () => rm(dir) };
  } catch (err) {
    await rm(dir);
    throw err;
  }
}

/**
 * Ensure `commit` exists as an object in the repo at `dir`, escalating fetch
 * strategy as needed.
 * @param {string} dir an initialized repo with an `origin` remote
 * @param {string} commit
 * @returns {Promise<void>}
 */
async function ensureCommit(dir, commit) {
  // 1. fast path — direct SHA fetch.
  const direct = await git(['fetch', '--depth', '1', 'origin', commit], { cwd: dir });
  if (direct.code === 0 && (await hasCommit(dir, commit))) return;

  // 2. deepen — grab the default branch shallow, then deepen in steps.
  await git(['fetch', '--depth', '1', 'origin'], { cwd: dir });
  if (await hasCommit(dir, commit)) return;
  for (const depth of [10, 50, 250, 1000]) {
    await git(['fetch', `--deepen=${depth}`, 'origin'], { cwd: dir });
    if (await hasCommit(dir, commit)) return;
  }

  // 3. full — unshallow / fetch everything.
  await git(['fetch', '--unshallow', 'origin'], { cwd: dir });
  await git(['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { cwd: dir });
  if (await hasCommit(dir, commit)) return;

  throw new SkillsyncError(
    'UNRESOLVABLE_PIN',
    `commit ${commit} is not reachable from source (history may have been rewritten or garbage-collected)`,
  );
}

/**
 * @param {string} dir
 * @param {string} commit
 * @returns {Promise<boolean>}
 */
async function hasCommit(dir, commit) {
  const r = await git(['cat-file', '-e', `${commit}^{commit}`], { cwd: dir });
  return r.code === 0;
}

/**
 * Full clone of the source (tiny repos) for history-scanning operations.
 * @param {string} source
 * @returns {Promise<Checkout>}
 */
export async function fullClone(source) {
  const dir = await mkTmp();
  try {
    await gitOrThrow(['clone', '--quiet', '--', cloneOperand(source), dir], { code: 'CLONE_FAILED' });
  } catch (err) {
    await rm(dir);
    throw err;
  }
  const commit = await gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir });
  return { dir, commit, cleanup: () => rm(dir) };
}

/**
 * @typedef {Object} Publication
 * @property {string} skillRel POSIX rel path to the skill dir at HEAD (or the
 *   newest boundary where it existed)
 * @property {{ commit: string, version: string, tree: string, rel: string }[]} observed
 *   first-parent tree-change boundaries newest -> oldest, one entry per boundary
 *   where the skill exists; `tree` is the git tree object id of the skill dir
 *   (content identity); `rel` is the skill dir path AT that boundary.
 */

/**
 * Scan a skill's first-parent publication history and enforce the central-repo
 * invariants (adversarial-review MAJOR: duplicate versions / no `add` validation;
 * history broke when a skill directory moved):
 *   - versions are monotonically non-decreasing over time (no regression);
 *   - each version maps to exactly ONE canonical skill tree — a version reused
 *     across a real content change (the skill tree object id differs) is rejected.
 *
 * The skill directory is located PER BOUNDARY, not once at HEAD, so a rename such
 * as `old/foo` -> `new/foo` keeps every historical release visible. We enumerate
 * the first-parent commits that actually changed the skill's SKILL.md at any depth
 * (few boundaries) rather than probing every first-parent commit.
 * @param {string} dir a full clone
 * @param {string} skill skill name
 * @returns {Promise<Publication>}
 */
export async function scanPublication(dir, skill) {
  assertSkillName(skill);
  // First-parent boundaries where this skill's SKILL.md changed, at ANY depth.
  const boundaries = (
    await gitOrThrow(
      ['log', '--first-parent', '--format=%H', '--', `:(glob)**/${skill}/SKILL.md`],
      { cwd: dir },
    )
  )
    .split('\n')
    .filter(Boolean);

  /** @type {Publication['observed']} */
  const observed = [];
  for (const commit of boundaries) {
    const rel = await findSkillRelAt(dir, skill, commit); // path AT this boundary
    if (rel === null) continue; // a deletion boundary
    const v = await readSkillVersionAt(dir, commit, rel);
    if (v === null) continue;
    const tree = await treeShaAt(dir, commit, rel);
    observed.push({ commit, version: v, tree, rel });
  }

  if (observed.length === 0) {
    throw new SkillsyncError('SKILL_NOT_FOUND', `skill "${skill}" has no versioned history in source`);
  }

  // Monotonicity: newest -> oldest, versions must be non-increasing.
  for (let i = 1; i < observed.length; i++) {
    if (compareVersions(observed[i - 1].version, observed[i].version) < 0) {
      throw new SkillsyncError(
        'VERSION_REGRESSION',
        `skill "${skill}" has a non-monotonic version history (${observed[i].version} precedes ${observed[i - 1].version}); central history must be unique and monotonic`,
      );
    }
  }

  // Uniqueness: a version must correspond to exactly one canonical tree.
  /** @type {Map<string, string>} */
  const versionTree = new Map();
  for (const o of observed) {
    const prev = versionTree.get(o.version);
    if (prev !== undefined && prev !== o.tree) {
      throw new SkillsyncError(
        'DUPLICATE_VERSION',
        `skill "${skill}" reuses version ${o.version} for two different skill trees; central must bump the version on every content change`,
      );
    }
    if (prev === undefined) versionTree.set(o.version, o.tree);
  }

  return { skillRel: observed[0].rel, observed };
}

/**
 * Locate the uniquely-named skill directory (the one containing SKILL.md) within a
 * single commit's tree. Returns null if the skill is absent at that commit; throws
 * AMBIGUOUS_SKILL if two directories of that name both carry a SKILL.md.
 * @param {string} dir
 * @param {string} skill
 * @param {string} commit
 * @returns {Promise<string|null>} POSIX rel path of the skill dir at `commit`
 */
async function findSkillRelAt(dir, skill, commit) {
  const out = await gitOrThrow(['ls-tree', '-r', '--name-only', commit], { cwd: dir });
  const suffix = `/${skill}/SKILL.md`;
  const exact = `${skill}/SKILL.md`;
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const line of out.split('\n')) {
    if (line === exact) dirs.add(skill);
    else if (line.endsWith(suffix)) dirs.add(line.slice(0, -'/SKILL.md'.length));
  }
  if (dirs.size === 0) return null;
  if (dirs.size > 1) {
    throw new SkillsyncError(
      'AMBIGUOUS_SKILL',
      `skill "${skill}" appears at multiple paths in ${commit.slice(0, 8)} (${[...dirs].join(', ')}); central must keep one canonical location`,
    );
  }
  return [...dirs][0];
}

/**
 * Validate a skill's publication history (used by `add`, which otherwise only
 * sees HEAD). Throws VERSION_REGRESSION / DUPLICATE_VERSION on a broken history.
 * @param {string} dir a full clone
 * @param {string} skill
 * @returns {Promise<void>}
 */
export async function validatePublication(dir, skill) {
  await scanPublication(dir, skill);
}

/**
 * Resolve a version pin to the newest first-parent commit whose skill declares
 * that version, after enforcing the publication invariants.
 * @param {string} dir a full clone
 * @param {string} skill skill name
 * @param {string} version target version, e.g. "1.2"
 * @returns {Promise<string>} commit SHA
 */
export async function resolveVersionToCommit(dir, skill, version) {
  const { observed } = await scanPublication(dir, skill);
  const match = observed.find((o) => o.version === version);
  if (!match) {
    throw new SkillsyncError(
      'UNRESOLVABLE_PIN',
      `no commit found declaring version ${version} for skill "${skill}"`,
    );
  }
  return match.commit;
}

/**
 * @param {string} dir
 * @param {string} commit
 * @param {string} skillRel POSIX rel path to the skill dir
 * @returns {Promise<string|null>}
 */
async function readSkillVersionAt(dir, commit, skillRel) {
  const r = await git(['show', `${commit}:${skillRel}/SKILL.md`], { cwd: dir });
  if (r.code !== 0) return null;
  const { data } = parseFrontmatter(r.stdout);
  return normalizeVersion(data.version);
}

/**
 * Git tree object id of the skill directory at `commit` — a content-identity for
 * the whole skill tree (two commits with identical skill content share it).
 * @param {string} dir
 * @param {string} commit
 * @param {string} skillRel
 * @returns {Promise<string>}
 */
async function treeShaAt(dir, commit, skillRel) {
  return gitOrThrow(['rev-parse', `${commit}:${skillRel}`], { cwd: dir });
}

/**
 * Locate the skill directory (the one containing SKILL.md) within a checkout.
 * Prefers `<root>/<skill>/SKILL.md`, then searches shallowly.
 * @param {string} dir checkout root
 * @param {string} skill
 * @returns {Promise<string>} POSIX relative path of the skill dir
 */
export async function findSkillRel(dir, skill) {
  assertSkillName(skill);
  const direct = path.join(dir, skill, 'SKILL.md');
  if (await exists(direct)) return skill;

  // Shallow recursive search for a dir named `skill` containing SKILL.md.
  const found = await searchSkill(dir, dir, skill, 0);
  if (found) return found;

  throw new SkillsyncError('SKILL_NOT_FOUND', `skill "${skill}" not found in source`);
}

/**
 * @param {string} root
 * @param {string} cur
 * @param {string} skill
 * @param {number} depth
 * @returns {Promise<string|null>}
 */
async function searchSkill(root, cur, skill, depth) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await fs.readdir(cur, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue;
    const abs = path.join(cur, e.name);
    if (e.name === skill && (await exists(path.join(abs, 'SKILL.md')))) {
      return path.relative(root, abs).split(path.sep).join('/');
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue;
    const res = await searchSkill(root, path.join(cur, e.name), skill, depth + 1);
    if (res) return res;
  }
  return null;
}

/**
 * Read a skill's declared version from a checkout on disk.
 * @param {string} skillDir absolute path to the skill directory
 * @returns {Promise<string>} normalized version
 */
export async function readSkillVersion(skillDir) {
  const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  const { data } = parseFrontmatter(raw);
  const v = normalizeVersion(data.version);
  if (v === null) {
    throw new SkillsyncError(
      'MISSING_VERSION',
      `SKILL.md in ${skillDir} has no valid "version: <major>.<minor>" frontmatter`,
    );
  }
  return v;
}

/**
 * Normalize a frontmatter version value to a CANONICAL `major.minor` string, or
 * null. Leading zeros are stripped via BigInt so `01.02` and `1.2` canonicalize to
 * the same value (adversarial-review: leading-zero versions formed distinct
 * uniqueness keys while comparing numerically equal). Arbitrary-width integers are
 * supported (no float truncation of e.g. `1.10`).
 * @param {unknown} v
 * @returns {string|null}
 */
export function normalizeVersion(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (/^\d+\.\d+$/.test(s)) {
    const [a, b] = s.split('.');
    return `${BigInt(a)}.${BigInt(b)}`;
  }
  if (/^\d+$/.test(s)) return `${BigInt(s)}.0`;
  return null;
}

/**
 * Compare two `major.minor` versions numerically with BigInt (leading zeros and
 * arbitrarily large components compare correctly). Returns -1, 0, or 1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const [am, an] = a.split('.');
  const [bm, bn] = b.split('.');
  const major = BigInt(am) - BigInt(bm);
  if (major !== 0n) return major < 0n ? -1 : 1;
  const minor = BigInt(an) - BigInt(bn);
  if (minor !== 0n) return minor < 0n ? -1 : 1;
  return 0;
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} dir */
function rm(dir) {
  return fs.rm(dir, { recursive: true, force: true });
}
