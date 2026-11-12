#!/usr/bin/env bash
# Первичная настройка сервера Debian/Ubuntu. Запуск от root: bash setup-server.sh monzoid.example.com [порт HTTPS]
# Другой порт нужен, если 443 уже занят. Порт 80 должен быть свободен: через него выпускается сертификат.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DOMAIN="${1:?Укажи домен: bash setup-server.sh monzoid.example.com}"
HTTPS_PORT="${2:-443}"
NODE_VERSION="v24.14.0"
APP_DIR="/opt/monzoid"

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) echo "Неподдерживаемая архитектура: $(uname -m)" >&2; exit 1 ;;
esac

. /etc/os-release
case "$ID" in
  debian|ubuntu) ;;
  *) echo "Скрипт рассчитан на Debian или Ubuntu, а здесь: $ID" >&2; exit 1 ;;
esac

apt-get update
apt-get install -y curl xz-utils gnupg debian-keyring debian-archive-keyring apt-transport-https

if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  file="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl -fsSLo "$tmp/$file" "https://nodejs.org/dist/$NODE_VERSION/$file"
  curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi

if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

id monzoid >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin monzoid
mkdir -p "$APP_DIR"
chown -R monzoid:monzoid "$APP_DIR"

if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<'EOF'
BOT_TOKEN=
BOT_USERNAME=
OWNER_TELEGRAM_IDS=
ANTHROPIC_API_KEY=
EOF
fi
chown monzoid:monzoid "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

cat > /etc/caddy/Caddyfile <<EOF
{
	https_port $HTTPS_PORT
}

$DOMAIN:$HTTPS_PORT {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "Готово. Заполни $APP_DIR/.env и запусти deploy/deploy.sh со своего компьютера."
