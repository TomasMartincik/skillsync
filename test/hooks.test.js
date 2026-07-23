/**
 * `hooks install` merge (preserves unrelated hooks, idempotent) and `hooks
 * doctor` state reporting. Mixes fast pure-function unit tests of the merge with
 * real-subprocess integration through the CLI.
 * @module test/hooks
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  mergeClaude,
  mergeCodex,
  hasClaudeHook,
  hasCodexHook,
  claudeSettingsPath,
  codexHooksPath,
} from '../src/hooks-config.js';
import { runCli, tmpDir, rmrf, BIN } from './helpers.js';

const CLONE = path.resolve(path.dirname(BIN), '..');
const GUARD = path.join(CLONE, 'bin', 'skillsync-notice.js');

test('mergeClaude inserts our SessionStart hook and preserves unrelated ones', () => {
  const obj = {
    model: 'sonnet',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
  };
  mergeClaude(obj, GUARD);
  assert.equal(obj.model, 'sonnet', 'unrelated top-level keys preserved');
  assert.equal(obj.hooks.PreToolUse.length, 1, 'other events untouched');
  const ss = obj.hooks.SessionStart;
  assert.equal(ss.length, 2, 'unrelated SessionStart entry kept, ours appended');
  assert.equal(ss[0].hooks[0].command, 'echo unrelated');
  assert.ok(hasClaudeHook(obj, GUARD));
});

test('mergeClaude is idempotent — twice equals once', () => {
  const base = () => ({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } });
  const once = JSON.stringify(mergeClaude(base(), GUARD), null, 2);
  const twiceObj = mergeClaude(base(), GUARD);
  const twice = JSON.stringify(mergeClaude(twiceObj, GUARD), null, 2);
  assert.equal(twice, once, 'a second merge does not add a duplicate entry');
});

test('mergeCodex inserts named entry, preserves unrelated, idempotent', () => {
  const base = () => ({ hooks: { SessionStart: [{ name: 'other', command: ['echo', 'hi'] }] } });
  const first = mergeCodex(base(), GUARD);
  assert.equal(first.hooks.SessionStart.length, 2);
  assert.equal(first.hooks.SessionStart[0].name, 'other', 'unrelated entry preserved');
  assert.ok(hasCodexHook(first));
  const once = JSON.stringify(first, null, 2);
  const twice = JSON.stringify(mergeCodex(first, GUARD), null, 2);
  assert.equal(twice, once, 'idempotent');
});

test('merge handles an empty/absent config object', () => {
  const c = mergeClaude({}, GUARD);
  assert.ok(hasClaudeHook(c, GUARD));
  const x = mergeCodex({}, GUARD);
  assert.ok(hasCodexHook(x));
});

test('hooks install creates both configs, preserves pre-existing hooks, and is idempotent', async () => {
  const home = await tmpDir();
  try {
    // Pre-seed Claude settings with an unrelated hook + unrelated key.
    const claudePath = claudeSettingsPath(home);
    await fs.mkdir(path.dirname(claudePath), { recursive: true });
    await fs.writeFile(
      claudePath,
      JSON.stringify(
        { model: 'sonnet', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keepme' }] }] } },
        null,
        2,
      ),
    );

    const env = { HOME: home, SKILLSYNC_HOME: CLONE };
    const r1 = await runCli(['hooks', 'install'], { cwd: home, env });
    assert.equal(r1.code, 0, r1.stderr);

    const claude1 = await fs.readFile(claudePath, 'utf8');
    assert.match(claude1, /"model": "sonnet"/, 'unrelated key preserved');
    assert.match(claude1, /echo keepme/, 'pre-existing hook preserved');
    assert.match(claude1, /skillsync-notice\.js.*--agent claude/, 'our hook added');

    const codex1 = await fs.readFile(codexHooksPath(home), 'utf8');
    assert.match(codex1, /skillsync-notice/, 'codex hook added');

    // Second run: byte-identical files (idempotent).
    const r2 = await runCli(['hooks', 'install'], { cwd: home, env });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(await fs.readFile(claudePath, 'utf8'), claude1, 'claude config identical on re-run');
    assert.equal(await fs.readFile(codexHooksPath(home), 'utf8'), codex1, 'codex config identical on re-run');
  } finally {
    await rmrf(home);
  }
});

test('hooks install refuses to clobber an unparseable config', async () => {
  const home = await tmpDir();
  try {
    const claudePath = claudeSettingsPath(home);
    await fs.mkdir(path.dirname(claudePath), { recursive: true });
    await fs.writeFile(claudePath, '{ this is not json');
    const r = await runCli(['hooks', 'install'], { cwd: home, env: { HOME: home, SKILLSYNC_HOME: CLONE } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HOOKS_CONFIG_UNPARSEABLE/);
    assert.equal(await fs.readFile(claudePath, 'utf8'), '{ this is not json', 'file left untouched');
  } finally {
    await rmrf(home);
  }
});

test('hooks doctor reports absent then present states, with the Codex review caveat', async () => {
  const home = await tmpDir();
  try {
    const env = { HOME: home, SKILLSYNC_HOME: CLONE };
    const before = await runCli(['hooks', 'doctor'], { cwd: home, env });
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stdout, /claude: entry ABSENT/);
    assert.match(before.stdout, /codex: entry ABSENT/);
    assert.match(before.stdout, /guard present/, 'guard script exists in the clone');

    await runCli(['hooks', 'install'], { cwd: home, env });
    const after = await runCli(['hooks', 'doctor'], { cwd: home, env });
    assert.match(after.stdout, /claude: entry present/);
    assert.match(after.stdout, /codex: entry present/);
    assert.match(after.stdout, /pending review/, 'codex honesty caveat present');
  } finally {
    await rmrf(home);
  }
});
