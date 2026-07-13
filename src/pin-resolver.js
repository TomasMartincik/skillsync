/**
 * Version-authoritative pin resolution (adversarial-review MAJOR: the cache
 * overrode the pin). Resolves a manifest pin to an on-disk skill directory,
 * treating the recorded `commit` as a mere cache: it is accepted only if the
 * skill AT that commit actually declares the pinned version; otherwise the
 * version is resolved authoritatively from first-parent history.
 *
 * Extracted from `sync` as a reusable seam so the update/status machinery
 * (ticket #13) shares exactly this resolution discipline rather than
 * reimplementing it.
 *
 * @module pin-resolver
 */

import path from 'node:path';
import {
  checkoutCommit,
  fullClone,
  resolveVersionToCommit,
  findSkillRel,
  readSkillVersion,
} from './fetch.js';
import { hashSkillTree } from './hash.js';
import { SkillsyncError } from './util.js';

/**
 * Error codes from probing a cached commit that mean "the cache is stale/wrong,
 * fall back to authoritative version resolution" rather than a hard failure.
 */
const FALLBACK_CODES = new Set([
  'UNRESOLVABLE_PIN',
  'SKILL_NOT_FOUND',
  'MISSING_VERSION',
  'BAD_FRONTMATTER',
  'NAME_MISMATCH',
  'AMBIGUOUS_SKILL',
]);

export class PinResolver {
  /** @param {string} source */
  constructor(source) {
    this.source = source;
    /** @type {Map<string, import('./fetch.js').Checkout>} */
    this.byCommit = new Map();
    /** @type {import('./fetch.js').Checkout|null} */
    this.full = null;
  }

  /**
   * @param {string} skill
   * @param {import('./manifest.js').SkillPin} pin
   * @returns {Promise<string>} absolute path to the skill dir
   */
  async resolve(skill, pin) {
    const cached = await this.tryCachedCommit(skill, pin);
    if (cached) return cached;
    // Authoritative fallback: resolve the version via first-parent history.
    if (!this.full) this.full = await fullClone(this.source);
    const commit = await resolveVersionToCommit(this.full.dir, skill, pin.version);
    const checkout = await this.checkout(commit);
    const rel = await findSkillRel(checkout.dir, skill);
    return path.join(checkout.dir, rel);
  }

  /**
   * Accept the cached commit ONLY if it is reachable, contains the skill, that
   * skill declares exactly the pinned version, AND its tree matches the recorded
   * `sourceHash`. Any other outcome (unreachable, wrong version, bad/missing
   * frontmatter, or the SAME version on a DIFFERENT tree — an off-first-parent
   * cache) returns null so the caller resolves authoritatively (adversarial-review
   * residue: fall back on wrong-tree / bad-frontmatter caches, not only
   * unresolvable ones).
   * @param {string} skill
   * @param {import('./manifest.js').SkillPin} pin
   * @returns {Promise<string|null>} absolute skill dir, or null to fall back
   */
  async tryCachedCommit(skill, pin) {
    try {
      const checkout = await this.checkout(pin.commit);
      const rel = await findSkillRel(checkout.dir, skill);
      const skillDir = path.join(checkout.dir, rel);
      const version = await readSkillVersion(skillDir);
      if (version !== pin.version) return null;
      // Tree authority: a cached commit declaring the right version but carrying a
      // different tree (wrong branch/off-first-parent) must NOT be accepted.
      const sourceHash = await hashSkillTree(skillDir);
      if (sourceHash !== pin.sourceHash) return null;
      return skillDir;
    } catch (err) {
      if (err instanceof SkillsyncError && FALLBACK_CODES.has(err.code)) return null;
      throw err;
    }
  }

  /**
   * @param {string} commit
   * @returns {Promise<import('./fetch.js').Checkout>}
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
