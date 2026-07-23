#!/bin/sh
# skillsync installer — idempotent, POSIX sh, macOS/Linux (Windows via WSL).
#
#   curl -fsSL https://raw.githubusercontent.com/TomasMartincik/skillsync/main/install.sh | bash
#
# Clones (or fast-forwards) the tool into ~/.local/share/skillsync, symlinks
# bin/skillsync.js onto ~/.local/bin/skillsync, and finishes by installing the
# machine-global SessionStart hooks (unless SKILLSYNC_NO_HOOKS=1).
#
# Env overrides (mainly for testing): SKILLSYNC_REPO, SKILLSYNC_NO_HOOKS.
set -eu

REPO="${SKILLSYNC_REPO:-https://github.com/TomasMartincik/skillsync}"
DATA_DIR="$HOME/.local/share/skillsync"
BIN_DIR="$HOME/.local/bin"
LINK="$BIN_DIR/skillsync"

die() { printf 'skillsync install: %s\n' "$1" >&2; exit 1; }

# --- Prerequisites --------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH."
command -v node >/dev/null 2>&1 || die "Node.js >= 18 is required but 'node' was not found on PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  die "Node.js >= 18 is required (found $(node -v 2>/dev/null || echo unknown))."
fi

# --- Clone or update ------------------------------------------------------
if [ -d "$DATA_DIR/.git" ]; then
  printf 'skillsync: updating existing clone at %s\n' "$DATA_DIR"
  git -C "$DATA_DIR" pull --ff-only
else
  printf 'skillsync: cloning %s -> %s\n' "$REPO" "$DATA_DIR"
  mkdir -p "$(dirname "$DATA_DIR")"
  git clone "$REPO" "$DATA_DIR"
fi

# --- Symlink onto PATH ----------------------------------------------------
mkdir -p "$BIN_DIR"
chmod +x "$DATA_DIR/bin/skillsync.js"
ln -sf "$DATA_DIR/bin/skillsync.js" "$LINK"
printf 'skillsync: linked %s -> %s\n' "$LINK" "$DATA_DIR/bin/skillsync.js"

# --- PATH advice ----------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\nskillsync: %s is not on your PATH. Add it, e.g.:\n' "$BIN_DIR"
    printf '  export PATH="%s:$PATH"\n\n' "$BIN_DIR"
    ;;
esac

# --- Hooks ----------------------------------------------------------------
if [ "${SKILLSYNC_NO_HOOKS:-0}" = "1" ]; then
  printf 'skillsync: SKILLSYNC_NO_HOOKS=1 set — skipping hook installation.\n'
  printf '  Run `skillsync hooks install` later to enable session-start notices.\n'
else
  printf 'skillsync: installing session-start hooks...\n'
  "$DATA_DIR/bin/skillsync.js" hooks install
fi

printf '\nskillsync: done. Run `skillsync --help` to get started.\n'
