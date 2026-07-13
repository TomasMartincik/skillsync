/**
 * Test helpers: fixture temp dirs and a scriptable fixture central git repo.
 * No committed binaries — every fixture is built at test time.
 * @module test/helpers
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @returns {Promise<string>} */
export async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skillsync-test-'));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
export function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@e.x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@e.x',
    },
  }).trim();
}

/**
 * Write a SKILL.md with a version, plus optional extra files.
 * @param {string} skillDir
 * @param {{ name: string, version: string, body?: string, files?: Record<string,string> }} spec
 */
export async function writeSkill(skillDir, spec) {
  await fs.mkdir(skillDir, { recursive: true });
  const fm = `---\nname: ${spec.name}\ndescription: ${spec.name} skill\nversion: ${spec.version}\n---\n\n${spec.body ?? 'body'}\n`;
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), fm, 'utf8');
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const p = path.join(skillDir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }
}

/**
 * Build a central skills repo with a sequence of commits.
 * @param {string} dir
 * @param {{ message: string, skill: { name: string, version: string, body?: string, files?: Record<string,string> } }[]} commits
 * @returns {Promise<{ dir: string, commits: string[] }>}
 */
export async function makeCentral(dir, commits) {
  await fs.mkdir(dir, { recursive: true });
  gitSync(dir, ['init', '-q', '-b', 'main']);
  const shas = [];
  for (const c of commits) {
    await writeSkill(path.join(dir, c.skill.name), c.skill);
    gitSync(dir, ['add', '-A']);
    gitSync(dir, ['commit', '-q', '-m', c.message]);
    shas.push(gitSync(dir, ['rev-parse', 'HEAD']));
  }
  return { dir, commits: shas };
}

/**
 * Make a plain (non-bare) git project directory.
 * @param {string} dir
 */
export async function makeProject(dir) {
  await fs.mkdir(dir, { recursive: true });
  gitSync(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

/** @param {string} dir */
export async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}
