/**
 * `skillsync sync` — materialize EXACTLY what the manifest records.
 *
 * The pin is the recorded `version`; the recorded `commit` is a resolution cache.
 * sync never advances pins even if central has moved on (reproducibility is the
 * core promise). Fetch protocol: try the cached commit; if it is unreachable,
 * resolve the version to a commit via first-parent history; verify the fetched
 * tree's hash equals the recorded `sourceHash` before touching project files.
 *
 * Drift protection: a materialized copy whose hash ≠ the recorded output hash is
 * skipped with a warning; `--force` overwrites it.
 *
 * @module commands/sync
 */

import path from 'node:path';
import { readManifest, pinAgents } from '../manifest.js';
import { preflight } from '../git.js';
import {
  checkoutCommit,
  fullClone,
  resolveVersionToCommit,
  findSkillRel,
} from '../fetch.js';
import { hashSkillTree, hashFiles } from '../hash.js';
import { adaptForAgent } from '../adapt.js';
import { runTransaction, hashMaterialized } from '../materialize.js';
import { excludeEntriesFor, targetDir } from '../plan.js';
import { SkillsyncError, log, warn } from '../util.js';
import { resolveProject, withLock, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function sync(argv, ctx) {
  const { flags } = parseArgs(argv);
  const force = flags.force === true;
  const project = resolveProject(ctx.cwd);
  const manifest = await readManifest(project.manifestPath);
  const { warnings } = await preflight(ctx.cwd, { mode: manifest.mode, manifestPath: project.manifestPath });
  for (const w of warnings) warn(w);

  const names = Object.keys(manifest.skills);
  if (names.length === 0) {
    log('nothing to sync (no skills in manifest)');
    return;
  }

  // Decide which skills need (re)materialization.
  /** @type {string[]} */
  const toMaterialize = [];
  for (const skill of names) {
    const pin = manifest.skills[skill];
    const statuses = await Promise.all(
      pinAgents(pin).map(async (agent) => materializedStatus(ctx.cwd, agent, skill, pin.outputs[agent])),
    );
    if (statuses.every((s) => s === 'ok')) continue;
    if (!force && statuses.some((s) => s === 'drifted')) {
      warn(`${skill}: materialized copy has drifted; skipping (use --force to overwrite)`);
      continue;
    }
    toMaterialize.push(skill);
  }

  if (toMaterialize.length === 0) {
    log('already in sync');
    return;
  }

  const resolver = new PinResolver(manifest.source);
  try {
    /** @type {import('../materialize.js').TargetWrite[]} */
    const targets = [];
    for (const skill of toMaterialize) {
      const pin = manifest.skills[skill];
      const skillDir = await resolver.resolve(skill, pin);
      // Integrity: the fetched tree must match the recorded source hash.
      const sourceHash = await hashSkillTree(skillDir);
      if (sourceHash !== pin.sourceHash) {
        throw new SkillsyncError(
          'PIN_MISMATCH',
          `${skill}: fetched tree hash ${sourceHash} != recorded ${pin.sourceHash}; refusing to materialize`,
        );
      }
      for (const agent of pinAgents(pin)) {
        const files = await adaptForAgent(skillDir, agent);
        const outHash = await hashFiles(files);
        if (outHash !== pin.outputs[agent]) {
          throw new SkillsyncError(
            'PIN_MISMATCH',
            `${skill}: ${agent} output hash ${outHash} != recorded ${pin.outputs[agent]}`,
          );
        }
        targets.push({ target: targetDir(agent, skill), files });
      }
      log(`sync ${skill}@${pin.version}`);
    }

    await withLock(ctx.cwd, async () => {
      await runTransaction(ctx.cwd, {
        manifest, // unchanged: sync does not advance pins
        targets,
        removeDirs: [],
        excludeEntries: excludeEntriesFor(manifest),
      });
    });
  } finally {
    await resolver.cleanup();
  }
}

/**
 * Classify a materialized copy.
 * @param {string} projectDir
 * @param {string} agent
 * @param {string} skill
 * @param {string} recorded recorded output hash
 * @returns {Promise<'ok'|'missing'|'drifted'>}
 */
async function materializedStatus(projectDir, agent, skill, recorded) {
  const dir = path.join(projectDir, targetDir(agent, skill));
  let actual;
  try {
    actual = await hashMaterialized(dir);
  } catch {
    return 'missing';
  }
  return actual === recorded ? 'ok' : 'drifted';
}

/**
 * Resolves version pins to on-disk skill dirs, caching checkouts by commit and
 * lazily full-cloning only when a cached commit is unreachable.
 */
class PinResolver {
  /** @param {string} source */
  constructor(source) {
    this.source = source;
    /** @type {Map<string, import('../fetch.js').Checkout>} */
    this.byCommit = new Map();
    /** @type {import('../fetch.js').Checkout|null} */
    this.full = null;
  }

  /**
   * @param {string} skill
   * @param {import('../manifest.js').SkillPin} pin
   * @returns {Promise<string>} absolute path to the skill dir
   */
  async resolve(skill, pin) {
    // Fast path: the cached commit.
    let commit = pin.commit;
    let checkout = await this.checkout(commit).catch((err) => {
      if (err instanceof SkillsyncError && err.code === 'UNRESOLVABLE_PIN') return null;
      throw err;
    });
    if (!checkout) {
      // Fallback: resolve the version to a commit via history.
      if (!this.full) this.full = await fullClone(this.source);
      commit = await resolveVersionToCommit(this.full.dir, skill, pin.version);
      checkout = await this.checkout(commit);
    }
    const rel = await findSkillRel(checkout.dir, skill);
    return path.join(checkout.dir, rel);
  }

  /**
   * @param {string} commit
   * @returns {Promise<import('../fetch.js').Checkout>}
   */
  async checkout(commit) {
    const cached = this.byCommit.get(commit);
    if (cached) return cached;
    const c = await checkoutCommit(this.source, commit);
    this.byCommit.set(commit, c);
    return c;
  }

  async cleanup() {
    for (const c of this.byCommit.values()) await c.cleanup();
    if (this.full) await this.full.cleanup();
  }
}
