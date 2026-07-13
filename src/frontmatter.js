/**
 * Hand-rolled YAML frontmatter reader — zero deps, tuned for Agent Skill
 * frontmatter (adversarial-review MAJOR: the strict subset rejected ordinary,
 * valid YAML — escaped quotes, folded/literal block scalars, nested mappings).
 *
 * Philosophy: extract the keys skillsync needs (`name`, `version`, and the
 * display-only `description`) ROBUSTLY, and safely IGNORE any other valid YAML
 * construct rather than rejecting the whole block. A skill that carries a nested
 * metadata mapping, a `>-`/`|` multi-line description, or an escaped quote is a
 * perfectly valid Agent Skill and must parse.
 *
 * Supported at the top level:
 *   - `key: value` scalars — double-quoted (with `\"`, `\\`, `\n`, … escapes),
 *     single-quoted (with `''` escape), or bare (trailing ` # comment` stripped);
 *     booleans, `null`/`~`, integers; decimals kept as STRINGS (version pins).
 *   - inline `[a, b]` and block (`- a`) sequences of scalars.
 *   - folded `>` and literal `|` block scalars (chomping/indent indicators
 *     tolerated); the de-indented text becomes the value.
 *   - nested mappings (indented children) — consumed and ignored, not rejected.
 * Unrecognized top-level lines are ignored leniently. It still FAILS CLOSED on an
 * unterminated quote and on a duplicated `name`/`version` (identity keys must be
 * unambiguous). It never evaluates a `---js` block.
 *
 * @module frontmatter
 */

import { SkillsyncError } from './util.js';

const DELIM_RE = /^---[ \t]*$/;
/** Keys whose duplication is an unambiguous error (identity). */
const IDENTITY_KEYS = new Set(['name', 'version']);

/**
 * @typedef {Object} Frontmatter
 * @property {Record<string, unknown>} data parsed key/value map (empty if no block)
 * @property {string} body the content after the frontmatter block
 */

/**
 * Parse a double-quoted scalar starting at index 0 of `s` (s[0] === '"').
 * @param {string} s
 * @returns {{ value: string, endIdx: number }} endIdx = index of the closing quote
 */
function parseDoubleQuoted(s) {
  const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ' };
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) break; // trailing backslash => unterminated
      out += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
      i++;
      continue;
    }
    if (ch === '"') return { value: out, endIdx: i };
    out += ch;
  }
  throw new SkillsyncError('BAD_FRONTMATTER', `unterminated double-quoted string: ${s}`);
}

/**
 * Parse a single-quoted scalar starting at index 0 of `s` (s[0] === "'").
 * @param {string} s
 * @returns {{ value: string, endIdx: number }}
 */
function parseSingleQuoted(s) {
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      if (s[i + 1] === "'") { out += "'"; i++; continue; } // '' escapes a quote
      return { value: out, endIdx: i };
    }
    out += ch;
  }
  throw new SkillsyncError('BAD_FRONTMATTER', `unterminated single-quoted string: ${s}`);
}

/**
 * Parse a scalar token (quoted string with escapes, bool, null, number, or bare
 * string). Fails closed on an unterminated quote.
 * @param {string} raw
 * @returns {unknown}
 */
function parseScalar(raw) {
  let s = raw.replace(/^[ \t]+/, '');
  if (s === '') return '';
  const first = s[0];
  if (first === '"' || first === "'") {
    const { value, endIdx } = first === '"' ? parseDoubleQuoted(s) : parseSingleQuoted(s);
    const after = s.slice(endIdx + 1).trim();
    if (after !== '' && !after.startsWith('#')) {
      throw new SkillsyncError('BAD_FRONTMATTER', `unexpected trailing content after quoted string: ${raw.trim()}`);
    }
    return value;
  }
  // Strip a trailing inline comment for unquoted scalars: ` # ...`
  const cIdx = s.search(/\s#/);
  if (cIdx !== -1) s = s.slice(0, cIdx);
  s = s.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^[+-]?\d+$/.test(s)) return Number.parseInt(s, 10);
  // Decimal tokens (e.g. version "1.10") are kept as STRINGS on purpose.
  return s;
}

/**
 * Split a flow-sequence body on commas that are NOT inside quotes.
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
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) { cur += inner[++i]; continue; }
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
  if (quote) throw new SkillsyncError('BAD_FRONTMATTER', `unterminated quoted flow item: [${inner}]`);
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

/** @param {string} line @returns {number} count of leading space/tab */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Consume a block scalar (`|`/`>` and variants) starting after line `start`,
 * returning the de-indented text and the last consumed line index.
 * @param {string[]} lines
 * @param {number} start index of the key line
 * @param {boolean} folded true for `>` (join with spaces), false for `|` (newlines)
 * @returns {{ value: string, last: number }}
 */
function consumeBlockScalar(lines, start, folded) {
  /** @type {string[]} */
  const raw = [];
  let minIndent = Infinity;
  let j = start + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') { raw.push(''); continue; }
    if (indentOf(l) === 0) break; // dedent to a sibling top-level key
    minIndent = Math.min(minIndent, indentOf(l));
    raw.push(l);
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  const text = raw.map((l) => (l === '' ? '' : l.slice(minIndent))).join(folded ? ' ' : '\n').trim();
  return { value: text, last: j - 1 };
}

/**
 * Consume an indented block that is NOT ours to interpret (a nested mapping),
 * returning the last consumed line index. The value is ignored.
 * @param {string[]} lines
 * @param {number} start index of the key line
 * @returns {number} last consumed line index
 */
function consumeNested(lines, start) {
  let j = start + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') continue;
    if (indentOf(l) === 0) break;
  }
  return j - 1;
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
  let sawKey = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Indented lines that reach the top loop are leftovers of a construct we did
    // not consume (e.g. an orphan nested child) — ignore leniently.
    if (indentOf(line) > 0) continue;

    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) continue; // not a top-level key:value — ignore leniently
    sawKey = true;
    const key = m[1];
    const rest = m[2].replace(/^[ \t]/, ''); // drop the single space after the colon
    const trimmed = rest.trim();

    if (Object.prototype.hasOwnProperty.call(data, key)) {
      if (IDENTITY_KEYS.has(key)) {
        throw new SkillsyncError('BAD_FRONTMATTER', `duplicate frontmatter key: ${key}`);
      }
      // Non-identity duplicate: last value wins, silently.
    }

    // Block scalar: `key: |`, `key: >`, with optional chomp/indent indicators.
    if (/^[|>][+-]?\d*[ \t]*(#.*)?$/.test(trimmed)) {
      const { value, last } = consumeBlockScalar(lines, i, trimmed[0] === '>');
      data[key] = value;
      i = last;
      continue;
    }

    if (trimmed === '') {
      // Empty value: a block sequence, a nested mapping, or truly empty.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && indentOf(lines[j]) > 0) {
        if (/^[ \t]+-([ \t].*|)$/.test(lines[j])) {
          // Block sequence of scalars.
          /** @type {unknown[]} */
          const items = [];
          let k = i + 1;
          while (k < lines.length) {
            const item = lines[k];
            if (item.trim() === '') { k++; continue; }
            const im = item.match(/^[ \t]+-[ \t]*(.*)$/);
            if (!im) break;
            items.push(parseScalar(im[1]));
            k++;
          }
          data[key] = items;
          i = k - 1;
          continue;
        }
        // Nested mapping — consume and ignore.
        data[key] = {};
        i = consumeNested(lines, i);
        continue;
      }
      data[key] = '';
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      data[key] = parseFlowSequence(trimmed);
    } else {
      data[key] = parseScalar(rest);
    }
  }

  if (!sawKey && block.trim() !== '') {
    throw new SkillsyncError('BAD_FRONTMATTER', 'frontmatter block could not be parsed');
  }
  return { data, body };
}
