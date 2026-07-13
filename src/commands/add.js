/**
 * `skillsync add <skill>…` — enable skills in this project at central's current
 * published version, materialize them, and record their pins.
 *
 * `--agents claude,codex` restricts which agents get a copy (stored as the pin's
 * optional filter).
 *
 * @module commands/add
 */

import path from 'node:path';
import { AGENTS } from '../constants.js';
import { readManifest, pinAgents } from '../manifest.js';
import { preflight } from '../git.js';
import { shallowClone, findSkillRel } from '../fetch.js';
import { buildPinAndTargets } from '../skill-pin.js';
import { runTransaction } from '../materialize.js';
import { excludeEntriesFor, targetDir } from '../plan.js';
import { SkillsyncError, log } from '../util.js';
import { resolveProject, withLock, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function add(argv, ctx) {
  const { positionals, flags } = parseArgs(argv, { valueFlags: ['agents'] });
  if (positionals.length === 0) throw new SkillsyncError('USAGE', 'usage: skillsync add <skill>…');

  const agentsFilter = parseAgentsFilter(flags.agents);
  const project = resolveProject(ctx.cwd);
  const manifest = await readManifest(project.manifestPath);
  const { warnings } = await preflight(ctx.cwd, { mode: manifest.mode, manifestPath: project.manifestPath });
  for (const w of warnings) log(`warning: ${w}`);

  const checkout = await shallowClone(manifest.source);
  try {
    /** @type {import('../materialize.js').TargetWrite[]} */
    const targets = [];
    /** @type {string[]} */
    const removeDirs = [];
    for (const skill of positionals) {
      const rel = await findSkillRel(checkout.dir, skill);
      const skillDir = path.join(checkout.dir, rel);
      const { pin, targets: t } = await buildPinAndTargets({
        skill,
        skillDir,
        commit: checkout.commit,
        agentsFilter,
      });
      // If re-adding with a narrower filter, remove agent dirs no longer wanted.
      const prev = manifest.skills[skill];
      if (prev) {
        const nextAgents = new Set(pinAgents(pin));
        for (const agent of pinAgents(prev)) {
          if (!nextAgents.has(agent)) removeDirs.push(targetDir(agent, skill));
        }
      }
      manifest.skills[skill] = pin;
      targets.push(...t);
      log(`add ${skill}@${pin.version} -> ${pinAgents(pin).join(', ')}`);
    }

    await withLock(ctx.cwd, async () => {
      await runTransaction(ctx.cwd, {
        manifest,
        targets,
        removeDirs,
        excludeEntries: excludeEntriesFor(manifest),
      });
    });
  } finally {
    await checkout.cleanup();
  }
}

/**
 * @param {string|boolean|undefined} raw
 * @returns {string[]|undefined}
 */
function parseAgentsFilter(raw) {
  if (typeof raw !== 'string') return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of list) {
    if (!AGENTS.includes(/** @type {any} */ (a))) {
      throw new SkillsyncError('BAD_AGENTS', `unknown agent "${a}"; known: ${AGENTS.join(', ')}`);
    }
  }
  return list.length > 0 ? list : undefined;
}
