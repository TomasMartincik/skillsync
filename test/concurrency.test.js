import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { init } from '../src/commands/init.js';
import { readManifest, pinAgents } from '../src/manifest.js';
import { hashMaterialized } from '../src/materialize.js';
import { targetDir } from '../src/plan.js';
import { makeCentral, runCli, tmpDir, rmrf } from './helpers.js';

/**
 * THE missing test (adversarial-review): two concurrent `add`s in separate real
 * processes must both succeed and compose into the UNION of their additions —
 * neither may clobber the other, and no lock/journal/staging residue may remain.
 *
 * The previous design read the manifest BEFORE locking, so two adds starting from
 * the same M0 both wrote M0+their-own-skill and one addition was lost. The rework
 * moves read→recover→plan→apply entirely under a blocking project lock, so the
 * second process observes the first's committed manifest and appends to it.
 */
test('two concurrent add processes both win: final manifest is the union, no residue', async () => {
  const root = await tmpDir();
  try {
    const central = await makeCentral(path.join(root, 'central'), [
      { message: 'foo', skill: { name: 'foo', version: '1.0', body: 'FOO' } },
      { message: 'bar', skill: { name: 'bar', version: '1.0', body: 'BAR' } },
    ]);
    const proj = path.join(root, 'proj');
    await fs.mkdir(proj, { recursive: true });
    const env = { XDG_CONFIG_HOME: path.join(root, 'xdg'), SKILLSYNC_LOCK_TIMEOUT_MS: '60000' };

    await init(['--source', central.dir, '--mode', 'plain'], { cwd: proj });

    // Both start from the same initial (empty) manifest, launched together.
    const [a, b] = await Promise.all([
      runCli(['add', 'foo'], { cwd: proj, env }),
      runCli(['add', 'bar'], { cwd: proj, env }),
    ]);
    assert.equal(a.code, 0, `add foo failed: ${a.stderr}`);
    assert.equal(b.code, 0, `add bar failed: ${b.stderr}`);

    // Final manifest is the UNION.
    const manifest = await readManifest(path.join(proj, '.agents/skills-manifest.json'));
    assert.deepEqual(Object.keys(manifest.skills).sort(), ['bar', 'foo']);

    // Both outputs are materialized and match the manifest exactly.
    for (const skill of ['foo', 'bar']) {
      const pin = manifest.skills[skill];
      for (const agent of pinAgents(pin)) {
        const dir = path.join(proj, targetDir(agent, skill));
        assert.equal(await hashMaterialized(dir), pin.outputs[agent], `${skill}/${agent} hash != manifest`);
      }
    }

    // No lock / journal / staging / backup residue.
    await assert.rejects(fs.stat(path.join(proj, '.agents/.skillsync.lock')));
    await assert.rejects(fs.stat(path.join(proj, '.agents/.skillsync-txn.json')));
    const agentsEntries = await fs.readdir(path.join(proj, '.agents'));
    assert.ok(
      !agentsEntries.some((e) => e.includes('stage') || e.includes('backup') || e.includes('lock')),
      `unexpected residue: ${agentsEntries.join(', ')}`,
    );
  } finally {
    await rmrf(root);
  }
});
