/**
 * `skillsync self-update` — update the install clone, then repair hooks.
 *
 * NOT a blind pull (ADR 0003 amendment): the session-start hooks execute
 * whatever lives in the clone while agent trust is anchored to the unchanging
 * hook *definition*, so an update is the only moment a compromised source can
 * enter. We therefore fetch, show the incoming commit log + diff stat (full diff
 * with `--diff`), and require explicit confirmation before a fast-forward merge.
 * After updating, we re-run `hooks install` to repair the hook entries (the
 * guard script may have changed).
 *
 * @module commands/self-update
 */

import { git, gitOrThrow } from '../git.js';
import { installDir, installHooks } from '../hooks-config.js';
import { log, warn } from '../util.js';
import { parseArgs, confirm } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} _ctx
 */
export async function selfUpdate(argv, _ctx) {
  const { flags } = parseArgs(argv);
  const dir = installDir();

  // Fetch the tracking remote; FETCH_HEAD becomes the incoming tip.
  await gitOrThrow(['fetch'], { cwd: dir, code: 'SELF_UPDATE_FETCH_FAILED' });

  const count = await gitOrThrow(['rev-list', '--count', 'HEAD..FETCH_HEAD'], { cwd: dir });
  if (count === '0') {
    log('skillsync is already up to date.');
    return;
  }

  const commits = await gitOrThrow(['log', '--oneline', 'HEAD..FETCH_HEAD'], { cwd: dir });
  const stat = await gitOrThrow(['diff', '--stat', 'HEAD..FETCH_HEAD'], { cwd: dir });
  log(`${count} new commit(s) available in ${dir}:`);
  log('');
  log(commits);
  log('');
  log(stat);
  if (flags.diff) {
    log('');
    log(await gitOrThrow(['diff', 'HEAD..FETCH_HEAD'], { cwd: dir }));
  }
  log('');

  let proceed = flags.yes === true;
  if (!proceed) {
    const answer = await confirm('Review the above, then merge these changes?');
    if (answer === null) {
      warn('non-interactive: refusing to self-update without --yes');
      return;
    }
    proceed = answer;
  }
  if (!proceed) {
    log('aborted — no changes merged.');
    return;
  }

  // Fast-forward only: a non-ff situation means local divergence we must not
  // silently rewrite. Surface it instead of merging.
  const merge = await git(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: dir });
  if (merge.code !== 0) {
    warn(`could not fast-forward: ${merge.stderr.trim() || merge.stdout.trim()}`);
    warn(`resolve the clone at ${dir} manually, then re-run self-update.`);
    return;
  }
  log('updated.');

  // Repair hook entries — the guard script may have changed.
  const results = await installHooks();
  for (const r of results) {
    const state = r.created ? 'created' : r.changed ? 'updated' : 'already current';
    log(`hooks ${r.agent}: ${state}`);
  }
}
