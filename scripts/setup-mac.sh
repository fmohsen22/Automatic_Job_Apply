#!/usr/bin/env bash
#
# One-run setup for Sophie App on macOS.
# Checks every requirement, installs whatever is missing, then offers to start.
# Safe to run again any time — it skips what's already installed.
#
set -u

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
say()   { printf '%s\n' "$*"; }
step()  { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail()  { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET"; exit 1; }

printf '%s\n' "${BOLD}👑  Sophie App — Mac setup${RESET}"
say "${DIM}This checks what your Mac needs and installs anything missing. You may be asked for your Mac password.${RESET}"

# Must be run from inside the project (it needs package.json).
cd "$(dirname "$0")/.." 2>/dev/null || true
if [ ! -f package.json ]; then
  fail "Run this from inside the Sophie App folder (the one with package.json)."
fi

# 1. Homebrew — the installer that fetches everything else.
step "Homebrew (software installer)"
if command -v brew >/dev/null 2>&1; then
  ok "already installed"
else
  warn "installing Homebrew — this can take a few minutes"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || fail "Homebrew install failed. Check your internet connection and try again."
fi
# Make brew usable in this session (Apple Silicon uses /opt/homebrew, Intel uses /usr/local).
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)" || true
command -v brew >/dev/null 2>&1 || fail "Homebrew isn't on the PATH. Close Terminal, reopen it, and run this again."

# 2. Node.js and Git.
step "Node.js and Git"
for pkg in node git; do
  if command -v "$pkg" >/dev/null 2>&1; then
    ok "$pkg already installed"
  else
    warn "installing $pkg"
    brew install "$pkg" || fail "Could not install $pkg."
    ok "$pkg installed"
  fi
done
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
if printf '%s' "$NODE_MAJOR" | grep -qE '^[0-9]+$' && [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node is older than v20 — upgrading"
  brew upgrade node || brew install node || fail "Could not upgrade Node."
fi
ok "Node $(node -v)"

# 3. App dependencies + the browser used for apply and designed PDFs.
step "Sophie's parts (app dependencies + browser)"
say "  ${DIM}downloading — a few minutes the first time…${RESET}"
npm install || fail "npm install failed."
ok "dependencies installed"
npx playwright install chromium || fail "Could not download the browser (Chromium)."
ok "browser ready"

# 4. Optional: LibreOffice for one-click PDF export (large download).
step "LibreOffice (optional — one-click PDFs)"
if [ -d "/Applications/LibreOffice.app" ] || command -v soffice >/dev/null 2>&1; then
  ok "already installed"
else
  printf '  Install LibreOffice now? It is a large (~700 MB) download but gives you one-click PDFs. [y/N] '
  read -r answer || answer="n"
  case "$answer" in
    [yY]*) brew install --cask libreoffice && ok "installed" || warn "skipped (you can install it later)";;
    *)     warn "skipped — you'll still get editable Word files; install it later with: brew install --cask libreoffice";;
  esac
fi

# Put a one-click launcher on the Desktop (absolute path baked in, so it works
# from anywhere — unlike copying run-mac.command, which uses a relative path).
step "Desktop shortcut"
APP_DIR="$(pwd)"
LAUNCHER="$HOME/Desktop/Start Sophie App.command"
if {
  printf '#!/bin/zsh\n'
  printf 'eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"\n'
  printf 'cd "%s"\n' "$APP_DIR"
  printf 'exec node scripts/bootstrap-local.mjs\n'
} > "$LAUNCHER" 2>/dev/null && chmod +x "$LAUNCHER" 2>/dev/null; then
  ok "added \"Start Sophie App\" to your Desktop — double-click it any time to start"
else
  warn "couldn't add a Desktop shortcut — you can still start from this folder"
fi

# Done.
printf '\n%s✓ All set!%s Sophie App is ready.\n' "$GREEN$BOLD" "$RESET"
printf '  Next time, just double-click %s"Start Sophie App"%s on your Desktop.\n' "$BOLD" "$RESET"
printf '  (Or run %snpm run local%s from this folder.)\n\n' "$BOLD" "$RESET"

printf 'Start Sophie App now? [Y/n] '
read -r start || start="y"
case "$start" in
  [nN]*) say "Okay — start it any time with: npm run local";;
  *)     step "Starting Sophie App…"; exec npm run local;;
esac
