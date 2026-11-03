#!/usr/bin/env bash
# One zWatchtower round on the server: get the latest code and results, run
# the checks that are due, push the results to the `status` branch and the
# dashboard to the `gh-pages` branch (which GitHub Pages serves). Run by
# zwatchtower.timer.
set -euo pipefail
APP=/opt/zwatchtower/app
cd "$APP"
git fetch -q origin main && git reset -q --hard origin/main
cd "$APP/data"
git fetch -q origin status && git reset -q --hard origin/status
cd "$APP"
set -a; . /etc/zwatchtower.env; set +a
rm -rf "$APP/site"
# every check now, due or not:  touch /opt/zwatchtower/run-all && systemctl start zwatchtower
DUE=--due
if [ -e /opt/zwatchtower/run-all ]; then rm -f /opt/zwatchtower/run-all; DUE=; echo "running every check (run-all)"; fi
node watchtower.mjs --once $DUE --export site --config watchtower.ci.json || true   # exit 1 just means alerts are open
cd "$APP/data"
git add -A
if ! git diff --cached --quiet; then
  git commit -qm "results $(date -u +%Y-%m-%dT%H:%MZ) (server)"
  git push -q origin HEAD:status || echo "push refused (another run pushed first); results are redone next round"
fi
# the dashboard: GitHub Pages serves the gh-pages branch. Pages rebuilds on
# every push and suggests at most ~10 builds an hour, so publish at most
# every 10 minutes (checks and alerts still run every 5).
cd "$APP/pages"
git fetch -q origin gh-pages && git reset -q --hard origin/gh-pages
if [ -n "$DUE" ] && [ $(( $(date +%s) - $(git log -1 --format=%ct) )) -lt 570 ]; then exit 0; fi
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$APP/site/." .
git add -A
if ! git diff --cached --quiet; then
  git commit -qm "site $(date -u +%Y-%m-%dT%H:%MZ)"
  git push -q origin HEAD:gh-pages || echo "site push refused; redone next round"
fi
