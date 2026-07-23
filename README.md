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

This is the **core** (Wayfinder ticket #12). The adaptation layer, update machinery, hooks, and
`install.sh` are separate tickets (#13–#15); this repo leaves clean seams for them.

## Install

An installer (`curl | bash` → `~/.local/share/skillsync`) ships in a later ticket (#15). For now,
clone this repo and run the entry point directly:

```sh
node /path/to/skillsync/bin/skillsync.js <command>
# or symlink it onto your PATH as `skillsync`
```

Requires Node ≥ 18 and git.

## Commands

| Command | What it does |
| --- | --- |
| `init [--source <git-url>] [--mode committed\|gitignored\|plain] [--yes]` | Create the project manifest. Mode is proposed from git context (git repo → `committed`, else `plain`). `--source` is stored and, on first use, learned as this machine's default after a one-time confirmation (`--yes` to confirm non-interactively). |
| `add <skill>… [--agents claude,codex]` | Enable skills at central's **current** published version (validating each skill's publication history), materialize them, and record their pins. `--agents` restricts which agents get a copy. |
| `remove <skill>…` | Disable skills: drop their pins and delete their materialized copies. |
| `sync [--force]` | Materialize **exactly** what the manifest pins (version-exact; the cached commit is not authoritative). Never advances pins. Skips a drifted or anomalous copy with a warning; `--force` overwrites it. |
| `list` | Show pinned skills and each copy's status (`ok` / `missing` / `drifted` / `anomaly`). Read-only; no network. |
| `suggest <skill>\|--new <name> [--file <path> \| -m "…"]` | File a **text-only** change request as a `suggest/<skill>-<slug>-<id>` branch on central. No diff machinery; the request is prose (from `--file`, `-m`, or stdin). Never force-pushed. |

`init`, `add`, `remove`, `sync` take a project-scoped exclusive lock and run their entire
`read manifest → plan → install` sequence **under** it (so two concurrent commands
queue and compose rather than clobbering each other). `add` full-clones central to validate a
skill's publication history before pinning. `list` and `suggest` do not mutate project skill
trees.

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

- `add` full-clones central, records the HEAD commit and the skill's frontmatter version, and
  **validates the skill's publication history** (versions must be unique and monotonic — a version
  reused across a real skill-tree change, or a regression, is rejected). History is walked by
  enumerating the **first-parent boundaries that changed anything in the skill's directory** — not
  just its `SKILL.md`, so a commit touching only `scripts/helper.js` under an unchanged version is
  caught as a duplicate version — and locating the skill directory **at each boundary**, so a skill
  that moved (e.g. `old/foo` → `new/foo`) keeps every historical release resolvable. The scan is
  batched (one `git log`, one `git cat-file --batch-check`) because it runs under the project lock.
- `sync` reproduces the recorded **version**. The recorded `commit` is only a resolution cache and
  is **not authoritative**: it is accepted only if the skill at that commit declares the pinned
  version **and** its tree matches the recorded `sourceHash`. Retrieval escalates:
  1. **cache** — fetch the recorded commit; accept it only if version and tree both match;
  2. **fast path / deepen / full** — `git fetch --depth 1 origin <commit>`, then `--deepen` in
     steps, then unshallow / fetch all branches;
  3. if the cache is stale/wrong-tree/unreachable, resolve the pinned **version** to a commit by
     walking **first-parent** history (again enforcing uniqueness + monotonicity).
  The fetched tree's hash is checked against the recorded `sourceHash`, **and each staged output
  hash against the recorded per-agent hash**, before any project file is swapped; a mismatch aborts
  cleanly. Reproducibility depends on central history retaining the pinned content.

## Materialization

A mutation runs with the **project lock acquired first** and held across the whole
`read manifest → plan → install` sequence. Before the lock is taken, the project container
is validated with non-following `lstat`s — a symlinked `.agents/` is refused, never followed out of
the project. The lock is a directory published atomically by `rename` (with a random ownership
token); acquisition **waits** for a concurrent holder and reclaims a lock only when its recorded
holder is provably gone on this host — the pid no longer exists, or the pid exists but its process
**start time** differs from the recorded one (so a reused pid does not strand the lock). Start
identity is compared **before** any pid short-circuit, including when the recorded pid is the
*current* process's own pid: a lock is treated as live only when pid **and** start identity match,
so a crashed holder's lock whose pid this process happens to inherit is still reclaimable. When
liveness cannot be verified and the lock is old, the timeout error explains manual recovery.

> **Stale-lock reclaim needs a process-start probe.** On Linux it reads `/proc/<pid>/stat`; on
> macOS it shells out to **`ps -o lstart= -p <pid>`**. If `ps` cannot be executed (a restricted
> sandbox), start identity is unknown and skillsync **refuses to steal** the lock — safe, but a
> stale lock must then be removed by hand (`rm -rf .agents/.skillsync.lock`), as the timeout error
> instructs.

1. **stage** — generate each target's artifact into a private (`0700`) staging dir under `.agents/`,
   then **scan, validate, and hash the STAGED tree** (not the source checkout). The staged hash is
   authoritative — it is what the manifest records (`add`) or is verified against (`sync`). Staged
   files and the staged dir are fsynced so the tree is durable before it is installed.
2. **install** — for each target, a plain existence check removes any current copy and the staged dir
   is **atomically renamed** into place, so an agent never observes a half-written skill (`rename`
   makes the whole new tree appear at once). Then removals are applied. Every directory skillsync
   creates (`.claude`, `.claude/skills`, `.agents`) and every rename parent is fsynced.
3. **manifest last** — the manifest is written **last** via write-temp + atomic rename. Because it
   lands last and atomically, the manifest **always describes the last fully-completed state**.

**Durability.** A light `fsync` of the staged files and the directories skillsync renames into makes
the manifest-last guarantee crash-durable. A regular-file fsync failure is fatal, and a filesystem
that cannot fsync those directories fails with a clear **`DURABILITY_UNSUPPORTED`** error naming the
path and platform code (rather than a raw errno). Local filesystems (APFS, HFS+, ext4, xfs, btrfs,
tmpfs) are supported; some network/FUSE mounts and restricted sandboxes are not. A directory fsync
the platform reports as a no-op (`EINVAL`/`ENOTSUP`) is tolerated.

**Crash model — recovery is re-running.** There is no journal, backup, or recovery state machine.
Because the manifest is written last and atomically, it always reflects the last completed state; a
crash mid-operation leaves at most (a) a stale staging dir — swept on the next lock acquisition
(age-based, only dirs matching the staging-name pattern, never followed through a symlink) — and (b)
copies whose on-disk hash does not match the manifest, which the next `sync`/`add` re-materializes.
Recovering an interrupted run therefore means simply **running it again**.

**Local-user trust.** Confinement uses non-following `lstat`s and private staging; a fully
race-proof, fd-relative install (`openat`/`renameat2`) is not expressible in zero-dependency Node, so
skillsync assumes a **non-hostile local user** — an attacker who can already write inside your project
as you does not need a TOCTOU race (ADR 0003).

## Filesystem input policy

Skill trees are validated before they are hashed or copied:

- symlinks and non-regular files (FIFO/socket/device) are **rejected**;
- per-file (5 MiB), per-skill (25 MiB), and file-count (2000) limits are enforced;
- **case/Unicode-fold path collisions** are detected per path component, directories included — a
  tree that is two entries on Linux but one on case-insensitive macOS (including file-vs-directory
  and folded-directory aliases) is rejected;
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

The hand-rolled parser reads a leading `---`-delimited block (LF or CRLF) and extracts the keys
skillsync needs (`name`, `version`, and the display-only `description`) **robustly**, while safely
**ignoring** any other valid YAML rather than rejecting the whole block. It handles quoted scalars,
unquoted scalars with trailing `#` comments, integers, booleans, `null`/`~`, inline (`[a, b]`) and
block (`- a`) sequences, **folded `>` and literal `|` block scalars**, and **nested mappings**
(consumed and ignored). Double-quoted strings implement the full **YAML escape table** (`\n`, `\t`,
`\"`, `\\`, `\0`, `\a`, `\b`, `\v`, `\f`, `\e`, `\N`, `\_`, `\L`, `\P`, and `\xNN` / `\uNNNN` /
`\UNNNNNNNN`); an **unknown or incomplete escape is rejected** rather than silently dropped, so
malformed input such as `name: "f\oo"` can no longer be normalized into the valid identity `foo`.
**Quoted top-level keys** (`"name": …`) are recognized, so they cannot hide a duplicate identity
key. Decimal tokens (e.g. `1.10`) are kept as strings so version pins are never truncated, and a
leading UTF-8 BOM is stripped. It still **fails closed** on an unterminated quote and on a duplicated
`name`/`version` (identity keys must be unambiguous), and it never evaluates a `---js` block. Versions are canonicalized with BigInt
(leading zeros stripped, arbitrary width) so `01.02` and `1.2` are the same pin and compare equal.

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
