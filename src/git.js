/**
 * Thin git shell-out helpers plus repository-state preflight.
 *
 * All git invocations go through `git()` so failures surface uniformly. We shell
 * out rather than depend on a git library (zero-dep constraint, ADR 0003).
 *
 * @module git
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SkillsyncError } from './util.js';

/**
 * @typedef {Object} GitResult
 * @property {number} code exit code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Run a git command. Never throws on non-zero by default; inspect `.code`.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string }} [opts]
 * @returns {Promise<GitResult>}
 */
export function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Run git and throw a SkillsyncError on non-zero exit.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, code?: string }} [opts]
 * @returns {Promise<string>} trimmed stdout
 */
export async function gitOrThrow(args, opts = {}) {
  const r = await git(args, opts);
  if (r.code !== 0) {
    throw new SkillsyncError(
      opts.code ?? 'GIT_FAILED',
      `git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout.trim();
}

/**
 * Find the git repository root that contains `dir`, or null if none.
 * @param {string} dir
 * @returns {Promise<string|null>}
 */
export async function repoRoot(dir) {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

/**
 * @typedef {Object} RepoState
 * @property {boolean} isRepo
 * @property {string|null} root
 * @property {boolean} detachedHead
 * @property {boolean} inProgress merge/rebase/cherry-pick/bisect underway
 * @property {string|null} inProgressKind
 */

/**
 * Inspect repository state relevant to safe mutation.
 * @param {string} dir
 * @returns {Promise<RepoState>}
 */
export async function repoState(dir) {
  const root = await repoRoot(dir);
  if (!root) {
    return { isRepo: false, root: null, detachedHead: false, inProgress: false, inProgressKind: null };
  }
  const gitDir = await gitOrThrow(['rev-parse', '--absolute-git-dir'], { cwd: dir });

  let inProgressKind = null;
  const checks = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['BISECT_LOG', 'bisect'],
    ['REVERT_HEAD', 'revert'],
  ];
  for (const [name, kind] of checks) {
    if (await pathExists(path.join(gitDir, name))) {
      inProgressKind = kind;
      break;
    }
  }

  const head = await git(['symbolic-ref', '-q', 'HEAD'], { cwd: dir });
  const detachedHead = head.code !== 0;

  return {
    isRepo: true,
    root,
    detachedHead,
    inProgress: inProgressKind !== null,
    inProgressKind,
  };
}

/**
 * Preflight the repository before a mutating operation (adversarial-review MINOR:
 * git state handling). Plain-mode / non-git dirs never require a branch.
 *
 * @param {string} projectDir
 * @param {{ mode: string, manifestPath: string }} opts
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function preflight(projectDir, opts) {
  const warnings = [];
  if (opts.mode === 'plain') return { warnings };

  const state = await repoState(projectDir);
  if (!state.isRepo) {
    // committed/gitignored mode presupposes a git repo.
    throw new SkillsyncError(
      'NOT_A_REPO',
      `mode "${opts.mode}" requires a git repository, but none was found`,
    );
  }
  if (state.inProgress) {
    throw new SkillsyncError(
      'GIT_IN_PROGRESS',
      `refusing to run during an in-progress ${state.inProgressKind}; finish or abort it first`,
    );
  }
  if (await manifestHasConflictMarkers(opts.manifestPath)) {
    throw new SkillsyncError(
      'MANIFEST_CONFLICTED',
      `manifest ${opts.manifestPath} contains merge-conflict markers; resolve it first`,
    );
  }
  if (state.detachedHead) {
    warnings.push('HEAD is detached; committed-mode changes will not be on a branch');
  }
  return { warnings };
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
export async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} manifestPath
 * @returns {Promise<boolean>}
 */
async function manifestHasConflictMarkers(manifestPath) {
  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return false;
  }
  return /^<{7} |^={7}$|^>{7} /m.test(raw);
}
