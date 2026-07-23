/**
 * Project-wide constants and path conventions.
 * @module constants
 */

/** Manifest lives beside the canonical `.agents/skills/` copies it describes. */
export const MANIFEST_PATH = '.agents/skills-manifest.json';

/** Claude Code reads skills from here. */
export const CLAUDE_SKILLS_DIR = '.claude/skills';

/**
 * Codex reads skills from the universal `.agents/skills/` directory.
 * (Empirically Codex also reads `.codex/skills/`; skillsync writes only here — see ADR/research.)
 */
export const CODEX_SKILLS_DIR = '.agents/skills';

/** The two materialization targets and their on-disk roots, keyed by agent id. */
export const AGENT_TARGETS = /** @type {const} */ ({
  claude: CLAUDE_SKILLS_DIR,
  codex: CODEX_SKILLS_DIR,
});

/** All known agent ids. Order is stable for deterministic iteration/serialization. */
export const AGENTS = /** @type {const} */ (['claude', 'codex']);

/** Current manifest schema version. */
export const MANIFEST_VERSION = 1;

/** Valid materialization modes. */
export const MODES = /** @type {const} */ (['committed', 'gitignored', 'plain']);

// --- Working files under `.agents/` (siblings of the manifest) ---

/** Exclusive project lock (created with mkdir for atomicity). */
export const LOCK_DIR = '.agents/.skillsync.lock';

/**
 * Prefix for per-operation staging directories. A staged skill dir is renamed into
 * place atomically; a crashed run's leftover staging dir is swept on the next lock
 * acquisition.
 */
export const STAGE_PREFIX = '.agents/.skillsync-stage';

// --- Filesystem input policy limits ---

/** Reject any single file in a skill tree larger than this (bytes). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Reject any skill whose total tree size exceeds this (bytes). */
export const MAX_SKILL_BYTES = 25 * 1024 * 1024; // 25 MiB

/** Reject a skill tree with more than this many files (fork-bomb / inode guard). */
export const MAX_SKILL_FILES = 2000;

// --- Global config ---

/** Per-machine config dir (honors XDG_CONFIG_HOME). */
export const CONFIG_SUBPATH = 'skillsync/config.json';

/** Per-machine version cache (honors XDG_CONFIG_HOME), beside the config. */
export const CACHE_SUBPATH = 'skillsync/version-cache.json';

/** Marker block used to manage skillsync entries inside `.git/info/exclude`. */
export const EXCLUDE_BEGIN = '# >>> skillsync managed (do not edit) >>>';
export const EXCLUDE_END = '# <<< skillsync managed <<<';
