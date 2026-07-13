/**
 * Hand-rolled YAML frontmatter parser — a deliberately tiny subset, zero deps.
 *
 * Supported subset (documented in README):
 *   - A leading frontmatter block delimited by `---` on its own line, then the
 *     block, then a closing `---` on its own line. CRLF and LF both accepted.
 *   - Inside the block, only TOP-LEVEL `key: value` entries. No nested maps.
 *   - Keys: unquoted, matching /[A-Za-z0-9_-]+/.
 *   - Scalar values:
 *       * double- or single-quoted strings (no escape processing beyond the
 *         quotes themselves; `\"` inside a double-quoted string is NOT special —
 *         keep values simple),
 *       * unquoted strings (trimmed; everything up to an optional ` #` comment),
 *       * booleans `true`/`false`, `null`/`~`, and integers. Decimal tokens
 *         (e.g. `1.10`) are kept as strings so version pins are never truncated.
 *   - Sequences: inline flow `[a, b, c]` OR block form:
 *         key:
 *           - a
 *           - b
 *     Sequence items are parsed as scalars by the same rules.
 *   - Full-line comments (`# ...`) and blank lines are ignored.
 *
 * Anything outside this subset (anchors, multi-line scalars, nested maps,
 * merge keys, explicit tags) is NOT supported and will either be ignored or
 * throw. Skill frontmatter in this system stays within the subset by convention.
 *
 * @module frontmatter
 */

import { SkillsyncError } from './util.js';

const DELIM_RE = /^---[ \t]*$/;

/**
 * @typedef {Object} Frontmatter
 * @property {Record<string, unknown>} data parsed key/value map (empty if no block)
 * @property {string} body the content after the frontmatter block
 */

/**
 * Parse a scalar token (quoted string, bool, null, number, or bare string).
 * Fails closed on malformed quoting rather than silently mis-parsing.
 * @param {string} raw
 * @returns {unknown}
 */
function parseScalar(raw) {
  let s = raw.trim();
  if (s === '') return '';
  const first = s[0];
  if (first === '"' || first === "'") {
    // Find the matching closing quote (no escapes in this subset), then allow an
    // optional trailing ` # comment` after it. `version: "1.0" # release` must
    // yield "1.0", not a literal including the quotes and comment.
    const close = s.indexOf(first, 1);
    if (close === -1) {
      throw new SkillsyncError('BAD_FRONTMATTER', `unterminated quoted string: ${raw.trim()}`);
    }
    const after = s.slice(close + 1).trim();
    if (after !== '' && !after.startsWith('#')) {
      throw new SkillsyncError(
        'BAD_FRONTMATTER',
        `unexpected trailing content after quoted string: ${raw.trim()}`,
      );
    }
    return s.slice(1, close);
  }
  // Strip a trailing inline comment for unquoted scalars: ` # ...`
  const cIdx = s.search(/\s#/);
  if (cIdx !== -1) s = s.slice(0, cIdx).trim();
  if (s === '' ) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^[+-]?\d+$/.test(s)) return Number.parseInt(s, 10);
  // Decimal tokens (e.g. version "1.10") are kept as STRINGS on purpose: coercing
  // to float is lossy (1.10 -> 1.1) and would corrupt version pins.
  return s;
}

/**
 * Split a flow-sequence body on commas that are NOT inside quotes, so
 * `[a, "b,c", d]` yields three items. Fails closed on unterminated quotes.
 * @param {string} inner content between the brackets
 * @returns {string[]}
 */
function splitFlowItems(inner) {
  /** @type {string[]} */
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (quote) {
    throw new SkillsyncError('BAD_FRONTMATTER', `unterminated quoted flow item: [${inner}]`);
  }
  items.push(cur);
  return items;
}

/**
 * Parse an inline flow sequence `[a, b, c]`.
 * @param {string} raw includes surrounding brackets
 * @returns {unknown[]}
 */
function parseFlowSequence(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return splitFlowItems(inner).map((part) => parseScalar(part));
}

/**
 * Split a raw file into its frontmatter block text and body.
 * @param {string} raw
 * @returns {{ block: string|null, body: string }}
 */
function splitBlock(raw) {
  // Strip a leading UTF-8 BOM so a file that begins with it still exposes its
  // frontmatter (a BOM before `---` must not make the block disappear).
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || !DELIM_RE.test(lines[0])) {
    return { block: null, body: raw };
  }
  for (let i = 1; i < lines.length; i++) {
    if (DELIM_RE.test(lines[i])) {
      return {
        block: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }
  // Opening delimiter with no close: no valid frontmatter.
  return { block: null, body: raw };
}

/**
 * Parse frontmatter from a raw SKILL.md string.
 * @param {string} raw
 * @returns {Frontmatter}
 */
export function parseFrontmatter(raw) {
  const { block, body } = splitBlock(raw);
  if (block === null) return { data: {}, body };

  /** @type {Record<string, unknown>} */
  const data = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) {
      // Fail closed: an unrecognized top-level line (stray block item at root,
      // nested map, tab-indented key, or other unsupported construct) is an
      // error rather than something to silently drop. A misleading partial parse
      // is worse than an explicit rejection.
      throw new SkillsyncError(
        'BAD_FRONTMATTER',
        `unsupported frontmatter line: ${JSON.stringify(line)}`,
      );
    }
    const key = m[1];
    const rest = m[2];

    if (Object.prototype.hasOwnProperty.call(data, key)) {
      throw new SkillsyncError('BAD_FRONTMATTER', `duplicate frontmatter key: ${key}`);
    }

    if (rest === '') {
      // Possible block sequence following on subsequent indented `- ` lines.
      /** @type {unknown[]} */
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = lines[j];
        if (item.trim() === '') { j++; continue; }
        const im = item.match(/^[ \t]+-[ \t]*(.*)$/);
        if (!im) break;
        items.push(parseScalar(im[1]));
        j++;
      }
      if (items.length > 0) {
        data[key] = items;
        i = j - 1;
      } else {
        data[key] = '';
      }
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = parseFlowSequence(rest);
    } else {
      data[key] = parseScalar(rest);
    }
  }

  if (Object.keys(data).length === 0 && block.trim() !== '') {
    // A non-empty block that parsed to nothing signals malformed input.
    throw new SkillsyncError('BAD_FRONTMATTER', 'frontmatter block could not be parsed');
  }
  return { data, body };
}
