/**
 * Skill-name grammar validation (adversarial-review MAJOR: names/outputs
 * unvalidated).
 *
 * A skill name is used as BOTH a manifest key and a path component under
 * `.claude/skills/<name>` and `.agents/skills/<name>`. An unvalidated name such
 * as `.`, `..`, or `a/b` lets `path.join` resolve a target that escapes the skill
 * root and can replace an entire skills directory. Names are therefore validated
 * against the Agent Skills naming grammar at every boundary (CLI args, manifest
 * keys, source resolution).
 *
 * Grammar (Agent Skills spec): lowercase ASCII letters, digits, and single
 * hyphens as separators; no leading/trailing/double hyphen; 1..64 chars. This is
 * a strict subset that cannot contain `.`, `/`, `\`, whitespace, or any character
 * that Unicode-normalizes to something else, so a valid name is path-safe and
 * normalization-stable by construction.
 *
 * @module skill-name
 */

import { SkillsyncError } from './util.js';

/** Max length per the Agent Skills spec. */
export const MAX_SKILL_NAME_LEN = 64;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * True if `name` is a syntactically valid, path-safe skill name.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidSkillName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_SKILL_NAME_LEN) return false;
  if (!NAME_RE.test(name)) return false;
  // Defense in depth: reject anything a Unicode normalization would alter, and
  // anything that is not identical to its own basename (no path separators).
  if (name.normalize('NFC') !== name) return false;
  return true;
}

/**
 * Assert a skill name is valid, throwing BAD_SKILL_NAME otherwise. Returns the
 * name unchanged for convenient inline use.
 * @param {unknown} name
 * @param {string} [where] context for the error message
 * @returns {string}
 */
export function assertSkillName(name, where = 'skill name') {
  if (!isValidSkillName(name)) {
    throw new SkillsyncError(
      'BAD_SKILL_NAME',
      `invalid ${where} ${JSON.stringify(name)}: must match the Agent Skills grammar ` +
        `(lowercase letters, digits, single hyphens; 1-${MAX_SKILL_NAME_LEN} chars; no ".", "..", or slashes)`,
    );
  }
  return /** @type {string} */ (name);
}
