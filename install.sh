#!/bin/sh
# Backburner installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/MeagerPotato/backburner/main/install.sh | sh
#
# Installs the `backburner` command with npm, then runs `backburner setup`, which finds
# the AI tools on this computer (Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor,
# Windsurf) and asks which ones to connect.
#
# BACKBURNER_SOURCE  install from another tarball or folder instead of GitHub main
# BACKBURNER_NO_SETUP=1  install only; run `backburner setup` yourself later
set -eu

SOURCE="${BACKBURNER_SOURCE:-https://github.com/MeagerPotato/backburner/archive/refs/heads/main.tar.gz}"

say() { printf '%s\n' "$*"; }
die() { say "$*" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  die "Backburner needs Node.js 20 or newer. Install it from https://nodejs.org (or with your package manager), then run this again."
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  die "Backburner needs Node.js 20 or newer; you have $(node -v). Update it from https://nodejs.org, then run this again."
fi
command -v npm >/dev/null 2>&1 || die "npm wasn't found. It comes with Node.js; reinstall Node from https://nodejs.org."

say "Installing Backburner..."
if ! npm install -g "$SOURCE"; then
  say ""
  say "npm couldn't install globally. If it said EACCES (permission denied), either"
  say "  run this again with sudo:  curl -fsSL https://raw.githubusercontent.com/MeagerPotato/backburner/main/install.sh | sudo sh"
  say "  or let npm install into your home folder:  npm config set prefix ~/.npm-global  (then add ~/.npm-global/bin to PATH)"
  exit 1
fi

# The new command may not be on PATH in this shell yet.
BIN="backburner"
if ! command -v backburner >/dev/null 2>&1; then
  BIN="$(npm prefix -g)/bin/backburner"
  say "Note: $(dirname "$BIN") isn't on your PATH. Add it so you can type \`backburner\`."
fi

if [ "${BACKBURNER_NO_SETUP:-}" = "1" ]; then
  say "Installed. Run \`backburner setup\` to connect your AI tools."
  exit 0
fi

# Piped into sh, stdin is the script itself; setup's questions need the terminal.
if [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then
  say ""
  "$BIN" setup </dev/tty
else
  say "No terminal to ask questions in, so connecting every AI tool found with default settings."
  "$BIN" connect --all
  say "Run \`backburner setup\` in a terminal to change reserves and turn on the background schedule."
fi
