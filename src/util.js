/**
 * Small shared helpers: typed error, terminal-escape sanitizing, logging.
 * @module util
 */

/**
 * An error carrying a stable machine-readable code, used for clean CLI exits
 * and for asserting failure modes in tests.
 */
export class SkillsyncError extends Error {
  /**
   * @param {string} code stable identifier (e.g. 'UNRESOLVABLE_PIN')
   * @param {string} message human-readable message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SkillsyncError';
    this.code = code;
  }
}

// Terminal-escape / control-char stripping. Borrowed in spirit from the
// reference implementation (vercel-labs/skills src/sanitize.ts): skill
// names/descriptions are untrusted input and must never drive the terminal.
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;
const C1_RE = /[\x80-\x9f]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;

/**
 * Strip terminal escape sequences and dangerous control characters (keeps \t, \n).
 * @param {string} str
 * @returns {string}
 */
export function stripTerminalEscapes(str) {
  return String(str)
    .replace(OSC_RE, '')
    .replace(DCS_PM_APC_RE, '')
    .replace(CSI_RE, '')
    .replace(SIMPLE_ESC_RE, '')
    .replace(C1_RE, '')
    .replace(CONTROL_RE, '');
}

/**
 * Sanitize a single-line metadata string (name/description) for terminal display.
 * @param {unknown} str
 * @returns {string}
 */
export function sanitizeMetadata(str) {
  return stripTerminalEscapes(String(str ?? ''))
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** @param {...unknown} args */
export function log(...args) {
  console.log(...args);
}

/** @param {...unknown} args */
export function warn(...args) {
  console.error('warning:', ...args);
}
