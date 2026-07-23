/**
 * `skillsync update [skill…]` — advance (or, with `--to`, retarget) manifest pins
 * against central's latest published versions, then re-materialize via the same
 * path `add` uses (update is add-with-a-different-pin, not a new pipeline).
 *
 * Detection is version-only (per #5): compare central's latest declared version
 * against the manifest's recorded version.
 *
 *   - bare `update`      applies every pending MINOR (same major); LISTS pending
 *                        majors without touching them.
 *   - `--major`          also applies pending majors, for named skills (or all).
 *   - `--to <version>`   materializes an EXACT version (both directions); the
 *                        explicit version is itself the consent. Named skill(s)
 *                        required.
 *   - `--preview`        prints the version+commit changes without touching files.
 *   - `--force`          overwrites a drifted/anomalous copy (skipped otherwise).
 *
 * The whole read → plan → install runs under the project lock (preview is
 * read-only and takes no lock).
 *
 * @module commands/update
 */

import path from 'node:path';
import { readManifest } from '../manifest.js';
import { preflight } from '../git.js';
import {
  fullClone,
  checkoutCommit,
  findSkillRel,
  resolveVersionToCommit,
  centralVersion,
  classifyVersion,
  compareVersions,
  normalizeVersion,
} from '../fetch.js';
import { buildSkillPlan } from '../skill-pin.js';
import { stageTargets, commitStaged } from '../materialize.js';
import { copyStatus } from '../materialized-status.js';
import { excludeEntriesFor } from '../plan.js';
import { refreshFromCentral } from '../version-cache.js';
import { assertSkillName } from '../skill-name.js';
import { SkillsyncError, log, warn } from '../util.js';
import { resolveProject, withLock, parseArgs } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function update(argv, ctx) {
  const { positionals, flags } = parseArgs(argv, { valueFlags: ['to'] });
  for (const skill of positionals) assertSkillName(skill, 'skill argument');
  assertNoDuplicates(positionals);

  const major = flags.major === true;
  const force = flags.force === true;
  const preview = flags.preview === true;

  let to = null;
  if (flags.to !== undefined) {
    to = typeof flags.to === 'string' ? normalizeVersion(flags.to) : null;
    if (to === null) throw new SkillsyncError('USAGE', 'usage: skillsync update <skill> --to <major.minor>');
    if (major) throw new SkillsyncError('USAGE', '--to and --major cannot be combined');
    if (positionals.length === 0) throw new SkillsyncError('USAGE', 'update --to <version> requires a named skill');
  }

  const project = resolveProject(ctx.cwd);
  const opts = { positionals, major, force, to, preview };

  if (preview) {
    const manifest = await readManifest(project.manifestPath);
    await run(ctx, manifest, opts);
    return;
  }
  await withLock(ctx.cwd, async () => {
    const manifest = await readManifest(project.manifestPath);
    const { warnings } = await preflight(ctx.cwd, { mode: manifest.mode, manifestPath: project.manifestPath });
    for (const w of warnings) warn(w);
    await run(ctx, manifest, opts);
  });
}

/**
 * @param {{ cwd: string }} ctx
 * @param {import('../manifest.js').Manifest} manifest
 * @param {{ positionals: string[], major: boolean, force: boolean, to: string|null, preview: boolean }} opts
 */
async function run(ctx, manifest, opts) {
  const { positionals, major, force, to, preview } = opts;
  const targets = positionals.length > 0 ? positionals : Object.keys(manifest.skills).sort();
  for (const skill of targets) {
    if (!manifest.skills[skill]) throw new SkillsyncError('UNKNOWN_SKILL', `skill "${skill}" is not in the manifest`);
  }

  const checkout = await fullClone(manifest.source);
  /** @type {import('../fetch.js').Checkout[]} */
  const extra = [];
  try {
    // Central latest for every manifest skill (drives classification + the cache).
    /** @type {Record<string, string|null>} */
    const centralMap = {};
    for (const name of Object.keys(manifest.skills)) centralMap[name] = await centralVersion(checkout.dir, name);
    await refreshFromCentral(manifest.source, centralMap);

    /** @type {{ skill: string, agent: string, target: string, files: import('../input-policy.js').SkillFile[] }[]} */
    const flatSpecs = [];
    /** @type {Map<string, import('../manifest.js').SkillPin>} */
    const newPins = new Map();
    let pendingMajors = 0;

    for (const skill of targets) {
      const pin = manifest.skills[skill];
      const recorded = pin.version;

      /** @type {string} */
      let targetVersion;
      /** @type {string} */
      let targetCommit;
      /** @type {string} */
      let kind;

      if (to) {
        if (compareVersions(to, recorded) === 0) {
          log(`${skill}: already at ${to}`);
          continue;
        }
        targetVersion = to;
        targetCommit = await resolveVersionToCommit(checkout.dir, skill, to);
        kind = compareVersions(to, recorded) < 0 ? 'downgrade' : 'upgrade';
      } else {
        const central = centralMap[skill];
        const cls = classifyVersion(recorded, central);
        if (cls === 'deleted') {
          warn(`${skill}: deleted centrally; not updating`);
          continue;
        }
        if (cls === 'current') continue;
        if (cls === 'major' && !major) {
          pendingMajors++;
          log(`${skill}: major update ${recorded} -> ${central} available (use --major to apply)`);
          continue;
        }
        targetVersion = /** @type {string} */ (central);
        targetCommit = checkout.commit; // central HEAD
        kind = cls;
      }

      // Anomaly policy: never clobber a drifted/anomalous copy without --force.
      const { worst } = await copyStatus(ctx.cwd, skill, pin);
      if (!force && (worst === 'drifted' || worst === 'anomaly')) {
        warn(`${skill}: materialized copy has drifted or anomalous content; skipping (use --force to overwrite)`);
        continue;
      }

      if (preview) {
        log(`would update ${skill} ${recorded} -> ${targetVersion} (${kind}) [${targetCommit.slice(0, 7)}]`);
        newPins.set(skill, pin); // marker only, so the "nothing to do" summary is right
        continue;
      }

      // Resolve a checkout of the target tree: reuse the full clone when we are
      // materializing central HEAD, otherwise fetch the exact commit.
      let skillDir;
      if (targetCommit === checkout.commit) {
        skillDir = path.join(checkout.dir, await findSkillRel(checkout.dir, skill));
      } else {
        const co = await checkoutCommit(manifest.source, targetCommit);
        extra.push(co);
        skillDir = path.join(co.dir, await findSkillRel(co.dir, skill));
      }
      const { pin: nextPin, specs } = await buildSkillPlan({
        skill,
        skillDir,
        commit: targetCommit,
        agentsFilter: pin.agents,
      });
      newPins.set(skill, nextPin);
      for (const s of specs) flatSpecs.push({ skill, ...s });
      log(`update ${skill} ${recorded} -> ${nextPin.version} (${kind})`);
    }

    if (preview) {
      if (newPins.size === 0) log('preview: nothing to update');
      return;
    }
    if (newPins.size === 0) {
      log(pendingMajors > 0 ? `${pendingMajors} major update(s) pending; re-run with --major` : 'everything up to date');
      return;
    }

    // Stage all targets, record the AUTHORITATIVE staged hash per output (as `add`).
    const staged = await stageTargets(ctx.cwd, flatSpecs.map((s) => ({ target: s.target, files: s.files })));
    for (let i = 0; i < flatSpecs.length; i++) {
      const { skill, agent } = flatSpecs[i];
      newPins.get(skill).outputs[agent] = staged.targets[i].hash;
    }
    for (const [skill, pin] of newPins) manifest.skills[skill] = pin;

    await commitStaged(ctx.cwd, {
      staged,
      manifest,
      removeDirs: [],
      excludeEntries: excludeEntriesFor(manifest),
    });
  } finally {
    await checkout.cleanup();
    for (const co of extra) await co.cleanup();
  }
}

/**
 * @param {string[]} items
 */
function assertNoDuplicates(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) throw new SkillsyncError('DUPLICATE_INPUT', `duplicate skill argument: ${JSON.stringify(item)}`);
    seen.add(item);
  }
}
