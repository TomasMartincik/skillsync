import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { init } from '../src/commands/init.js';
import { suggest } from '../src/commands/suggest.js';
import { makeCentral, gitSync, tmpDir, rmrf } from './helpers.js';

async function setup(root) {
  // Central content repo + a bare remote to push suggestion branches to.
  const central = await makeCentral(path.join(root, 'central'), [
    { message: 'v1.0', skill: { name: 'g', version: '1.0' } },
  ]);
  const bare = path.join(root, 'central.git');
  gitSync(root, ['clone', '-q', '--bare', central.dir, bare]);
  const proj = path.join(root, 'proj');
  await fs.mkdir(proj, { recursive: true });
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  await init(['--source', bare, '--mode', 'plain'], { cwd: proj });
  return { bare, proj, restore: () => { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; } };
}

/** List remote branches on the bare repo. */
function remoteBranches(bare) {
  return gitSync(bare, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter(Boolean);
}

test('suggest pushes a suggest/<skill>-<slug>-<id> branch with a request file', async () => {
  const root = await tmpDir();
  const { bare, proj, restore } = await setup(root);
  try {
    await suggest(['g', '-m', 'Add a section on adversarial questioning'], { cwd: proj });
    const branches = remoteBranches(bare);
    const b = branches.find((x) => x.startsWith('suggest/g-'));
    assert.ok(b, `expected a suggest/g-* branch, got ${branches.join(',')}`);
    assert.match(b, /^suggest\/g-add-a-section-on-adversarial-questioning-[0-9a-f]{6}$/);

    // The branch carries a requests/*.md file with the request text.
    const contents = gitSync(bare, ['show', `${b}:requests/${b.slice('suggest/'.length)}.md`]);
    assert.match(contents, /adversarial questioning/);
    assert.match(contents, /request-id:/);
  } finally {
    restore();
    await rmrf(root);
  }
});

test('suggest --new files a request for a brand-new skill', async () => {
  const root = await tmpDir();
  const { bare, proj, restore } = await setup(root);
  try {
    await suggest(['--new', 'refactoring', '-m', 'A skill for safe refactoring'], { cwd: proj });
    const b = remoteBranches(bare).find((x) => x.startsWith('suggest/refactoring-'));
    assert.ok(b);
    const contents = gitSync(bare, ['show', `${b}:requests/${b.slice('suggest/'.length)}.md`]);
    assert.match(contents, /new skill: refactoring/);
  } finally {
    restore();
    await rmrf(root);
  }
});

test('two suggestions get distinct branches (random id, never force-push)', async () => {
  const root = await tmpDir();
  const { bare, proj, restore } = await setup(root);
  try {
    await suggest(['g', '-m', 'same message'], { cwd: proj });
    await suggest(['g', '-m', 'same message'], { cwd: proj });
    const branches = remoteBranches(bare).filter((x) => x.startsWith('suggest/g-'));
    assert.equal(branches.length, 2, `expected 2 distinct branches, got ${branches.join(',')}`);
  } finally {
    restore();
    await rmrf(root);
  }
});
