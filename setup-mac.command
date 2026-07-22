#!/bin/zsh
# Double-click this file to set up Sophie App on your Mac.
# It checks and installs everything needed, then offers to start.
cd "$(dirname "$0")"
chmod +x scripts/setup-mac.sh 2>/dev/null
exec /bin/bash scripts/setup-mac.sh
