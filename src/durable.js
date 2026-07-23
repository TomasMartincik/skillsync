/**
 * The single durability primitive.
 *
 * skillsync's crash story is idempotent re-run, so the one fsync that matters is
 * the manifest write in `atomicWrite`: flushing the manifest bytes before the
 * rename keeps "the manifest describes the last completed state" honest across a
 * power loss. Any error propagates raw.
 *
 * @module durable
 */

/**
 * fsync an open file handle, propagating any error raw.
 * @param {import('node:fs/promises').FileHandle} fh
 */
export async function fsyncHandle(fh) {
  await fh.sync();
}
