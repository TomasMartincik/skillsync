/**
 * `skillsync add <skill>…` — enable skills in this project at central's current
 * published version, materialize them, and record their pins.
 *
 * The entire read → recover → plan → apply state machine runs UNDER the project
 * lock (adversarial-review CRITICAL: pre-lock planning lost concurrent updates).
 * The manifest is read fresh inside the lock, so two concurrent `add`s compose
 * into the union rather than clobbering each other.
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
import { fullClone, findSkillRel, validatePublication } from '../fetch.js';
import { buildSkillPlan } from '../skill-pin.js';
import { stageTargets, commitStaged } from '../materialize.js';
import { excludeEntriesFor, targetDir } from '../plan.js';
import { assertSkillName } from '../skill-name.js';
import { SkillsyncError, log } from '../util.js';
import { resolveProject, withLock, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function add(argv, ctx) {
  const { positionals, flags } = parseArgs(argv, { valueFlags: ['agents'] });
  if (positionals.length === 0) throw new SkillsyncError('USAGE', 'usage: skillsync add <skill>…');
  for (const skill of positionals) assertSkillName(skill, 'skill argument');

  const agentsFilter = parseAgentsFilter(flags.agents);
  const project = resolveProject(ctx.cwd);

  await withLock(ctx.cwd, async () => {
    const manifest = await readManifest(project.manifestPath);
    const { warnings } = await preflight(ctx.cwd, { mode: manifest.mode, manifestPath: project.manifestPath });
    for (const w of warnings) log(`warning: ${w}`);

    // Full clone: we must validate each skill's publication history (uniqueness
    // + monotonicity), which HEAD-only shallow clones cannot show.
    const checkout = await fullClone(manifest.source);
    try {
      /** @type {string[]} */
      const removeDirs = [];
      /** @type {{ skill: string, agent: string, target: string, files: import('../input-policy.js').SkillFile[] }[]} */
      const flatSpecs = [];
      /** @type {Map<string, import('../manifest.js').SkillPin>} */
      const newPins = new Map();

      for (const skill of positionals) {
        const rel = await findSkillRel(checkout.dir, skill);
        await validatePublication(checkout.dir, skill);
        const skillDir = path.join(checkout.dir, rel);
        const { pin, specs } = await buildSkillPlan({
          skill,
          skillDir,
          commit: checkout.commit,
          agentsFilter,
        });

        // Re-adding with a narrower filter: remove agent dirs no longer wanted.
        const prev = manifest.skills[skill];
        if (prev) {
          const nextAgents = new Set(pinAgents(pin));
          for (const agent of pinAgents(prev)) {
            if (!nextAgents.has(agent)) removeDirs.push(targetDir(agent, skill));
          }
        }
        newPins.set(skill, pin);
        for (const s of specs) flatSpecs.push({ skill, ...s });
        log(`add ${skill}@${pin.version} -> ${pinAgents(pin).join(', ')}`);
      }

      // Stage all targets, then record the AUTHORITATIVE staged hash per output.
      const staged = await stageTargets(ctx.cwd, flatSpecs.map((s) => ({ target: s.target, files: s.files })));
      for (let i = 0; i < flatSpecs.length; i++) {
        const { skill, agent } = flatSpecs[i];
        newPins.get(skill).outputs[agent] = staged.targets[i].hash;
      }
      for (const [skill, pin] of newPins) manifest.skills[skill] = pin;

      await commitStaged(ctx.cwd, {
        staged,
        manifest,
        removeDirs,
        excludeEntries: excludeEntriesFor(manifest),
      });
    } finally {
      await checkout.cleanup();
    }
  });
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
