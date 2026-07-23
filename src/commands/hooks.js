/**
 * `skillsync hooks install` / `skillsync hooks doctor`.
 *
 * `install` merges our SessionStart hook into `~/.claude/settings.json` and
 * `~/.codex/hooks.json` idempotently (see hooks-config). `doctor` reports, per
 * agent, whether the entry and guard script are present — and, for Codex, that
 * installation is not activation until the hook is trusted via `/hooks`.
 *
 * @module commands/hooks
 */

import { installHooks, doctorHooks } from '../hooks-config.js';
import { SkillsyncError, log } from '../util.js';
import { parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} _ctx
 */
export async function hooks(argv, _ctx) {
  const { positionals } = parseArgs(argv);
  const sub = positionals[0];

  if (sub === 'install') return runInstall();
  if (sub === 'doctor') return runDoctor();
  throw new SkillsyncError(
    'BAD_HOOKS_SUBCOMMAND',
    `usage: skillsync hooks <install|doctor>${sub ? ` (got "${sub}")` : ''}`,
  );
}

async function runInstall() {
  const results = await installHooks();
  for (const r of results) {
    const state = r.created ? 'created' : r.changed ? 'updated' : 'already current';
    log(`${r.agent}: ${state} — ${r.path}`);
  }
  // Codex will not fire the hook until it is trusted; say so, don't claim done.
  log('');
  log('Codex: the hook is installed but PENDING REVIEW — trust it once via /hooks in Codex.');
}

async function runDoctor() {
  const reports = await doctorHooks();
  for (const r of reports) {
    const bits = [
      `entry ${r.present ? 'present' : 'ABSENT'}`,
      `guard ${r.guardExists ? 'present' : 'MISSING'}`,
    ];
    if (r.note) bits.push(r.note);
    log(`${r.agent}: ${bits.join('; ')}`);
    log(`  ${r.path}`);
  }
}
