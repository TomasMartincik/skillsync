/**
 * `skillsync suggest <skill> | --new <name>` — file a TEXT-ONLY change request
 * against the central repo.
 *
 * Per the #16 amendment: no diff machinery, no de-adaptation, no baseline
 * re-materialization. The request is a description of what is wanted and why,
 * supplied via `--file <path>`, `-m "…"`, or stdin. It is pushed as a new branch
 * `suggest/<skill>-<slug>-<id>` carrying `requests/<skill>-<slug>-<id>.md`. Plain
 * `git push` (no gh dependency); the branch is never force-pushed.
 *
 * @module commands/suggest
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readManifest } from '../manifest.js';
import { getDefaultSource, normalizeSource } from '../config.js';
import { shallowClone } from '../fetch.js';
import { git, gitOrThrow } from '../git.js';
import { SkillsyncError, log } from '../util.js';
import { resolveProject, parseArgs, readStdin, pathExists } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function suggest(argv, ctx) {
  const { positionals, flags } = parseArgs(argv, {
    valueFlags: ['new', 'file', 'm', 'slug', 'source'],
  });

  const isNew = typeof flags.new === 'string';
  const skillArg = positionals[0];
  if (isNew && skillArg) {
    throw new SkillsyncError('USAGE', 'pass either <skill> or --new <name>, not both');
  }
  if (!isNew && !skillArg) {
    throw new SkillsyncError('USAGE', 'usage: skillsync suggest <skill>|--new <name> [--file f | -m "…"]');
  }
  const label = isNew ? String(flags.new) : skillArg;

  const body = await resolveMessage(flags);
  if (body.trim() === '') throw new SkillsyncError('EMPTY_REQUEST', 'request text is empty');

  const source = await resolveSource(ctx, flags);
  const id = randomBytes(3).toString('hex');
  const slug = slugify(typeof flags.slug === 'string' ? flags.slug : body) || 'request';
  const branch = `suggest/${slugify(label)}-${slug}-${id}`;
  const fileRel = `requests/${slugify(label)}-${slug}-${id}.md`;

  const checkout = await shallowClone(source);
  try {
    const baseCommit = checkout.commit;
    const content = renderRequest({ isNew, label, id, baseCommit, source, body });

    const filePath = path.join(checkout.dir, fileRel);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');

    await gitOrThrow(['checkout', '-q', '-b', branch], { cwd: checkout.dir });
    await gitOrThrow(['add', '--', fileRel], { cwd: checkout.dir });
    await gitOrThrow(
      [
        '-c', 'user.name=skillsync',
        '-c', 'user.email=skillsync@localhost',
        'commit', '-q', '-m', `suggest(${label}): ${slug}`,
      ],
      { cwd: checkout.dir },
    );

    // Never force-push: refuse to overwrite an existing remote branch.
    const push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: checkout.dir });
    if (push.code !== 0) {
      throw new SkillsyncError(
        'PUSH_FAILED',
        `could not push suggestion branch (never force-pushed): ${push.stderr.trim()}`,
      );
    }

    log(`filed suggestion`);
    log(`  request-id: ${id}`);
    log(`  branch:     ${branch}`);
    log(`  file:       ${fileRel}`);
  } finally {
    await checkout.cleanup();
  }
}

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<string>}
 */
async function resolveMessage(flags) {
  if (typeof flags.file === 'string') {
    if (!(await pathExists(flags.file))) {
      throw new SkillsyncError('NO_FILE', `--file not found: ${flags.file}`);
    }
    return fs.readFile(flags.file, 'utf8');
  }
  if (typeof flags.m === 'string') return flags.m;
  if (!process.stdin.isTTY) return readStdin();
  throw new SkillsyncError('NO_MESSAGE', 'provide request text via --file <path>, -m "…", or stdin');
}

/**
 * @param {{ cwd: string }} ctx
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<string>}
 */
async function resolveSource(ctx, flags) {
  if (typeof flags.source === 'string') return normalizeSource(flags.source);
  const project = resolveProject(ctx.cwd);
  if (await pathExists(project.manifestPath)) {
    return (await readManifest(project.manifestPath)).source;
  }
  const def = await getDefaultSource();
  if (def) return def;
  throw new SkillsyncError('NO_SOURCE', 'no manifest and no global default; pass --source <git-url>');
}

/**
 * @param {{ isNew: boolean, label: string, id: string, baseCommit: string, source: string, body: string }} r
 * @returns {string}
 */
function renderRequest(r) {
  const target = r.isNew ? `new skill: ${r.label}` : r.label;
  return [
    `# Suggestion: ${target}`,
    '',
    `- request-id: ${r.id}`,
    `- target: ${target}`,
    `- base-commit: ${r.baseCommit}`,
    `- source: ${r.source}`,
    `- created: ${new Date().toISOString()}`,
    '',
    '## Request',
    '',
    r.body.trimEnd(),
    '',
  ].join('\n');
}

/**
 * @param {string} s
 * @returns {string}
 */
function slugify(s) {
  return String(s)
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
