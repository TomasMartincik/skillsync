/**
 * `skillsync init` — create the project manifest.
 *
 * - Proposes a mode from git context (git repo => committed, else plain);
 *   `--mode` overrides. Never requires a branch for plain mode.
 * - Source resolution: `--source <url>` is explicit; otherwise the per-machine
 *   global default is used. The global default is AUTO-LEARNED only from an
 *   explicit `--source` with one-time confirmation (`--yes` for non-interactive).
 *
 * @module commands/init
 */

import { MANIFEST_PATH, MODES } from '../constants.js';
import { emptyManifest } from '../manifest.js';
import { preflight, repoState } from '../git.js';
import { getDefaultSource, setDefaultSource, normalizeSource } from '../config.js';
import { runTransaction } from '../materialize.js';
import { excludeEntriesFor } from '../plan.js';
import { SkillsyncError, log, warn } from '../util.js';
import { resolveProject, withLock, parseArgs, confirm, pathExists } from './common.js';

/**
 * @param {string[]} argv
 * @param {{ cwd: string }} ctx
 */
export async function init(argv, ctx) {
  const { flags } = parseArgs(argv, { valueFlags: ['source', 'mode'] });
  const project = resolveProject(ctx.cwd);

  // Mode.
  let mode;
  if (typeof flags.mode === 'string') {
    if (!MODES.includes(/** @type {any} */ (flags.mode))) {
      throw new SkillsyncError('BAD_MODE', `--mode must be one of ${MODES.join(', ')}`);
    }
    mode = flags.mode;
  } else {
    const st = await repoState(ctx.cwd);
    mode = st.isRepo ? 'committed' : 'plain';
    log(`proposed mode: ${mode}${st.isRepo ? ' (use --mode gitignored for team repos)' : ''}`);
  }

  // Source.
  const explicit = typeof flags.source === 'string' ? normalizeSource(flags.source) : null;
  let source = explicit;
  if (!source) {
    source = (await getDefaultSource()) ?? null;
    if (!source) {
      throw new SkillsyncError(
        'NO_SOURCE',
        'no source given and no global default; run with --source <git-url> once',
      );
    }
  }

  const manifest = emptyManifest({ source, mode });

  await withLock(ctx.cwd, async () => {
    // Under the lock: refuse if already initialized. An interrupted init wrote no
    // manifest (it lands last), so a re-run simply proceeds and initializes cleanly.
    if (await pathExists(project.manifestPath)) {
      throw new SkillsyncError('ALREADY_INIT', `already initialized: ${MANIFEST_PATH} exists`);
    }
    // Preflight git for committed/gitignored.
    const { warnings } = await preflight(ctx.cwd, { mode, manifestPath: project.manifestPath });
    for (const w of warnings) warn(w);

    await runTransaction(ctx.cwd, {
      manifest,
      targets: [],
      removeDirs: [],
      excludeEntries: excludeEntriesFor(manifest),
    });
  });

  log(`initialized ${MANIFEST_PATH}`);
  log(`  source: ${source}`);
  log(`  mode:   ${mode}`);

  // Auto-learn the global default (only from explicit --source, with confirmation).
  if (explicit) {
    const current = await getDefaultSource();
    if (!current) {
      let save = flags.yes === true;
      if (!save) {
        const answer = await confirm(`Save "${explicit}" as this machine's default skills source?`);
        if (answer === null) {
          warn('non-interactive: default source NOT saved (re-run with --yes to save)');
        } else {
          save = answer;
        }
      }
      if (save) {
        await setDefaultSource(explicit);
        log(`  saved as global default source`);
      }
    }
  }
}
