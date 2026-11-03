#!/usr/bin/env bash
# Sets up zWatchtower on a fresh Ubuntu 24.04 server (DigitalOcean droplet).
# Run as root:  bash setup-server.sh
# It asks for your Helius RPC URL and Discord webhook (typed, not shown) and
# prints a deploy key to add to the GitHub repo. Nothing is sent anywhere else.
set -euo pipefail
REPO=Mirrorisor/zWatchtower
APP=/opt/zwatchtower/app

echo "== 1/5 Installing git and Node.js"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git nodejs ca-certificates openssh-client >/dev/null
node -e 'if (+process.versions.node.split(".")[0] < 18) { console.error("Node 18+ needed"); process.exit(1) }'
echo "   node $(node -v)"

echo "== 2/5 Creating the zwatch user and its GitHub deploy key"
id zwatch >/dev/null 2>&1 || useradd -m -s /bin/bash zwatch
sudo -u zwatch mkdir -p /home/zwatch/.ssh
[ -f /home/zwatch/.ssh/deploy ] || sudo -u zwatch ssh-keygen -q -t ed25519 -N "" -C "zwatchtower-server" -f /home/zwatch/.ssh/deploy
sudo -u zwatch bash -c 'ssh-keyscan -t ed25519 github.com > ~/.ssh/known_hosts 2>/dev/null
printf "Host github.com\n  IdentityFile ~/.ssh/deploy\n  IdentitiesOnly yes\n" > ~/.ssh/config; chmod 600 ~/.ssh/config'

echo "== 3/5 Getting the code and results"
mkdir -p /opt/zwatchtower && chown zwatch: /opt/zwatchtower
[ -d "$APP/.git" ] || sudo -u zwatch git clone -q "https://github.com/$REPO.git" "$APP"
[ -d "$APP/data/.git" ] || sudo -u zwatch git clone -q --branch status --depth 50 "https://github.com/$REPO.git" "$APP/data"
[ -d "$APP/pages/.git" ] || sudo -u zwatch git clone -q --branch gh-pages --depth 5 "https://github.com/$REPO.git" "$APP/pages"
for d in data pages; do
  sudo -u zwatch git -C "$APP/$d" remote set-url --push origin "git@github.com:$REPO.git"
  sudo -u zwatch git -C "$APP/$d" config user.name "zwatchtower-server"
  sudo -u zwatch git -C "$APP/$d" config user.email "zwatchtower-server@users.noreply.github.com"
done
chmod +x "$APP/deploy/run.sh"

echo "== 4/5 Your keys (typing is hidden; nothing is shown or sent anywhere but this server)"
if [ ! -f /etc/zwatchtower.env ]; then
  read -rsp "   Helius RPC URL (https://mainnet.helius-rpc.com/?api-key=...): " RPC; echo
  read -rsp "   Discord webhook URL + /slack (Enter to skip): " HOOK; echo
  umask 077
  { echo "WATCHTOWER_SOLANA_RPC=$RPC"; [ -n "$HOOK" ] && echo "WATCHTOWER_WEBHOOK=$HOOK"; } > /etc/zwatchtower.env
  chown root:zwatch /etc/zwatchtower.env; chmod 640 /etc/zwatchtower.env
fi

echo
echo "== 5/5 Add this deploy key to GitHub, so the server can save results:"
echo "   github.com/$REPO -> Settings -> Deploy keys -> Add deploy key"
echo "   Title: zwatchtower-server     Tick: Allow write access"
echo
cat /home/zwatch/.ssh/deploy.pub
echo
read -rp "   Press Enter once it's added... " _
if sudo -u zwatch ssh -o BatchMode=yes -T git@github.com 2>&1 | grep -qi "successfully authenticated"; then
  echo "   GitHub accepted the key."
else
  echo "   GitHub didn't accept the key yet. Check it was added with write access, then run: bash $APP/deploy/setup-server.sh"; exit 1
fi

cat > /etc/systemd/system/zwatchtower.service <<UNIT
[Unit]
Description=zWatchtower checks (one round)
After=network-online.target
[Service]
Type=oneshot
User=zwatch
ExecStart=$APP/deploy/run.sh
TimeoutStartSec=50min
UNIT
cat > /etc/systemd/system/zwatchtower.timer <<UNIT
[Unit]
Description=zWatchtower every 5 minutes
[Timer]
OnCalendar=*:0/5
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now zwatchtower.timer
systemctl start --no-block zwatchtower.service
echo
echo "Done. zWatchtower now runs every 5 minutes (a round waits for the previous one to finish)."
echo "Watch it:  journalctl -u zwatchtower -f      Next runs:  systemctl list-timers zwatchtower"
