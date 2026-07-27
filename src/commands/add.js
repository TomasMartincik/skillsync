/**
 * `skillsync add <skill>…` — enable skills in this project at central's current
 * published version, materialize them, and record their pins.
 *
 * The entire read → plan → install runs UNDER the project
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
import { promises as fs } from 'node:fs';
import { AGENTS, AGENT_TARGETS } from '../constants.js';
import { readManifest, pinAgents } from '../manifest.js';
import { preflight } from '../git.js';
import { fullClone, findSkillRel } from '../fetch.js';
import { buildSkillPlan } from '../skill-pin.js';
import { stageTargets, commitStaged } from '../materialize.js';
import { excludeEntriesFor, targetDir } from '../plan.js';
import { refreshCacheEntry } from '../version-cache.js';
import { assertSkillName } from '../skill-name.js';
import { SkillsyncError, log, warn } from '../util.js';
import { resolveProject, resolveRoot, withLock, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function add(argv, ctx) {
  const { positionals, flags } = parseArgs(argv, { valueFlags: ['agents'] });
  if (positionals.length === 0) throw new SkillsyncError('USAGE', 'usage: skillsync add <skill>…');
  for (const skill of positionals) assertSkillName(skill, 'skill argument');
  assertNoDuplicates(positionals, 'skill');

  const agentsFilter = parseAgentsFilter(flags.agents);
  const isGlobal = flags.global === true;
  const project = resolveProject(resolveRoot(ctx, flags));

  await withLock(project.dir, async () => {
    const manifest = await readManifest(project.manifestPath);
    const { warnings } = await preflight(project.dir, { mode: manifest.mode, manifestPath: project.manifestPath });
    for (const w of warnings) log(`warning: ${w}`);

    // Reverse HOME-shadow warning: adding a skill globally whose name already has an
    // UNMANAGED copy in a home skills dir. Codex/Claude would read that stray copy
    // alongside (or instead of) the managed one; the managed materialization will
    // replace it. Only flag names skillsync does not already track.
    if (isGlobal) await warnUnmanagedGlobal(project.dir, positionals, manifest);

    // Full clone: `add` records central's HEAD commit and the skill's current
    // published version; `sync` later reproduces exactly that pin.
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
      const staged = await stageTargets(project.dir, flatSpecs.map((s) => ({ target: s.target, files: s.files })));
      for (let i = 0; i < flatSpecs.length; i++) {
        const { skill, agent } = flatSpecs[i];
        newPins.get(skill).outputs[agent] = staged.targets[i].hash;
      }
      for (const [skill, pin] of newPins) manifest.skills[skill] = pin;

      await commitStaged(project.dir, {
        staged,
        manifest,
        removeDirs,
        excludeEntries: excludeEntriesFor(manifest),
      });

      // Cache side effect: `add` pins central's HEAD, so the recorded versions ARE
      // central's latest. Best-effort — a cache write must never fail the command.
      try {
        /** @type {Record<string,string>} */
        const observed = {};
        for (const [skill, pin] of newPins) observed[skill] = pin.version;
        await refreshCacheEntry(manifest.source, observed);
      } catch (err) {
        warn(`could not refresh version cache: ${(err && err.message) || err}`);
      }
    } finally {
      await checkout.cleanup();
    }
  });
}

/**
 * Warn for each named skill that is not yet managed here but whose target dir
 * already exists on disk (a pre-existing, unmanaged copy). One warning per stray
 * copy; skills already in the manifest are a normal re-add and never flagged.
 * @param {string} root operating root ($HOME under --global)
 * @param {string[]} skills
 * @param {import('../manifest.js').Manifest} manifest
 */
async function warnUnmanagedGlobal(root, skills, manifest) {
  for (const skill of skills) {
    if (manifest.skills[skill]) continue; // already managed here — a normal update
    for (const agent of AGENTS) {
      const dir = path.join(root, AGENT_TARGETS[agent], skill);
      try {
        await fs.lstat(dir);
        warn(`${skill}: an unmanaged copy already exists at ${dir}; adding it globally will replace that copy`);
      } catch {
        // absent — nothing to warn about
      }
    }
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
  // Reject duplicates: `--agents claude,claude` would otherwise serialize a
  // manifest the tool refuses to read (adversarial-review MAJOR).
  assertNoDuplicates(list, 'agent');
  return list.length > 0 ? list : undefined;
}

/**
 * Throw on any duplicate value in `items` (order preserved for the message).
 * @param {string[]} items
 * @param {string} label
 */
function assertNoDuplicates(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) {
      throw new SkillsyncError('DUPLICATE_INPUT', `duplicate ${label} argument: ${JSON.stringify(item)}`);
    }
    seen.add(item);
  }
}
