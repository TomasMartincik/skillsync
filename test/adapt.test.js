/**
 * Per-agent adaptation transforms (adapt.js): Claude verbatim, Codex switch
 * rename + Claude-only drops, agents filter composition, per-copy hash drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adaptForAgent } from '../src/adapt.js';
import { hashFiles } from '../src/hash.js';
import { buildSkillPlan } from '../src/skill-pin.js';
import { tmpDir, rmrf } from './helpers.js';

/**
 * Write a raw SKILL.md (caller controls exact frontmatter) plus optional files.
 * @param {string} dir
 * @param {string} skillMd
 * @param {Record<string,string>} [files]
 */
async function writeRawSkill(dir, skillMd, files = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }
}

/** Materialize a file list to a real dir and hash it back (proves on-disk bytes). */
async function stageAndHash(files, dir) {
  for (const f of files) {
    const dest = path.join(dir, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (typeof f.content === 'string') await fs.writeFile(dest, f.content);
    else await fs.copyFile(f.abs, dest);
  }
  const { scanSkillTree } = await import('../src/input-policy.js');
  return hashFiles(await scanSkillTree(dir));
}

/** @param {import('../src/input-policy.js').SkillFile[]} files @param {string} rel */
async function contentOf(files, rel) {
  const f = files.find((x) => x.rel === rel);
  assert.ok(f, `expected file ${rel} in output`);
  return typeof f.content === 'string' ? f.content : fs.readFile(f.abs, 'utf8');
}

test('disable-model-invocation: true → key dropped, openai.yaml sidecar emitted, Claude untouched', async () => {
  const root = await tmpDir();
  try {
    const src = path.join(root, 'deploy');
    const raw =
      '---\nname: deploy\ndescription: deploy skill\nversion: 1.0\ndisable-model-invocation: true\n---\n\nbody here\n';
    await writeRawSkill(src, raw);

    const claude = await adaptForAgent(src, 'claude');
    const codex = await adaptForAgent(src, 'codex');

    // Claude copy is byte-identical to source (verbatim; no sidecar).
    assert.equal(await contentOf(claude, 'SKILL.md'), raw);
    assert.ok(!claude.some((f) => f.rel === 'agents/openai.yaml'), 'Claude must not get a sidecar');

    // Codex SKILL.md drops the Claude key, keeps everything else.
    const codexMd = await contentOf(codex, 'SKILL.md');
    assert.ok(!/disable-model-invocation/.test(codexMd), 'Claude key removed from Codex copy');
    assert.match(codexMd, /name: deploy/);
    assert.match(codexMd, /description: deploy skill/);
    assert.match(codexMd, /body here/);

    // Sidecar has the EXACT policy content.
    assert.equal(await contentOf(codex, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  } finally {
    await rmrf(root);
  }
});

test('Claude-only frontmatter keys are dropped from the Codex copy with a warning (incl. multi-line value)', async () => {
  const root = await tmpDir();
  try {
    const src = path.join(root, 'deploy');
    // `hooks` carries a multi-line/indented value that must be dropped whole.
    const raw = [
      '---',
      'name: deploy',
      'description: deploy skill',
      'version: 1.0',
      'allowed-tools: Bash(git push:*)',
      'context: fork',
      'hooks:',
      '  PostToolUse:',
      '    - command: ./x.sh',
      'model: opus',
      '---',
      '',
      'body $ARGUMENTS here',
      '',
    ].join('\n');
    await writeRawSkill(src, raw);

    const warnings = [];
    const origErr = console.error;
    console.error = (...a) => warnings.push(a.join(' '));
    let codex;
    try {
      codex = await adaptForAgent(src, 'codex');
    } finally {
      console.error = origErr;
    }

    const md = await contentOf(codex, 'SKILL.md');
    for (const key of ['allowed-tools', 'context', 'hooks', 'model']) {
      assert.ok(!md.includes(`${key}:`), `Codex copy must drop "${key}"`);
    }
    // The multi-line hooks continuation lines are gone too.
    assert.ok(!md.includes('PostToolUse'), 'nested hooks value dropped');
    assert.ok(!md.includes('./x.sh'), 'nested hooks value dropped');
    // Portable frontmatter + body survive.
    assert.match(md, /name: deploy/);
    assert.match(md, /description: deploy skill/);
    assert.match(md, /body \$ARGUMENTS here/);
    // No sidecar (no disable-model-invocation here).
    assert.ok(!codex.some((f) => f.rel === 'agents/openai.yaml'));

    // One warning per dropped key, each naming the skill + key.
    for (const key of ['allowed-tools', 'context', 'hooks', 'model']) {
      assert.ok(
        warnings.some((w) => w.includes('deploy') && w.includes(key)),
        `expected a warning naming skill + "${key}"`,
      );
    }
  } finally {
    await rmrf(root);
  }
});

test('a skill with no special keys copies verbatim to both agents (same files, no sidecar)', async () => {
  const root = await tmpDir();
  try {
    const src = path.join(root, 'plain');
    const raw = '---\nname: plain\ndescription: plain skill\nversion: 1.0\n---\n\njust a body\n';
    await writeRawSkill(src, raw, { 'references/notes.md': 'notes', 'scripts/run.sh': '#!/bin/sh\n' });

    const claude = await adaptForAgent(src, 'claude');
    const codex = await adaptForAgent(src, 'codex');

    assert.deepEqual(
      codex.map((f) => f.rel).sort(),
      claude.map((f) => f.rel).sort(),
    );
    assert.ok(!codex.some((f) => f.rel === 'agents/openai.yaml'));
    assert.equal(await contentOf(codex, 'SKILL.md'), raw);
    assert.equal(await contentOf(codex, 'references/notes.md'), 'notes');

    // Verbatim ⇒ identical per-copy hashes.
    const cDir = path.join(root, 'out-claude');
    const xDir = path.join(root, 'out-codex');
    await fs.mkdir(cDir, { recursive: true });
    await fs.mkdir(xDir, { recursive: true });
    assert.equal(await stageAndHash(claude, cDir), await stageAndHash(codex, xDir));
  } finally {
    await rmrf(root);
  }
});

test('per-copy hashes DIFFER when the Codex transform applies, and drift is detected per copy', async () => {
  const root = await tmpDir();
  try {
    const src = path.join(root, 'deploy');
    const raw =
      '---\nname: deploy\ndescription: deploy skill\nversion: 1.0\ndisable-model-invocation: true\n---\n\nbody\n';
    await writeRawSkill(src, raw);

    const claude = await adaptForAgent(src, 'claude');
    const codex = await adaptForAgent(src, 'codex');

    const cDir = path.join(root, 'out-claude');
    const xDir = path.join(root, 'out-codex');
    await fs.mkdir(cDir, { recursive: true });
    await fs.mkdir(xDir, { recursive: true });
    const claudeHash = await stageAndHash(claude, cDir);
    const codexHash = await stageAndHash(codex, xDir);

    assert.notEqual(claudeHash, codexHash, 'transformed Codex copy must hash differently from Claude');

    // Drift is per copy: mutate only the Codex copy on disk, re-hash → only it drifts.
    await fs.appendFile(path.join(xDir, 'SKILL.md'), '\n# tamper\n');
    const { scanSkillTree } = await import('../src/input-policy.js');
    const codexNow = await hashFiles(await scanSkillTree(xDir));
    const claudeNow = await hashFiles(await scanSkillTree(cDir));
    assert.equal(claudeNow, claudeHash, 'Claude copy hash unchanged');
    assert.notEqual(codexNow, codexHash, 'Codex copy drift detected independently');
  } finally {
    await rmrf(root);
  }
});

test('pre-existing agents/openai.yaml is MERGED, not clobbered (policy set, interface preserved)', async () => {
  const root = await tmpDir();
  try {
    const src = path.join(root, 'deploy');
    const raw =
      '---\nname: deploy\ndescription: deploy skill\nversion: 1.0\ndisable-model-invocation: true\n---\n\nbody\n';
    const existingYaml =
      'interface:\n  display_name: "Deploy"\n  short_description: "Ship it"\npolicy:\n  allow_implicit_invocation: true\n';
    await writeRawSkill(src, raw, { 'agents/openai.yaml': existingYaml });

    const codex = await adaptForAgent(src, 'codex');
    const merged = await contentOf(codex, 'agents/openai.yaml');

    assert.match(merged, /display_name: "Deploy"/, 'interface section preserved');
    assert.match(merged, /short_description: "Ship it"/, 'interface section preserved');
    assert.match(merged, /allow_implicit_invocation: false/, 'policy flipped to false');
    assert.ok(!/allow_implicit_invocation: true/.test(merged), 'no leftover true value');
    // Exactly one occurrence of the key (updated in place, not appended twice).
    assert.equal((merged.match(/allow_implicit_invocation:/g) || []).length, 1);
  } finally {
    await rmrf(root);
  }
});

test('the per-skill agents filter composes with the real transform (codex-only ⇒ only Codex output)', async () => {
  const root = await tmpDir();
  try {
    const src = path.join(root, 'deploy');
    const raw =
      '---\nname: deploy\ndescription: deploy skill\nversion: 1.0\ndisable-model-invocation: true\n---\n\nbody\n';
    await writeRawSkill(src, raw);

    const { pin, specs } = await buildSkillPlan({
      skill: 'deploy',
      skillDir: src,
      commit: 'abc1234',
      agentsFilter: ['codex'],
    });

    assert.deepEqual(pin.agents, ['codex']);
    assert.equal(specs.length, 1, 'only one target for a codex-only skill');
    assert.equal(specs[0].agent, 'codex');
    assert.equal(specs[0].target, '.agents/skills/deploy');
    // And it is the TRANSFORMED Codex output (sidecar present, Claude key gone).
    const md = specs[0].files.find((f) => f.rel === 'SKILL.md');
    assert.ok(!(md.content ?? '').includes('disable-model-invocation'));
    assert.ok(specs[0].files.some((f) => f.rel === 'agents/openai.yaml'));
  } finally {
    await rmrf(root);
  }
});

test('a pre-existing sidecar without a policy block gets a policy block appended', async () => {
  const root = await tmpDir();
  try {
    const src = path.join(root, 'deploy');
    const raw =
      '---\nname: deploy\ndescription: deploy skill\nversion: 1.0\ndisable-model-invocation: true\n---\n\nbody\n';
    const existingYaml = 'interface:\n  display_name: "Deploy"\n';
    await writeRawSkill(src, raw, { 'agents/openai.yaml': existingYaml });

    const codex = await adaptForAgent(src, 'codex');
    const merged = await contentOf(codex, 'agents/openai.yaml');
    assert.match(merged, /display_name: "Deploy"/);
    assert.match(merged, /policy:\n {2}allow_implicit_invocation: false/);
  } finally {
    await rmrf(root);
  }
});
