#!/usr/bin/env bash
# Adds the zWatchtower Telegram bot to a server already set up with
# setup-server.sh. Run as root:  bash setup-bot.sh
# Asks for the bot token from @BotFather (kept in /etc/zwatchtower-bot.env,
# readable only by the service) and the alert channel's @name.
set -euo pipefail
APP=/opt/zwatchtower/app
[ -d "$APP/.git" ] || { echo "Run setup-server.sh first."; exit 1; }
sudo -u zwatch git -C "$APP" pull -q

if [ ! -f /etc/zwatchtower-bot.env ] || [ "${1:-}" = "--reset" ]; then
  read -rp "Bot token from @BotFather: " TOKEN
  TOKEN=$(printf %s "$TOKEN" | tr -d '\r\n ')
  echo "   got ${#TOKEN} characters"
  read -rp "Alert channel, e.g. @zwatchtower_alerts (Enter to skip): " CH
  CH=$(printf %s "$CH" | tr -d '\r\n ')
  umask 077
  { echo "TELEGRAM_BOT_TOKEN=$TOKEN"; [ -n "$CH" ] && echo "TELEGRAM_CHANNEL=$CH"; } > /etc/zwatchtower-bot.env
  chown root:zwatch /etc/zwatchtower-bot.env; chmod 640 /etc/zwatchtower-bot.env
fi

# check the token with Telegram before starting
set -a; . /etc/zwatchtower-bot.env; set +a
if curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | grep -q '"ok":true'; then
  echo "   Telegram accepted the token."
else
  echo "   Telegram didn't accept that token. Run again with: bash setup-bot.sh --reset"; exit 1
fi

cat > /etc/systemd/system/zwatchtower-bot.service <<UNIT
[Unit]
Description=zWatchtower Telegram bot
After=network-online.target
[Service]
User=zwatch
WorkingDirectory=$APP
EnvironmentFile=/etc/zwatchtower-bot.env
ExecStart=/usr/bin/node $APP/telegram-bot.mjs --data $APP/data --state /opt/zwatchtower/bot-state.json
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now zwatchtower-bot
systemctl restart zwatchtower-bot
sleep 3
journalctl -u zwatchtower-bot -n 3 --no-pager | tail -2
echo
echo "Done. Try it: message your bot  /check SARAH"
echo "Logs: journalctl -u zwatchtower-bot -f"
