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

/**
 * Textually remove a set of TOP-LEVEL frontmatter keys from a raw SKILL.md and
 * return the rewritten file. This is the WRITE counterpart to the lenient reader:
 * rather than re-serialize the whole block (which would need a YAML writer and
 * would reflow formatting), it deletes the matching `key:` line plus any indented
 * continuation lines belonging to it (nested mappings, block scalars, sequence
 * items) and leaves every other byte — including the body — untouched. A file with
 * no frontmatter block, or an empty `keys`, is returned unchanged.
 * @param {string} raw
 * @param {Iterable<string>} keys top-level keys to remove
 * @returns {string}
 */
export function stripFrontmatterKeys(raw, keys) {
  const drop = new Set(keys);
  if (drop.size === 0) return raw;

  let bom = '';
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) {
    bom = '﻿';
    text = text.slice(1);
  }
  // Split on LF only (keeps any trailing \r attached to each line) so CRLF and LF
  // files are both rebuilt byte-for-byte apart from the removed lines.
  const lines = text.split('\n');
  const isDelim = (s) => /^---[ \t]*\r?$/.test(s);
  if (lines.length === 0 || !isDelim(lines[0])) return raw; // no frontmatter block

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isDelim(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) return raw; // opening delimiter with no close — leave untouched

  const out = [lines[0]]; // opening ---
  for (let i = 1; i < close; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):/);
    if (m && drop.has(m[1])) {
      // Drop the key line and its indented continuation lines.
      while (i + 1 < close && /^[ \t]/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  for (let i = close; i < lines.length; i++) out.push(lines[i]); // closing --- + body
  return bom + out.join('\n');
}
