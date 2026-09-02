#!/bin/sh
# Install and activate the nightly breadth LaunchDaemon.

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PLIST_PATH="/Library/LaunchDaemons/nz.grocery-prices.breadth.plist"
LABEL="nz.grocery-prices.breadth"
COLLECTOR_USER="${BREADTH_COLLECTOR_USER:-${SUDO_USER:-$(id -un)}}"

if [ "$COLLECTOR_USER" = "root" ]; then
  echo "Set BREADTH_COLLECTOR_USER to the local account that owns the repository." >&2
  exit 1
fi

tmp=$(mktemp "${TMPDIR:-/tmp}/nz-grocery-breadth.XXXXXX.plist")
trap 'rm -f "$tmp"' EXIT HUP INT TERM

sed \
  -e "s|/REPLACE/WITH/ABSOLUTE/PATH/scripts/breadth-pilot-nightly.sh|$REPO_ROOT/scripts/breadth-pilot-nightly.sh|" \
  -e "s|/REPLACE/WITH/ABSOLUTE/PATH</string>|$REPO_ROOT</string>|" \
  -e "s|REPLACE_WITH_COLLECTOR_USERNAME|$COLLECTOR_USER|" \
  "$REPO_ROOT/ops/nz.grocery-prices.breadth.daemon.plist.template" > "$tmp"

plutil -lint "$tmp"
sudo cp "$tmp" "$PLIST_PATH"
sudo chown root:wheel "$PLIST_PATH"
sudo chmod 644 "$PLIST_PATH"
sudo launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
sudo launchctl bootstrap system "$PLIST_PATH"
echo "Installed $LABEL for $COLLECTOR_USER; scheduled daily at 3:30am."
