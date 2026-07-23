/**
 * Tolerant SKILL.md frontmatter reader — zero deps.
 *
 * skillsync consumes exactly two frontmatter fields: `name` (checked against the
 * skill directory name) and `version` (re-constrained by `\d+\.\d+` normalization
 * downstream). So this reader does the minimum needed to extract top-level scalars
 * ROBUSTLY and IGNORE everything else rather than rejecting a file for some exotic
 * YAML construct it does not need to understand.
 *
 * Behavior: read the leading `---`-delimited block (LF or CRLF, BOM tolerant);
 * for each TOP-LEVEL `key: value` line, strip matching surrounding quotes off the
 * value and record it as a string. Indented lines (nested mappings, block scalars,
 * sequence items) and non-`key: value` lines are skipped. The only fail-closed case
 * is a DUPLICATED `name`/`version` — identity keys must be unambiguous. It never
 * evaluates a `---js` block.
 *
 * @module frontmatter
 */

import { SkillsyncError } from './util.js';

const DELIM_RE = /^---[ \t]*$/;
/** Keys whose duplication is an unambiguous error (identity). */
const IDENTITY_KEYS = new Set(['name', 'version']);

/**
 * @typedef {Object} Frontmatter
 * @property {Record<string, string>} data top-level scalar key/value map (empty if no block)
 * @property {string} body the content after the frontmatter block
 */

/**
 * Split a raw file into its frontmatter block text and body.
 * @param {string} raw
 * @returns {{ block: string|null, body: string }}
 */
function splitBlock(raw) {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip leading BOM
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || !DELIM_RE.test(lines[0])) return { block: null, body: raw };
  for (let i = 1; i < lines.length; i++) {
    if (DELIM_RE.test(lines[i])) {
      return { block: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
    }
  }
  return { block: null, body: raw }; // opening delimiter with no close
}

/**
 * Reduce a raw value to a scalar string: strip a trailing ` # comment` on an
 * unquoted value, or return the text inside matching surrounding quotes.
 * @param {string} raw
 * @returns {string}
 */
function parseValue(raw) {
  let s = raw.trim();
  if (s === '') return '';
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end !== -1) return s.slice(1, end); // inside the quotes; ignore any trailing text
    return s; // unterminated quote: leniently keep as-is (never fail closed here)
  }
  const c = s.search(/\s#/);
  if (c !== -1) s = s.slice(0, c);
  return s.trim();
}

/**
 * Parse frontmatter from a raw SKILL.md string.
 * @param {string} raw
 * @returns {Frontmatter}
 */
export function parseFrontmatter(raw) {
  const { block, body } = splitBlock(raw);
  if (block === null) return { data: {}, body };

  /** @type {Record<string, string>} */
  const data = {};
  for (const line of block.split('\n')) {
    if (line === '' || /^[ \t]/.test(line)) continue; // blank or indented (nested/block) — skip
    if (line.startsWith('#')) continue; // comment
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) continue; // not a top-level key: value line — ignore leniently
    const key = m[1];
    if (IDENTITY_KEYS.has(key) && Object.prototype.hasOwnProperty.call(data, key)) {
      throw new SkillsyncError('BAD_FRONTMATTER', `duplicate frontmatter key: ${key}`);
    }
    data[key] = parseValue(m[2]);
  }
  return { data, body };
}
