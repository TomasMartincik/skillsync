# skillsync

Distribute [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) (`SKILL.md`
folders) from one central git repo into many projects, as real copies, for **Claude Code**
(`.claude/skills/`) and **Codex** (`.agents/skills/`).

- **Zero npm dependencies. No build step.** `bin/skillsync.js` runs directly on Node ≥ 18.
- Plain modern JavaScript (ESM) with JSDoc types; git via shell-out; a hand-rolled YAML
  frontmatter parser.
- **Content private, machinery public**: this tool carries no secrets. It reaches your private
  skills repo through your machine's own git/`gh` credentials; the repo URL lives in each
  project's manifest.

This is the complete v1 surface: the core (init/add/remove/sync/list/suggest), the
update/versioning layer (`update`/`status` + version cache), the per-agent adaptation layer,
and the install/hooks/self-update tooling.

## Install

One line (macOS/Linux; Windows via WSL). Requires Node ≥ 18 and git:

```sh
curl -fsSL https://raw.githubusercontent.com/TomasMartincik/skillsync/main/install.sh | bash
```

The installer is idempotent. It clones the tool into `~/.local/share/skillsync`, symlinks
`bin/skillsync.js` onto `~/.local/bin/skillsync`, prints PATH advice if `~/.local/bin` isn't on your
`PATH`, and finishes by installing the machine-global session-start hooks (see below). Set
`SKILLSYNC_NO_HOOKS=1` to skip the hook step. Re-running it fast-forwards the clone and repairs the
symlink.

Prefer to run without installing? Clone this repo and invoke the entry point directly:

```sh
node /path/to/skillsync/bin/skillsync.js <command>
```

## Session-start hooks

`skillsync hooks install` merges one **SessionStart** hook into each agent's user-level config
(`~/.claude/settings.json` for Claude Code, `~/.codex/hooks.json` for Codex), idempotently and
without disturbing any unrelated hooks. `install.sh` runs it as its last step. The hook runs a small
guard (`bin/skillsync-notice.js`) that:

- exits silently unless the current directory (or an ancestor) has a `.agents/skills-manifest.json`
  **and** skillsync is installed;
- otherwise runs `skillsync status --cached` (2s timeout, **fail-open** — any error is silent) and,
  **only when updates are pending**, emits one advisory notice: plain stdout for Claude Code, the
  documented `{"systemMessage": "…"}` JSON for Codex. When a major bump is pending it appends a
  migration warning (major updates are migrations — analyze the impact before `update <skill>
  --major`). It never mutates anything.

**Codex caveat:** writing the file is *not* activation. Codex requires you to trust a new or changed
hook once via `/hooks` before it fires. `skillsync hooks doctor` reports, per agent, whether the
entry and guard script are present, and states this "pending review" honestly for Codex.

## Self-update

`skillsync self-update` updates the install clone. It is **not** a blind pull (ADR 0003 amendment):
it fetches, shows the incoming commit log and diff stat (`--diff` for the full diff), and requires
explicit confirmation (`y/N`; `--yes` skips the prompt) before a **fast-forward-only** merge. It then
re-runs `hooks install` to repair the hook entries in case the guard script changed.

## Commands

| Command | What it does |
| --- | --- |
| `init [--source <git-url>] [--mode committed\|gitignored\|plain] [--yes]` | Create the project manifest. Mode is proposed from git context (git repo → `committed`, else `plain`). `--source` is stored and, on first use, learned as this machine's default after a one-time confirmation (`--yes` to confirm non-interactively). |
| `add <skill>… [--agents claude,codex]` | Enable skills at central's **current** published version, materialize them, and record their pins. `--agents` restricts which agents get a copy. |
| `remove <skill>…` | Disable skills: drop their pins and delete their materialized copies. |
| `sync [--force]` | Materialize **exactly** what the manifest pins (version-exact; the cached commit is not authoritative). Never advances pins. Skips a drifted or anomalous copy with a warning; `--force` overwrites it. |
| `list` | Show pinned skills and each copy's status (`ok` / `missing` / `drifted` / `anomaly`). Read-only; no network. |
| `update [skill…] [--major] [--to <major.minor>] [--preview] [--force]` | Advance pins toward central's latest published version. Bare `update` applies every pending **minor** (same major) and **lists** pending majors; `--major` applies majors too; `--to` sets an exact version (both directions); `--preview` shows the changes without touching files; `--force` overwrites a drifted/anomalous copy. |
| `status [--cached]` | Per skill: recorded version, central's latest with its update class, and the local copy's drift/anomaly state. `--cached` reports from the version cache with **zero network** (and shows its age). |
| `suggest <skill>\|--new <name> [--file <path> \| -m "…"]` | File a **text-only** change request as a `suggest/<skill>-<slug>-<id>` branch on central. No diff machinery; the request is prose (from `--file`, `-m`, or stdin). Never force-pushed. |
| `hooks install` / `hooks doctor` | Idempotently install the machine-global SessionStart notice hook into both agents' user configs / report its state. See [Session-start hooks](#session-start-hooks). |
| `self-update [--yes] [--diff]` | Update the install clone: fetch, show the incoming commits + diff stat, confirm, fast-forward, and re-run `hooks install`. See [Self-update](#self-update). |

`init`, `add`, `remove`, `sync`, `update` take a project-scoped exclusive lock and run their
entire `read manifest → plan → install` sequence **under** it (so two concurrent commands
queue and compose rather than clobbering each other). `add` clones central, records its HEAD
commit and each skill's current published version, then pins it. `list`, `status`, `suggest`,
and `update --preview` do not mutate project skill trees.

### Update & status semantics

Update detection is **version-only** (per skill's `version: <major>.<minor>` frontmatter, compared
against the manifest's recorded version) — the content hash is never consulted for update
detection, only for drift. A **minor** bump is auto-applicable; a **major** is a migration you opt
into. `update` reuses the same materialization path as `add` (it is add-with-a-different-pin, not a
separate pipeline): `--major`/minor apply central's latest; `--to <version>` scans central's
first-parent history for the exact declared version and materializes it either direction (the
explicit version is itself the consent). A skill in the manifest but absent from central's HEAD is
reported as **deleted centrally** (a status string; no tombstone machinery), and `status` also warns
if the same skill name exists in `$HOME/.agents/skills` (Codex reads that scope alongside the
project's without dedup).

Any command that already fetches central (`add`, `update`, `status`) refreshes a per-machine
**version cache** as a free side effect — a single JSON file beside the global config
(`$XDG_CONFIG_HOME/skillsync/version-cache.json`), keyed by normalized source URL, written
atomically (temp + rename). `status --cached` reads it with zero network cost and reports its age
(`checked 3h ago`).

## Manifest schema (v1)

Lives at `.agents/skills-manifest.json`, beside the canonical `.agents/skills/` copies:

```json
{
  "version": 1,
  "source": "git@github.com:you/skills.git",
  "mode": "committed",
  "skills": {
    "grilling": {
      "version": "1.2",
      "commit": "9f3ab12…",
      "sourceHash": "sha256:…",
      "outputs": { "claude": "sha256:…", "codex": "sha256:…" }
    },
    "codex-only-skill": {
      "version": "1.0",
      "commit": "9f3ab12…",
      "sourceHash": "sha256:…",
      "outputs": { "codex": "sha256:…" },
      "agents": ["codex"]
    }
  }
}
```

- **`version` is THE pin.** `sync` reproduces the recorded version exactly. `commit` is only a
  resolution cache; `sourceHash` is the canonical source-tree hash; `outputs` holds one hash per
  materialized copy (the drift guard). `agents` is an optional filter — omit it to target all
  agents.
- **`mode`** (`committed | gitignored | plain`) is proposed by `init` and stored explicitly. In
  `gitignored` mode, the manifest and each materialized skill dir are added to
  `.git/info/exclude` (a per-machine, marker-delimited managed block) — the team's tracked
  `.gitignore` is never touched.
- Serialization is deterministic (sorted skill keys, stable field order, trailing newline) so
  committed manifests diff cleanly.

## Hash scheme

One deterministic function hashes both the canonical source tree (`sourceHash`) and every
materialized copy (`outputs.<agent>`). Given a skill directory:

1. Collect all **regular** files recursively (symlinks and non-regular files are rejected — see
   input policy). Compute each file's POSIX path relative to the skill root.
2. Sort files ascending by that relative path (byte order).
3. `h = sha256()`. For each file in order:
   - `h.update("<relpath>\n<mode-class>\n<size>\n")` (UTF-8), where `mode-class` is `exec` if the
     owner-execute bit is set, else `file` (only the execute bit matters);
   - `h.update(<raw file bytes>)`, streamed (bounded memory);
   - `h.update("\n")` as a record separator.
4. Digest is `"sha256:" + hex`.

The scheme is stable across machines and filesystems: sorted **relative paths** + **mode-class** +
**size** + **content**. Materialized copies have their mode normalized (`0o755`/`0o644`) so the
output hash is filesystem-independent. With v1's no-op adaptation, `sourceHash` and both output
hashes are equal; each is computed independently so the future adaptation layer needs no rewiring.

## Fetch & pin resolution

Remote-first and tool-owned: every operation clones into a temp dir using your own git
credentials; there is no persistent per-machine clone.

- `add` full-clones central and records the HEAD commit and the skill's frontmatter version as the
  pin. Duplicate/regressed versions in central history are a single-author authoring error whose
  guidance lives in the central repo; skillsync does not police it, because sync is already
  protected by the commit + `sourceHash` pins (worst case is a clear resolve error, not a corrupt
  copy).
- `sync` reproduces the recorded **version**. The recorded `commit` is only a resolution cache and
  is **not authoritative**: it is accepted only if the skill at that commit declares the pinned
  version **and** its tree matches the recorded `sourceHash`. Retrieval escalates:
  1. **cache** — fetch the recorded commit; accept it only if version and tree both match;
  2. **fast path / full** — `git fetch --depth 1 origin <commit>`, else unshallow / fetch all
     branches;
  3. if the cache is stale/wrong-tree/unreachable, resolve the pinned **version** to a commit as the
     **newest first-parent commit whose `<skill>/SKILL.md` declares it**.
  The fetched tree's hash is checked against the recorded `sourceHash`, **and each staged output
  hash against the recorded per-agent hash**, before any project file is swapped; a mismatch aborts
  cleanly. Reproducibility depends on central history retaining the pinned content.

## Materialization

A mutation runs with the **project lock acquired first** and held across the whole
`read manifest → plan → install` sequence. Before the lock is taken, the project container
is validated with non-following `lstat`s — a symlinked `.agents/` is refused, never followed out of
the project. The lock is a directory published atomically by `rename` (with a random ownership
token); acquisition **waits** for a concurrent holder and reclaims a lock only when its recorded
holder is provably gone on this host — `kill(pid, 0)` reports **ESRCH** (no such process). A pid
that still exists (including a reused one) is treated as held; the acquire timeout, and its
manual-removal message for an old lock, cover that case.

1. **stage** — generate each target's artifact into a private (`0700`) staging dir under `.agents/`,
   then **scan, validate, and hash the STAGED tree** (not the source checkout). The staged hash is
   authoritative — it is what the manifest records (`add`) or is verified against (`sync`).
2. **install** — for each target, a plain existence check removes any current copy and the staged dir
   is **atomically renamed** into place, so an agent never observes a half-written skill (`rename`
   makes the whole new tree appear at once). Then removals are applied.
3. **manifest last** — the manifest is written **last** via write-temp + **fsync** + atomic rename.
   Because it lands last and atomically, the manifest **always describes the last fully-completed
   state**.

**Durability.** The one `fsync` that matters is the manifest write: flushing its bytes before the
rename keeps "the manifest describes the last completed state" honest across a power loss. Any fsync
error propagates raw. Everything else relies on **idempotent re-run**, not on per-file or
per-directory syncing.

**Crash model — recovery is re-running.** There is no backup or recovery state machine. Because the
manifest is written last and atomically, it always reflects the last completed state; a crash
mid-operation leaves at most (a) a stale staging dir — swept on the next lock acquisition (age-based,
only dirs matching the staging-name pattern, never followed through a symlink) — and (b) copies
whose on-disk hash does not match the manifest, which the next `sync`/`add` re-materializes.
Recovering an interrupted run therefore means simply **running it again**.

**Local-user trust.** Confinement uses non-following `lstat`s and private staging; a fully
race-proof, fd-relative install (`openat`/`renameat2`) is not expressible in zero-dependency Node, so
skillsync assumes a **non-hostile local user** — an attacker who can already write inside your project
as you does not need a TOCTOU race (ADR 0003).

## Per-agent adaptation

The central format **is** Claude-native, so the stage step transforms each skill per target agent
before hashing:

- **Claude** (`.claude/skills/<name>/`) — copied **verbatim**. Nothing to translate.
- **Codex** (`.agents/skills/<name>/`) — the SKILL.md frontmatter is rewritten and, where needed, a
  sidecar is generated:
  - **Invocation switch.** Claude's `disable-model-invocation: true` (in SKILL.md) and Codex's
    `policy.allow_implicit_invocation: false` (in `agents/openai.yaml`) express the same intent —
    *the model must not auto-invoke; the user still can* — with a different key, opposite polarity,
    and a different file. skillsync **drops the Claude key** from the Codex SKILL.md and **emits (or
    merges into) `agents/openai.yaml`** with `policy.allow_implicit_invocation: false`. A pre-existing
    sidecar is **merged, not clobbered** (the `interface:`/`dependencies:` sections survive; only the
    policy value is set). The Claude key is always removed from the Codex copy; the sidecar is written
    only when it was `true`. Empirically verified against Codex CLI 0.144.1 (see research docs).
  - **Claude-only keys** with no Codex equivalent (`when_to_use`, `user-invocable`, `allowed-tools`,
    `disallowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`, `arguments`,
    `argument-hint`) are **dropped from the Codex copy with a one-line warning** naming the skill and
    key. Codex would ignore them; shipping them is misleading.
  - **Everything else** — body, supporting files, and spec-portable frontmatter (`name`,
    `description`, `version`, `license`, …) — copies through byte-for-byte.

Frontmatter rewriting is **textual**: the dropped key's line and any indented continuation lines are
removed from the original block (no re-serialization), preserving formatting. Adaptation is
**forward-only** — there is no de-adaptation path.

Because the Codex and Claude copies now genuinely differ, their per-target `outputs.{claude,codex}`
hashes stop being identical whenever a transform applies. Each copy is scanned and hashed
**independently** off its staged tree, so drift detection remains correct per copy. The per-skill
`agents: [...]` filter composes with the transforms: a `codex`-only skill materializes only the
transformed Codex output.

## Filesystem input policy

Skill trees are validated before they are hashed or copied:

- symlinks and non-regular files (FIFO/socket/device) are **rejected**;
- per-file (5 MiB), per-skill (25 MiB), and file-count (2000) limits are enforced;
- **case-fold path collisions** are detected on the full relative path — a tree with two paths that
  differ only by case (two entries on Linux, one on case-insensitive macOS) is rejected;
- hashing and copying are streamed (bounded memory regardless of file size).

Skill names are validated against the Agent Skills grammar (lowercase letters/digits/single
hyphens) at every boundary, the frontmatter `name` must equal the skill directory name, and a
manifest pin's `outputs` must be exactly one hash per selected agent.

A materialized copy that cannot be hashed for any reason **other than being absent** (a symlink,
FIFO, oversized, or unreadable file swapped in) is an **anomaly**: `sync`/`list` report it as such
and `sync` skips it (only `--force` overwrites). Only a genuinely absent copy is `missing`.

## Git-state preflight

Before a mutating operation in `committed`/`gitignored` mode, skillsync refuses to run during an
in-progress merge/rebase/cherry-pick and refuses a manifest containing conflict markers; it warns
on a detached HEAD. Plain-mode and read-only operations never require a branch.

## YAML frontmatter reader

skillsync consumes exactly two frontmatter fields — `name` (checked against the skill directory
name) and `version` (re-constrained by `\d+\.\d+` normalization) — so the hand-rolled reader does
the minimum needed to extract them robustly and **ignore everything else**. It reads a leading
`---`-delimited block (LF or CRLF, leading UTF-8 BOM stripped) and, for each **top-level
`key: value` line**, strips matching surrounding quotes off the value and records it as a string.
Indented content (nested mappings, block scalars, sequence items) and non-`key: value` lines are
**skipped, not rejected** — an exotic-but-valid YAML construct never fails a file. The **only**
fail-closed case is a duplicated `name`/`version` (identity keys must be unambiguous); it also never
evaluates a `---js` block. Versions are canonicalized with BigInt (leading zeros stripped, arbitrary
width) so `01.02` and `1.2` are the same pin.

## Design

Decisions and the pre-implementation adversarial review live in the Wayfinder workspace:

- ADR 0001 — remote-first, tool-owned fetch
- ADR 0002 — custom tool; `npx skills` demoted to reference implementation
- ADR 0003 — zero-dependency Node, git-distributed, no registry
- Manifest schema (#6), update/versioning model (#5), authoring/`suggest` flow (#16), and the
  adversarial design review.

## Tests

```sh
node --test    # or: npm test
```

Built-in `node:test`, zero dependencies. Fixtures (central git repos, bare remotes) are built at
test time — no committed binaries.

## License

MIT
