/**
 * `skillsync remove <skill>…` — disable skills: drop their pins and delete their
 * materialized copies, transactionally.
 * @module commands/remove
 */

import { readManifest, pinAgents } from '../manifest.js';
import { preflight } from '../git.js';
import { runTransaction } from '../materialize.js';
import { excludeEntriesFor, targetDir } from '../plan.js';
import { SkillsyncError, log, warn } from '../util.js';
import { resolveProject, withLock, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function remove(argv, ctx) {
  const { positionals } = parseArgs(argv);
  if (positionals.length === 0) throw new SkillsyncError('USAGE', 'usage: skillsync remove <skill>…');

  const project = resolveProject(ctx.cwd);
  const manifest = await readManifest(project.manifestPath);
  const { warnings } = await preflight(ctx.cwd, { mode: manifest.mode, manifestPath: project.manifestPath });
  for (const w of warnings) warn(w);

  /** @type {string[]} */
  const removeDirs = [];
  for (const skill of positionals) {
    const pin = manifest.skills[skill];
    if (!pin) {
      warn(`skill "${skill}" is not in the manifest; skipping`);
      continue;
    }
    for (const agent of pinAgents(pin)) removeDirs.push(targetDir(agent, skill));
    delete manifest.skills[skill];
    log(`remove ${skill}`);
  }

  if (removeDirs.length === 0) return;

  await withLock(ctx.cwd, async () => {
    await runTransaction(ctx.cwd, {
      manifest,
      targets: [],
      removeDirs,
      excludeEntries: excludeEntriesFor(manifest),
    });
  });
}
