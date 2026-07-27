#!/usr/bin/env node
/**
 * SessionStart guard — the ONLY thing the machine-global hook runs.
 *
 * It is deliberately tiny, dependency-free, and fail-open: a SessionStart hook
 * runs on every new agent session, so it must be fast and must never break a
 * session. It emits at most one advisory notice, and only when updates are
 * actually pending.
 *
 * Behavior:
 *   1. Walk up from cwd for a PROJECT `.agents/skills-manifest.json` (stopping at
 *      $HOME — the home manifest is the global scope, never a project). Found →
 *      report project updates. None → fall through to the global manifest at
 *      $HOME/.agents/skills-manifest.json (reported with `--global`). Neither →
 *      exit 0 silent.
 *   2. Resolve the skillsync binary (SKILLSYNC_BIN, else the sibling
 *      `skillsync.js`). Missing → exit 0 silent.
 *   3. Run `skillsync status --cached [--global]` in the manifest's directory with
 *      a short timeout. ANY error, non-zero exit, or timeout → exit 0 silent (fail
 *      open).
 *   4. Keep only lines announcing a pending update (a "-> <version>" transition),
 *      dropping the status table's headers and up-to-date lines. None → exit 0
 *      silent (nothing pending).
 *   5. Otherwise emit the notice: Codex gets the documented
 *      `{"systemMessage": "..."}` JSON; Claude Code gets plain stdout. When a kept
 *      line mentions a major bump, append the migration warning.
 *
 * `skillsync status --cached` prints a full human table (source/mode/cache headers
 * plus one line per skill); a pending update is the only line carrying a
 * "-> <version>" transition, and a major jump's line contains the token "major".
 * This guard filters to those lines and classifies them — it does no version math
 * of its own and never mutates anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_REL = path.join('.agents', 'skills-manifest.json');
const MIGRATION_WARNING =
  'major updates are migrations; analyze how the changes affect the project’s setup '
  + 'before applying (`update <skill> --major`).';

/** @param {string[]} argv @returns {'claude'|'codex'} */
function parseAgent(argv) {
  const i = argv.indexOf('--agent');
  const v = i !== -1 ? argv[i + 1] : undefined;
  return v === 'codex' ? 'codex' : 'claude';
}

/**
 * The user's home directory — root of the global scope — in canonical (realpath'd)
 * form so a symlinked $HOME component compares equal to a realpath'd cwd.
 * @param {NodeJS.ProcessEnv} env @returns {string}
 */
function homeDir(env) {
  const raw = env.HOME || os.homedir();
  try {
    return realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
}

/**
 * Walk up from `start` for a PROJECT manifest, stopping AT $HOME: the home manifest
 * is the global scope, never treated as a project. Returns the directory that holds
 * the manifest (so status runs there, not in a nested subdir), or null. `home` must
 * already be canonical.
 * @param {string} start @param {string} home @returns {string|null}
 */
function findProjectManifest(start, home) {
  let dir = path.resolve(start);
  for (;;) {
    if (dir === home) return null; // reached the global scope — not a project
    if (existsSync(path.join(dir, MANIFEST_REL))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve how to invoke skillsync. Returns null when the binary is missing.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ cmd: string, pre: string[] } | null}
 */
function resolveSkillsync(env) {
  if (env.SKILLSYNC_BIN) {
    return existsSync(env.SKILLSYNC_BIN) ? { cmd: env.SKILLSYNC_BIN, pre: [] } : null;
  }
  const here = realpathSync(fileURLToPath(import.meta.url)); // <clone>/bin/skillsync-notice.js
  const sibling = path.join(path.dirname(here), 'skillsync.js');
  return existsSync(sibling) ? { cmd: process.execPath, pre: [sibling] } : null;
}

function main() {
  const argv = process.argv.slice(2);
  const agent = parseAgent(argv);
  const cwd = process.cwd();
  const env = process.env;
  const home = homeDir(env);

  // Project scope takes precedence; otherwise fall through to the global manifest.
  // status runs in the directory that actually holds the manifest — a project
  // manifest lives at its root, not necessarily in a nested cwd.
  const projectDir = findProjectManifest(cwd, home);
  /** @type {string[]} */
  let statusArgs;
  /** @type {string} */
  let runCwd;
  if (projectDir) {
    statusArgs = ['status', '--cached'];
    runCwd = projectDir;
  } else if (existsSync(path.join(home, MANIFEST_REL))) {
    statusArgs = ['status', '--cached', '--global'];
    runCwd = home;
  } else {
    return; // nothing to report
  }

  const bin = resolveSkillsync(env);
  if (!bin) return;

  const timeout = Number(env.SKILLSYNC_NOTICE_TIMEOUT_MS) || 2000;
  let res;
  try {
    res = spawnSync(bin.cmd, [...bin.pre, ...statusArgs], {
      cwd: runCwd,
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return; // fail open
  }
  // Timeout (res.signal set / res.error) or non-zero exit → stay silent.
  if (!res || res.error || res.status !== 0) return;

  // `status --cached` prints a full human table (source/mode/cache headers + one
  // line per skill, up-to-date ones included). Only lines announcing a pending
  // update carry a "-> <version>" transition; keep those and stay silent when
  // there are none. This realizes the silent-when-current contract regardless of
  // the table's headers, and matches the pending lines the tests' stubs emit.
  const pending = String(res.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('->'));
  if (pending.length === 0) return;

  let notice = pending.join('\n');
  if (/major/i.test(notice)) notice += `\n\n${MIGRATION_WARNING}`;

  if (agent === 'codex') {
    process.stdout.write(`${JSON.stringify({ systemMessage: notice })}\n`);
  } else {
    process.stdout.write(`${notice}\n`);
  }
}

try {
  main();
} catch {
  // Absolutely never break a session.
}
process.exit(0);
