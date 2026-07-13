/**
 * Machine-local secret for AUTHENTICATING transaction journals (adversarial-review
 * CRITICAL: journal identity was spoofable — hostname and the absolute checkout
 * path are public values, not authentication).
 *
 * A single random secret is generated once per machine at
 * `$XDG_CONFIG_HOME/skillsync/secret` (0600) and used to HMAC the journal body. A
 * journal that does not carry a valid MAC under this machine's secret was not
 * created by a skillsync transaction on this machine and is refused during
 * recovery. Because the secret is a file (not the hostname), it survives a
 * hostname change and a same-filesystem project move — so a legitimately moved
 * project is recovered rather than stranded.
 *
 * @module secret
 */

import { promises as fs } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { configPath } from './config.js';

/**
 * Absolute path of the machine secret (sibling of the config file, honoring
 * XDG_CONFIG_HOME just like the rest of the tool).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function secretPath(env = process.env) {
  return path.join(path.dirname(configPath(env)), 'secret');
}

/**
 * Read the machine secret, creating it (0600, 32 random bytes) on first use.
 * Concurrency-safe: an exclusive create loses cleanly to a racing creator and
 * falls back to reading the winner's bytes.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Buffer>}
 */
export async function getSecret(env = process.env) {
  const p = secretPath(env);
  try {
    return await fs.readFile(p);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  await fs.mkdir(path.dirname(p), { recursive: true });
  const bytes = randomBytes(32);
  try {
    // Exclusive create: two concurrent processes cannot both write the secret.
    await fs.writeFile(p, bytes, { mode: 0o600, flag: 'wx' });
    return bytes;
  } catch (err) {
    if (err && err.code === 'EEXIST') return fs.readFile(p);
    throw err;
  }
}

/**
 * Canonical bytes signed by the MAC: the journal object WITHOUT its `mac` field,
 * pretty-printed exactly as it is written to disk. Removing `mac` (always added
 * last) and re-serializing reproduces the same bytes on read as on write.
 * @param {Record<string, unknown>} journal
 * @returns {string}
 */
export function journalBody(journal) {
  const { mac, ...rest } = journal;
  void mac;
  return JSON.stringify(rest, null, 2);
}

/**
 * @param {Buffer} secret
 * @param {Record<string, unknown>} journal journal object (mac field ignored)
 * @returns {string} hex HMAC-SHA256 of the journal body
 */
export function journalMac(secret, journal) {
  return createHmac('sha256', secret).update(journalBody(journal), 'utf8').digest('hex');
}

/**
 * Constant-time verification that `journal.mac` is a valid MAC under `secret`.
 * @param {Buffer} secret
 * @param {Record<string, unknown>} journal
 * @returns {boolean}
 */
export function verifyJournalMac(secret, journal) {
  const claimed = journal && typeof journal.mac === 'string' ? journal.mac : '';
  const expected = journalMac(secret, journal);
  if (claimed.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(claimed, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
