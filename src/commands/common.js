/**
 * Shared command scaffolding: project resolution, the lock+sweep+run wrapper,
 * argument parsing, and an interactive-confirm helper.
 * @module commands/common
 */

import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { MANIFEST_PATH } from '../constants.js';
import { acquireLock } from '../lock.js';
import { sweepStaging, assertContainerSafe } from '../materialize.js';
import { SkillsyncError } from '../util.js';

/**
 * @typedef {Object} Project
 * @property {string} dir project root (cwd)
 * @property {string} manifestPath absolute path to the manifest
 */

/**
 * The user's home directory — the root of the GLOBAL scope. Every homedir lookup
 * routes through here so `--global` and the HOME-shadow checks agree, and so tests
 * can point the whole tool at a sandbox by setting `$HOME`.
 * @returns {string}
 */
export function homeRoot() {
  return process.env.HOME || os.homedir();
}

/**
 * Canonical form for comparing two roots: resolve symlinks so a symlinked $HOME
 * component (e.g. macOS `/var` -> `/private/var`, or a home on a symlinked mount)
 * still compares equal to a realpath'd cwd. Falls back to a lexical resolve when
 * the path does not exist yet.
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve the operating root from the invocation context and flags.
 *
 * - `--global` targets $HOME regardless of cwd (the documented user scope).
 * - Without `--global`, the root is cwd. If cwd IS $HOME, refuse: the home
 *   directory is the global scope and operating on it must be explicit — never
 *   silently manage HOME from an ordinary project invocation.
 *
 * @param {{ cwd: string }} ctx
 * @param {Record<string, string|boolean>} [flags]
 * @returns {string} absolute operating root
 */
export function resolveRoot(ctx, flags = {}) {
  const home = homeRoot();
  if (flags.global === true) return home;
  const root = ctx.cwd;
  if (canonical(root) === canonical(home)) {
    throw new SkillsyncError(
      'GLOBAL_SCOPE',
      `found the global manifest at ${canonical(home)}; pass --global to operate on the home (global) scope`,
    );
  }
  return root;
}

/**
 * @param {string} dir
 * @returns {Project}
 */
export function resolveProject(dir) {
  return { dir, manifestPath: path.join(dir, MANIFEST_PATH) };
}

/**
 * Run `fn` while holding the project lock, sweeping any orphaned staging left by a
 * crashed run first. Recovery is simply re-running the command, which
 * re-materializes anything whose hash does not match the manifest.
 * @template T
 * @param {string} projectDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(projectDir, fn) {
  // Confine BEFORE taking the lock: a symlinked `.agents` must never be followed
  // by lock acquisition or the sweep (CRITICAL: escape through `.agents`).
  await assertContainerSafe(projectDir);
  const lock = await acquireLock(projectDir);
  try {
    await sweepStaging(projectDir);
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Minimal flag parser. Returns positionals and a flags map. Flags of the form
 * `--key value`, `--key=value`, or boolean `--flag`. Known value-taking flags
 * must be listed so booleans aren't mistaken for values.
 * @param {string[]} argv
 * @param {{ valueFlags?: string[] }} [opts]
 * @returns {{ positionals: string[], flags: Record<string, string|boolean> }}
 */
export function parseArgs(argv, opts = {}) {
  const valueFlags = new Set(opts.valueFlags ?? []);
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (valueFlags.has(key) && i + 1 < argv.length) {
          flags[key] = argv[++i];
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // short flags: -m takes a value here (used by suggest)
      const key = a.slice(1);
      if (valueFlags.has(key) && i + 1 < argv.length) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

/**
 * Ask a yes/no question. Returns null when stdin is not a TTY (non-interactive),
 * so callers can decide the safe default.
 * @param {string} question
 * @returns {Promise<boolean|null>}
 */
export async function confirm(question) {
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * Read all of stdin as a string.
 * @returns {Promise<string>}
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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
