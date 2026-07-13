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
import { SkillsyncError } from './util.js';

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
    let checkout = await this.tryCachedCommit(skill, pin);
    if (!checkout) {
      // Authoritative fallback: resolve the version via first-parent history.
      if (!this.full) this.full = await fullClone(this.source);
      const commit = await resolveVersionToCommit(this.full.dir, skill, pin.version);
      checkout = await this.checkout(commit);
    }
    const rel = await findSkillRel(checkout.dir, skill);
    return path.join(checkout.dir, rel);
  }

  /**
   * Accept the cached commit ONLY if it is reachable, contains the skill, and
   * that skill declares exactly the pinned version. Otherwise return null so the
   * caller falls back to version resolution.
   * @param {string} skill
   * @param {import('./manifest.js').SkillPin} pin
   * @returns {Promise<import('./fetch.js').Checkout|null>}
   */
  async tryCachedCommit(skill, pin) {
    try {
      const checkout = await this.checkout(pin.commit);
      const rel = await findSkillRel(checkout.dir, skill);
      const version = await readSkillVersion(path.join(checkout.dir, rel));
      return version === pin.version ? checkout : null;
    } catch (err) {
      if (
        err instanceof SkillsyncError &&
        (err.code === 'UNRESOLVABLE_PIN' || err.code === 'SKILL_NOT_FOUND')
      ) {
        return null;
      }
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
