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
| `add <skill>… [--agents claude,codex]` | Enable skills at central's **current** published version, materialize them, and record their pins. `--agents` restricts which agents get a copy. |
| `remove <skill>…` | Disable skills: drop their pins and delete their materialized copies. |
| `sync [--force]` | Materialize **exactly** what the manifest pins (version-exact). Never advances pins. Skips a drifted copy with a warning; `--force` overwrites it. |
| `list` | Show pinned skills and each copy's status (`ok` / `missing` / `drifted`). Read-only; no network. |
| `suggest <skill>\|--new <name> [--file <path> \| -m "…"]` | File a **text-only** change request as a `suggest/<skill>-<slug>-<id>` branch on central. No diff machinery; the request is prose (from `--file`, `-m`, or stdin). Never force-pushed. |

`init`, `add`, `remove`, `sync` take a project-scoped exclusive lock and run as a single
transaction (below). `list` and `suggest` do not mutate project skill trees.

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

- `add` shallow-clones central and records the HEAD commit and the skill's frontmatter version.
- `sync` reproduces the recorded **version**. Pin retrieval escalates:
  1. **fast path** — `git fetch --depth 1 origin <recorded-commit>`;
  2. **deepen** — shallow-fetch the default branch, then `--deepen` in steps;
  3. **full** — unshallow / fetch all branches;
  4. if the commit is still unreachable, resolve the version to a commit by walking **first-parent**
     history (versions must be unique and monotonic; regressions are rejected).
  The fetched tree's hash is checked against the recorded `sourceHash` **before any project file is
  touched**; a mismatch aborts cleanly. Reproducibility depends on central history retaining the
  pinned objects.

## Transactional materialization

A mutation is one transaction (project lock held throughout):

1. **stage** — copy each target dir's files into a private staging area under `.agents/`; validate
   and hash them there. Nothing under the live skill dirs is touched yet.
2. **journal** — atomically write `.agents/.skillsync-txn.json` recording the complete next state
   (the final manifest string plus every directory swap/removal). Its presence means "a transaction
   is mid-flight".
3. **apply** — for each target: move any existing dir aside to a backup, then atomically rename the
   staged dir into place; then removals; then write the manifest **last** via atomic rename. All
   renames are same-filesystem, hence atomic.
4. **cleanup** — remove staging, backups, and the journal.

**Crash recovery is roll-forward.** Because the journal is written only after staging is complete
and durable, recovery re-runs `apply` (which is idempotent) and `cleanup`, deterministically
completing whatever was interrupted. Recovery runs at the start of every mutating command, under
the lock.

## Filesystem input policy

Skill trees are validated before they are hashed or copied:

- symlinks and non-regular files (FIFO/socket/device) are **rejected**;
- per-file (5 MiB), per-skill (25 MiB), and file-count (2000) limits are enforced;
- **case/Unicode-fold path collisions** are detected (a tree that is two files on Linux but one on
  case-insensitive macOS is rejected);
- hashing and copying are streamed (bounded memory regardless of file size).

## Git-state preflight

Before a mutating operation in `committed`/`gitignored` mode, skillsync refuses to run during an
in-progress merge/rebase/cherry-pick and refuses a manifest containing conflict markers; it warns
on a detached HEAD. Plain-mode and read-only operations never require a branch.

## YAML frontmatter subset

The hand-rolled parser supports a deliberately small subset: a leading `---`-delimited block
(LF or CRLF) of **top-level** `key: value` entries only — quoted/unquoted string scalars, integers,
booleans, `null`/`~`, and both inline (`[a, b]`) and block (`- a`) sequences of scalars; full-line
`#` comments and blanks are ignored. Decimal tokens (e.g. `1.10`) are kept as strings so version
pins are never truncated. Nested maps, anchors, multi-line scalars, and tags are not supported. It
never evaluates `---js` blocks.

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
