#!/bin/sh
# Install or refresh the nightly breadth pilot user LaunchAgent (3:30am).
# Installs into the user's GUI domain, so no sudo is required; the job fires
# while the user is logged in. For a headless machine, adapt
# nz.grocery-prices.breadth.agent.plist.template into a LaunchDaemon instead
# (add UserName, install under /Library/LaunchDaemons, bootstrap system).
#
# Safe to re-run: boots out the previous generation before bootstrapping the
# new one, so changed job definitions always take effect.

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PLIST_PATH="$HOME/Library/LaunchAgents/nz.grocery-prices.breadth-pilot.plist"
LABEL="nz.grocery-prices.breadth-pilot"
DOMAIN="gui/$(id -u)"

tmp=$(mktemp "${TMPDIR:-/tmp}/nz-grocery-breadth-agent.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM

# One global substitution covers every placeholder in the template (script
# path, working directory, log paths) — keep it global when adding fields.
sed -e "s|/REPLACE/WITH/ABSOLUTE/PATH|$REPO_ROOT|g" \
  "$REPO_ROOT/ops/nz.grocery-prices.breadth.agent.plist.template" > "$tmp"

plutil -lint "$tmp"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO_ROOT/data/logs"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
cp "$tmp" "$PLIST_PATH"
launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl print "$DOMAIN/$LABEL" >/dev/null
echo "Installed $LABEL ($PLIST_PATH); scheduled daily at 3:30am while logged in."
echo "Logs: $REPO_ROOT/data/logs/"
