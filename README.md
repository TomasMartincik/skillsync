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
`recover → read manifest → plan → apply` sequence **under** it (so two concurrent commands
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
  enumerating the **first-parent boundaries** that changed the skill's `SKILL.md` and locating the
  skill directory **at each boundary**, so a skill that moved (e.g. `old/foo` → `new/foo`) keeps
  every historical release resolvable.
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

## Transactional materialization

A mutation is one transaction, with the **project lock acquired first** and held across the whole
`recover → read manifest → plan → apply` sequence. Before the lock is taken, the project container
is validated with non-following `lstat`s — a symlinked `.agents/` is refused, never followed out of
the project. The lock is a directory published atomically by `rename` (with a random ownership
token); acquisition **waits** for a concurrent holder and reclaims a lock only when its recorded
holder is provably gone on this host — the pid no longer exists, or the pid exists but its process
**start time** differs from the recorded one (so a reused pid does not strand the lock). When
liveness cannot be verified and the lock is old, the timeout error explains manual recovery.

1. **stage** — generate each target's artifact into a private staging area under `.agents/`, then
   **scan, validate, and hash the STAGED tree** (not the source checkout) and fsync it — files **and**
   every nested directory. Regular-file fsync errors are fatal (a partial staged tree must never be
   committed). The staged hash is authoritative — it is what the manifest records (`add`) or is
   verified against (`sync`), and what recovery revalidates before every swap.
2. **journal** — atomically write `.agents/.skillsync-txn.json` recording the complete next state as
   **project-relative** paths, the authoritative staged hash per swap, and a **MAC** over the whole
   body under a machine-local secret. Before journaling, the complete next manifest is validated,
   every concrete staged/target/backup path is confined to an allowed root beneath the project,
   symlinked ancestors are rejected, duplicate target/backup paths are rejected, and staging + all
   targets/backups are verified to be on the **same filesystem** (so a rename can never fail with
   `EXDEV` partway).
3. **apply** — for each target: revalidate the staged tree against its journaled hash, move any
   existing dir aside to a backup, then atomically rename the staged dir into place (re-checking the
   parent for a symlink first and fsyncing both rename parents); then removals; then write the
   manifest **last** via atomic rename.
4. **cleanup** — remove staging, backups, and the journal (only after a fully successful apply).

**Crash recovery is roll-forward and fail-closed.** At the start of every mutating command, under
the lock, an interrupted transaction is rolled forward (`apply` is idempotent). A journal is
executed only after its **MAC authenticates it** as created by a skillsync transaction on **this
machine** and it is fully path-confined and same-device (all re-checked during recovery). The MAC is
keyed on a machine-local secret (not the hostname or checkout path), so a hostname change or a
same-filesystem project move is recovered rather than stranded. When staging is present its hash is
revalidated before the swap; when staging is **absent** the live target hash is verified before the
swap is treated as complete — "staging missing" is never proof of completion. A corrupt, foreign, or
tampered journal, or any ambiguity, is refused and **nothing is deleted**: staging, backups, and the
journal are **preserved** for repair.

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
**ignoring** any other valid YAML rather than rejecting the whole block. It handles quoted scalars
with escapes (`\"`, `\\`, `''`), unquoted scalars with trailing `#` comments, integers, booleans,
`null`/`~`, inline (`[a, b]`) and block (`- a`) sequences, **folded `>` and literal `|` block
scalars**, and **nested mappings** (consumed and ignored). Decimal tokens (e.g. `1.10`) are kept as
strings so version pins are never truncated, and a leading UTF-8 BOM is stripped. It still **fails
closed** on an unterminated quote and on a duplicated `name`/`version` (identity keys must be
unambiguous), and it never evaluates a `---js` block. Versions are canonicalized with BigInt
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
