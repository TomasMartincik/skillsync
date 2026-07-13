/**
 * `.git/info/exclude` management for gitignored mode.
 *
 * In gitignored mode the materialized skill dirs and the manifest must be ignored
 * per-machine WITHOUT touching the team's tracked `.gitignore` (#6). We manage a
 * marker-delimited block inside `.git/info/exclude` so entries can be rewritten
 * idempotently and removed cleanly.
 *
 * @module exclude
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EXCLUDE_BEGIN, EXCLUDE_END } from './constants.js';
import { gitOrThrow } from './git.js';

/**
 * Rewrite the skillsync-managed block in `.git/info/exclude` to contain exactly
 * `entries` (repo-root-relative POSIX paths). Idempotent; preserves everything
 * outside the managed block.
 * @param {string} projectDir
 * @param {string[]} entries
 * @returns {Promise<void>}
 */
export async function writeExclude(projectDir, entries) {
  const gitDir = await gitOrThrow(['rev-parse', '--absolute-git-dir'], { cwd: projectDir });
  const infoDir = path.join(gitDir, 'info');
  const excludePath = path.join(infoDir, 'exclude');
  await fs.mkdir(infoDir, { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(excludePath, 'utf8');
  } catch {
    existing = '';
  }
  const withoutBlock = stripBlock(existing);
  const sorted = [...new Set(entries)].sort();
  const block =
    sorted.length > 0
      ? `${EXCLUDE_BEGIN}\n${sorted.map((e) => `/${e}`).join('\n')}\n${EXCLUDE_END}\n`
      : '';

  let next = withoutBlock;
  if (block) {
    if (next !== '' && !next.endsWith('\n')) next += '\n';
    next += block;
  }
  await fs.writeFile(excludePath, next, 'utf8');
}

/**
 * Remove the managed block (used by `remove`/mode change).
 * @param {string} content
 * @returns {string}
 */
export function stripBlock(content) {
  const begin = content.indexOf(EXCLUDE_BEGIN);
  if (begin === -1) return content;
  const endMarker = content.indexOf(EXCLUDE_END, begin);
  if (endMarker === -1) return content.slice(0, begin);
  let after = endMarker + EXCLUDE_END.length;
  if (content[after] === '\n') after += 1;
  return content.slice(0, begin) + content.slice(after);
}
