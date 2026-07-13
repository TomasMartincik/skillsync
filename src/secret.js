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
import { fsyncDir, fsyncHandle } from './durable.js';
import { SkillsyncError } from './util.js';

/** The secret is exactly this many random bytes. */
const SECRET_BYTES = 32;

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
 *
 * Creation is ATOMIC and DURABLE (round-3 review MAJOR: an exclusive `wx` create
 * published a ZERO-LENGTH file before the bytes landed, so a racing process could
 * read a partial/empty key, sign a journal with it, and have that journal
 * permanently rejected once the real key finished; and neither the file nor its
 * directory was fsynced, so a power loss could keep a project's journal while
 * losing the key that authenticates it):
 *
 *   1. write the 32 bytes to a private temp file (0600) in the same directory;
 *   2. fsync the temp file — the bytes exist before anything can observe them;
 *   3. publish with `link()`, which is atomic and NEVER clobbers an existing
 *      secret: a racing creator loses with EEXIST and reads the winner's bytes.
 *      (`rename` would overwrite the winner's key and reintroduce the same bug in
 *      a different shape, so it is deliberately not used here.)
 *   4. fsync the directory so the entry survives a crash; unlink the temp file.
 *
 * Every secret we read — freshly created or pre-existing — is validated: regular
 * file, exactly 32 bytes, mode 0600 (a loosened mode is repaired in place; a wrong
 * type or length fails loudly rather than being silently re-keyed, which would
 * invalidate every existing journal).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Buffer>}
 */
export async function getSecret(env = process.env) {
  const p = secretPath(env);
  const existing = await readSecret(p);
  if (existing) return existing;

  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.secret.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fh = await fs.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(randomBytes(SECRET_BYTES));
    await fsyncHandle(fh, tmp); // bytes are on disk BEFORE the name is published
  } finally {
    await fh.close();
  }
  try {
    // Atomic publish that loses cleanly: link() fails with EEXIST if a concurrent
    // creator already published, and never overwrites their bytes.
    await fs.link(tmp, p);
    await fsyncDir(dir);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }

  const secret = await readSecret(p);
  if (!secret) {
    throw new SkillsyncError('SECRET_INVALID', `machine secret ${JSON.stringify(p)} vanished immediately after creation`);
  }
  return secret;
}

/**
 * Read and VALIDATE the secret at `p`. Returns null only when it does not exist.
 * Throws SECRET_INVALID for anything that exists but cannot be a valid key —
 * including the zero/partial-length file the old creation race could publish.
 * @param {string} p
 * @returns {Promise<Buffer|null>}
 */
async function readSecret(p) {
  let fh;
  try {
    fh = await fs.open(p, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new SkillsyncError(
        'SECRET_INVALID',
        `machine secret ${JSON.stringify(p)} is not a regular file; remove it and re-run (any in-flight transaction journal must be resolved first)`,
      );
    }
    if (st.size !== SECRET_BYTES) {
      throw new SkillsyncError(
        'SECRET_INVALID',
        `machine secret ${JSON.stringify(p)} is ${st.size} bytes, expected ${SECRET_BYTES} (truncated or corrupt). ` +
          `skillsync will NOT silently re-key: that would reject every journal signed with the real secret. ` +
          `If no transaction is in flight, delete the file and re-run.`,
      );
    }
    const mode = st.mode & 0o777;
    if (mode !== 0o600) await fh.chmod(0o600); // repair a loosened mode in place
    const bytes = Buffer.alloc(SECRET_BYTES);
    const { bytesRead } = await fh.read(bytes, 0, SECRET_BYTES, 0);
    if (bytesRead !== SECRET_BYTES) {
      throw new SkillsyncError('SECRET_INVALID', `machine secret ${JSON.stringify(p)} could not be read in full`);
    }
    return bytes;
  } finally {
    await fh.close();
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
