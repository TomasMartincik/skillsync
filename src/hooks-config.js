/**
 * Machine-global SessionStart hook installation for Claude Code and Codex.
 *
 * Both agents get one SessionStart hook that runs the guard script
 * (`bin/skillsync-notice.js`) out of the install clone, referenced by ABSOLUTE
 * path. The merge is idempotent and surgical: we read the existing JSON, remove
 * only our own entry (identified by the guard basename / a stable name marker),
 * append a fresh one, and write back atomically. Unrelated hooks are never
 * touched, and running twice produces a byte-identical file.
 *
 * Codex reality (ADR 0003 / #17): writing the file is NOT activation — the user
 * must trust the hook via `/hooks` before it fires, and any later change to the
 * hook definition re-triggers that review. `doctor` reports this honestly.
 *
 * @module hooks-config
 */

import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillsyncError } from './util.js';

/** Basename of the guard script; also the marker we match to find "our" entry. */
export const GUARD_BASENAME = 'skillsync-notice.js';

/** Stable name marker written into the Codex entry. */
const CODEX_ENTRY_NAME = 'skillsync-notice';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the user's home directory (HOME override honored for tests)
 */
export function homeDir(env = process.env) {
  return env.HOME || os.homedir();
}

/**
 * Root of the install clone (where the guard script lives). `SKILLSYNC_HOME`
 * overrides for tests / non-standard installs; otherwise it is the repo root of
 * the running code, resolved through any symlink.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function installDir(env = process.env) {
  if (env.SKILLSYNC_HOME) return path.resolve(env.SKILLSYNC_HOME);
  const here = realpathSync(fileURLToPath(import.meta.url)); // <clone>/src/hooks-config.js
  return path.resolve(path.dirname(here), '..');
}

/** @param {string} dir install clone root @returns {string} absolute guard path */
export function guardScriptPath(dir) {
  return path.join(dir, 'bin', GUARD_BASENAME);
}

/** @param {string} home @returns {string} */
export function claudeSettingsPath(home) {
  return path.join(home, '.claude', 'settings.json');
}

/** @param {string} home @returns {string} */
export function codexHooksPath(home) {
  return path.join(home, '.codex', 'hooks.json');
}

// --- JSON I/O -------------------------------------------------------------

/**
 * @param {string} filePath
 * @returns {Promise<string|null>} raw contents, or null if the file is absent
 */
async function readRaw(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && /** @type {any} */ (err).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * @param {string} raw
 * @param {string} filePath
 * @returns {Record<string, any>}
 */
function parseOrThrow(raw, filePath) {
  if (raw.trim() === '') return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('not a JSON object');
    }
    return obj;
  } catch (err) {
    // Never clobber a file we cannot understand — the user resolves it.
    throw new SkillsyncError(
      'HOOKS_CONFIG_UNPARSEABLE',
      `refusing to modify ${filePath}: ${(err && /** @type {any} */ (err).message) || err}`,
    );
  }
}

/**
 * @param {string} filePath
 * @param {string} contents
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, filePath);
}

// --- Merge helpers --------------------------------------------------------

/** @param {any} group @returns {boolean} */
function isOurClaudeGroup(group) {
  return !!group
    && Array.isArray(group.hooks)
    && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(GUARD_BASENAME));
}

/** @param {any} entry @returns {boolean} */
function isOurCodexEntry(entry) {
  if (!entry) return false;
  if (entry.name === CODEX_ENTRY_NAME) return true;
  return Array.isArray(entry.command)
    && entry.command.some((c) => typeof c === 'string' && c.includes(GUARD_BASENAME));
}

/**
 * @param {Record<string, any>} obj
 * @returns {any[]} the SessionStart array (created in place if absent)
 */
function sessionStart(obj) {
  if (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks)) obj.hooks = {};
  if (!Array.isArray(obj.hooks.SessionStart)) obj.hooks.SessionStart = [];
  return obj.hooks.SessionStart;
}

/**
 * Insert/replace our Claude Code SessionStart hook. Returns the same object.
 * @param {Record<string, any>} obj
 * @param {string} guardPath
 * @returns {Record<string, any>}
 */
export function mergeClaude(obj, guardPath) {
  const arr = sessionStart(obj);
  const kept = arr.filter((g) => !isOurClaudeGroup(g));
  kept.push({ hooks: [{ type: 'command', command: `"${guardPath}" --agent claude` }] });
  obj.hooks.SessionStart = kept;
  return obj;
}

/**
 * Insert/replace our Codex SessionStart hook. Returns the same object.
 * @param {Record<string, any>} obj
 * @param {string} guardPath
 * @returns {Record<string, any>}
 */
export function mergeCodex(obj, guardPath) {
  const arr = sessionStart(obj);
  const kept = arr.filter((e) => !isOurCodexEntry(e));
  kept.push({ name: CODEX_ENTRY_NAME, command: [guardPath, '--agent', 'codex'] });
  obj.hooks.SessionStart = kept;
  return obj;
}

/** @param {Record<string, any>} obj @param {string} guardPath */
export function hasClaudeHook(obj, guardPath) {
  const arr = obj?.hooks?.SessionStart;
  return Array.isArray(arr) && arr.some(isOurClaudeGroup);
}

/** @param {Record<string, any>} obj */
export function hasCodexHook(obj) {
  const arr = obj?.hooks?.SessionStart;
  return Array.isArray(arr) && arr.some(isOurCodexEntry);
}

// --- Public operations ----------------------------------------------------

/**
 * @typedef {Object} AgentResult
 * @property {string} agent
 * @property {string} path
 * @property {boolean} created file did not exist before
 * @property {boolean} changed file content changed (false on a clean re-run)
 */

/**
 * @param {string} filePath
 * @param {(o: Record<string, any>, g: string) => Record<string, any>} mergeFn
 * @param {string} guardPath
 * @returns {Promise<{ created: boolean, changed: boolean }>}
 */
async function applyMerge(filePath, mergeFn, guardPath) {
  const before = await readRaw(filePath);
  const obj = before === null ? {} : parseOrThrow(before, filePath);
  const merged = mergeFn(obj, guardPath);
  const after = `${JSON.stringify(merged, null, 2)}\n`;
  const created = before === null;
  const changed = before !== after;
  if (changed) await writeAtomic(filePath, after);
  return { created, changed };
}

/**
 * Install (idempotently repair) the SessionStart hook in both agents.
 * @param {{ home?: string, installDir?: string }} [opts]
 * @returns {Promise<AgentResult[]>}
 */
export async function installHooks(opts = {}) {
  const home = opts.home ?? homeDir();
  const dir = opts.installDir ?? installDir();
  const guardPath = guardScriptPath(dir);

  // Best-effort: make the guard executable so the shebang works when the agent
  // invokes it directly. Absent guard (e.g. a bare fixture) is not fatal.
  await fs.chmod(guardPath, 0o755).catch(() => {});

  const claude = await applyMerge(claudeSettingsPath(home), mergeClaude, guardPath);
  const codex = await applyMerge(codexHooksPath(home), mergeCodex, guardPath);
  return [
    { agent: 'claude', path: claudeSettingsPath(home), ...claude },
    { agent: 'codex', path: codexHooksPath(home), ...codex },
  ];
}

/**
 * @typedef {Object} DoctorReport
 * @property {string} agent
 * @property {string} path
 * @property {boolean} present hook entry is in the config file
 * @property {boolean} guardExists the referenced guard script is on disk
 * @property {string|null} note honest caveat (Codex trust review)
 */

/**
 * Diagnose hook state per agent. Read-only.
 * @param {{ home?: string, installDir?: string }} [opts]
 * @returns {Promise<DoctorReport[]>}
 */
export async function doctorHooks(opts = {}) {
  const home = opts.home ?? homeDir();
  const dir = opts.installDir ?? installDir();
  const guardPath = guardScriptPath(dir);
  const guardExists = await fs.access(guardPath).then(() => true, () => false);

  const claudeRaw = await readRaw(claudeSettingsPath(home));
  const codexRaw = await readRaw(codexHooksPath(home));
  const claudeObj = claudeRaw === null ? {} : parseOrThrow(claudeRaw, claudeSettingsPath(home));
  const codexObj = codexRaw === null ? {} : parseOrThrow(codexRaw, codexHooksPath(home));

  const claudePresent = hasClaudeHook(claudeObj, guardPath);
  const codexPresent = hasCodexHook(codexObj);

  return [
    {
      agent: 'claude',
      path: claudeSettingsPath(home),
      present: claudePresent,
      guardExists,
      note: null,
    },
    {
      agent: 'codex',
      path: codexHooksPath(home),
      present: codexPresent,
      guardExists,
      // We can read the file but never the trust state — be honest about it.
      note: codexPresent
        ? 'pending review — trust it once via /hooks in Codex (a changed hook re-triggers review)'
        : null,
    },
  ];
}
