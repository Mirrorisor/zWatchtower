#!/usr/bin/env bash
# Adds X (Twitter) posting keys to the zWatchtower server. Run as root:
#   bash /opt/zwatchtower/app/deploy/setup-x.sh
# Asks for the four keys one at a time, saves them in /etc/zwatchtower.env
# (replacing any old ones), then checks with X which account they post as.
set -euo pipefail
APP=/opt/zwatchtower/app
ENVF=/etc/zwatchtower.env
sudo -u zwatch git -C "$APP" pull -q
clean() { local v="$1"; v=${v//$'\e[200~'/}; v=${v//$'\e[201~'/}; printf %s "$v" | tr -d '\r\n\t '; }
ask() {
  local label="$1" v
  read -rp "$label: " v
  v=$(clean "$v")
  [ -n "$v" ] || { echo "   nothing entered, stopping (nothing saved)"; exit 1; }
  echo "   got ${#v} characters, ending …${v: -4}" >&2
  printf %s "$v"
}
echo "Paste each key from the X developer console and press Enter."
K=$(ask "1/4 API Key (Consumer Key)")
S=$(ask "2/4 API Key Secret (Consumer Secret)")
T=$(ask "3/4 Access Token")
A=$(ask "4/4 Access Token Secret")
grep -v '^X_\(API_KEY\|API_SECRET\|ACCESS_TOKEN\|ACCESS_SECRET\)=' "$ENVF" > "$ENVF.new" || true
{ echo "X_API_KEY=$K"; echo "X_API_SECRET=$S"; echo "X_ACCESS_TOKEN=$T"; echo "X_ACCESS_SECRET=$A"; } >> "$ENVF.new"
chown root:zwatch "$ENVF.new"; chmod 640 "$ENVF.new"; mv "$ENVF.new" "$ENVF"
echo "Saved. Checking with X (nothing is posted)…"
X_API_KEY=$K X_API_SECRET=$S X_ACCESS_TOKEN=$T X_ACCESS_SECRET=$A node "$APP/x-check.mjs"
