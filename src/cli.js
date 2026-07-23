/**
 * CLI entry: verb dispatch and top-level error handling.
 * @module cli
 */

import { init } from './commands/init.js';
import { add } from './commands/add.js';
import { remove } from './commands/remove.js';
import { sync } from './commands/sync.js';
import { list } from './commands/list.js';
import { suggest } from './commands/suggest.js';
import { hooks } from './commands/hooks.js';
import { selfUpdate } from './commands/self-update.js';
import { SkillsyncError } from './util.js';

const VERBS = /** @type {const} */ ({
  init,
  add,
  remove,
  sync,
  list,
  suggest,
  hooks,
  'self-update': selfUpdate,
});

const HELP = `skillsync — distribute Agent Skills from a central git repo into projects

usage: skillsync <command> [args]

commands:
  init [--source <git-url>] [--mode committed|gitignored|plain] [--yes]
      Create the project manifest. Mode is proposed from git context.
      --source is learned as the machine default (one-time, confirmed).

  add <skill>… [--agents claude,codex]
      Enable skills at central's current version and materialize them.

  remove <skill>…
      Disable skills and delete their materialized copies.

  sync [--force]
      Materialize exactly what the manifest pins (version-exact). Never
      advances pins. Skips drifted copies unless --force.

  list
      Show pinned skills and their materialization status.

  suggest <skill>|--new <name> [--file <path> | -m "…"]
      File a text-only change request as a suggest/* branch on central.

  hooks install
      Idempotently install the machine-global SessionStart hook into
      ~/.claude/settings.json and ~/.codex/hooks.json. In Codex the hook is
      pending review until trusted via /hooks.

  hooks doctor
      Report per agent whether the hook entry and guard script are present.

  self-update
      Update the install clone: fetch, show the incoming commits + diff stat
      (--diff for the full diff), confirm (y/N; --yes skips), fast-forward, and
      re-run hooks install. Never a blind pull.

Global: this tool has zero npm dependencies and no build step.`;

/**
 * @param {string[]} argv process args after `node bin/skillsync.js`
 * @param {{ cwd?: string }} [ctx]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();
  const [verb, ...rest] = argv;

  if (!verb || verb === '-h' || verb === '--help' || verb === 'help') {
    console.log(HELP);
    return verb ? 0 : 1;
  }
  if (verb === '--version' || verb === '-v') {
    console.log('skillsync 0.1.0');
    return 0;
  }

  const handler = VERBS[/** @type {keyof typeof VERBS} */ (verb)];
  if (!handler) {
    console.error(`unknown command: ${verb}\n`);
    console.log(HELP);
    return 1;
  }

  try {
    await handler(rest, { cwd });
    return 0;
  } catch (err) {
    if (err instanceof SkillsyncError) {
      console.error(`error [${err.code}]: ${err.message}`);
    } else {
      console.error(`error: ${(err && err.stack) || err}`);
    }
    return 1;
  }
}
