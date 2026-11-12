#!/usr/bin/env bash
# Выкладка с компьютера разработчика: bash deploy/deploy.sh root@server
# Файл .env и база на сервере не затрагиваются.
set -euo pipefail

TARGET="${1:?Укажи сервер: bash deploy/deploy.sh root@server}"
cd "$(dirname "$0")/.."

tar czf - --exclude=.git --exclude=node_modules --exclude=dist --exclude=data --exclude=.env --exclude=.claude --exclude=notepad --exclude='*.pdf' --exclude='*.db' . \
  | ssh "$TARGET" 'tar xzf - -C /opt/monzoid --no-same-owner'

ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
export PATH=/usr/local/bin:$PATH
cd /opt/monzoid
grep -q '^BOT_TOKEN=.' .env || { echo "Сначала заполни BOT_TOKEN в /opt/monzoid/.env" >&2; exit 1; }
npm ci
npm run build
chown -R monzoid:monzoid /opt/monzoid
chmod 600 .env
cp deploy/monzoid.service deploy/monzoid-backup.service deploy/monzoid-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now monzoid-backup.timer
systemctl enable monzoid
systemctl restart monzoid
# Запуск на небольшом сервере занимает несколько секунд
curl -fsS -o /dev/null --retry 20 --retry-delay 1 --retry-all-errors -w 'Локальная проверка страницы: %{http_code}\n' http://127.0.0.1:3000/
systemctl is-active monzoid
REMOTE
