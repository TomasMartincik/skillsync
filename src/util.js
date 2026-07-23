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

/**
 * Sanitize a single-line metadata string (name/description) for terminal display:
 * strip control characters (including ESC, so untrusted input can never drive the
 * terminal) and trim.
 * @param {unknown} str
 * @returns {string}
 */
export function sanitizeMetadata(str) {
  return String(str ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/** @param {...unknown} args */
export function log(...args) {
  console.log(...args);
}

/** @param {...unknown} args */
export function warn(...args) {
  console.error('warning:', ...args);
}
