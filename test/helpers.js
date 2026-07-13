/**
 * Test helpers: fixture temp dirs and a scriptable fixture central git repo.
 * No committed binaries — every fixture is built at test time.
 * @module test/helpers
 */

import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the CLI entry point (for real-subprocess tests). */
export const BIN = path.join(HERE, '..', 'bin', 'skillsync.js');

/**
 * Run the skillsync CLI as a real child process.
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string,string> }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runCli(args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

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
