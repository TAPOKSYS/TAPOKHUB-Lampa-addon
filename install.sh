#!/usr/bin/env bash
# TapokHub: установка и обновление сервера одной командой. Работает в Docker: если его нет, скрипт поставит.
#
#   curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash
#   curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --domain tapok.example.com --email you@example.com
#
# Параметры (все необязательные; сохраняются в /opt/tapokhub/.env, повторный запуск обновляет TapokHub до новой версии):
#   --domain  домен сервера: HTTPS с сертификатом Let's Encrypt (A-запись домена должна указывать на этот сервер, порты 80 и 443 свободны)
#   --email   ваша почта: вход администратора через аккаунт CUB
#   --port    порт без домена (по умолчанию 8080)
#   --version версия образа, например 0.10.0 (по умолчанию самая новая)
#   --dir     куда положить compose.yaml и настройки (по умолчанию /opt/tapokhub)
set -euo pipefail

REPO="TAPOKSYS/TAPOKHUB-Lampa-addon"
RAW="${TAPOK_RAW:-https://raw.githubusercontent.com/$REPO/main}"
BIN="${TAPOK_BIN:-/usr/local/bin/tapokhub}"
DIR="/opt/tapokhub"; DOMAIN=""; EMAIL=""; PORT=""; VERSION_TAG=""

# Язык сообщений: TAPOK_LANG, иначе LC_ALL / LC_MESSAGES / LANG (ru, uk, be: русский, остальные: английский); ничего не задано: русский.
LANG_OUT=ru
for v in "${TAPOK_LANG:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    x=$(printf '%s' "$v" | tr 'A-Z' 'a-z')
    case "$x" in "" | c | c.* | posix | posix.* | "*") continue ;; ru* | uk* | be*) break ;; *) LANG_OUT=en; break ;; esac
done
m()    { if [ "$LANG_OUT" = ru ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s: %s\033[0m\n' "$(m 'ОШИБКА' 'ERROR')" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="${2:-}"; shift ;;
        --email) EMAIL="${2:-}"; shift ;;
        --port) PORT="${2:-}"; shift ;;
        --version) VERSION_TAG="${2:-}"; shift ;;
        --dir) DIR="${2:-}"; shift ;;
        -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "$(m "неизвестный параметр: $1 (см. --help)" "unknown option: $1 (see --help)")" ;;
    esac
    shift
done

[ "$(id -u)" = 0 ] || die "$(m "нужен root: добавьте sudo перед bash" "root is required: put sudo before bash")"
[ -z "$DOMAIN" ] || echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' || die "$(m "домен «$DOMAIN» выглядит неверно (пример: tapok.example.com)" "the domain “$DOMAIN” looks wrong (example: tapok.example.com)")"
[ -z "$EMAIL" ] || echo "$EMAIL" | grep -Eq '^[^@ ]+@[^@ ]+\.[^@ ]+$' || die "$(m "почта «$EMAIL» выглядит неверно" "the email “$EMAIL” looks wrong")"
[ -z "$PORT" ] || echo "$PORT" | grep -Eq '^[0-9]{1,5}$' || die "$(m "порт «$PORT» неверен" "the port “$PORT” is invalid")"

# ---- Docker
command -v curl >/dev/null || die "$(m "нужен curl (apt-get install curl)" "curl is required (apt-get install curl)")"
if ! command -v docker >/dev/null; then
    say "$(m "Docker не найден, ставлю (официальный скрипт get.docker.com)" "Docker not found, installing it (the official get.docker.com script)")"
    curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "$(m "нужен плагин Docker Compose (docker compose): https://docs.docker.com/compose/install/" "the Docker Compose plugin (docker compose) is required: https://docs.docker.com/compose/install/")"

# ---- файлы и настройки
say "$(m "файлы в $DIR" "files in $DIR")"
mkdir -p "$DIR/deploy/caddy"
cd "$DIR"
curl -fsSL "$RAW/compose.yaml" -o compose.yaml
curl -fsSL "$RAW/deploy/caddy/Caddyfile" -o deploy/caddy/Caddyfile
touch .env
chmod 600 .env

# ключ=значение в .env: заменить или добавить
setenv() { grep -v "^$1=" .env > .env.tmp || true; printf '%s=%s\n' "$1" "$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
if [ -n "$DOMAIN" ]; then
    setenv TAPOK_DOMAIN "$DOMAIN"; setenv COMPOSE_PROFILES https; setenv TAPOK_PUBLIC_URL "https://$DOMAIN"; setenv TAPOK_BIND 127.0.0.1
fi
[ -z "$PORT" ] || setenv TAPOK_PORT "$PORT"
[ -z "$EMAIL" ] || setenv TAPOK_ADMIN_EMAIL "$EMAIL"
[ -z "$VERSION_TAG" ] || setenv TAPOK_VERSION "${VERSION_TAG#v}"

# ---- запуск
say "$(m "загрузка и запуск" "downloading and starting")"
docker compose pull -q || say "$(m "образ не скачался, использую тот, что уже есть" "the image was not pulled, using the one already here")"
docker compose up -d

port="$(sed -n 's/^TAPOK_PORT=//p' .env | tail -n1)"; port="${port:-8080}"
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 || die "$(m "сервер не ответил. Журнал: cd $DIR && docker compose logs" "the server did not answer. Log: cd $DIR && docker compose logs")"

# команда администратора: tapokhub users list, tapokhub users add почта ...
printf '#!/bin/sh\nexec docker exec $([ -t 0 ] && echo -it || echo -i) tapokhub python -m tapokhub "$@"\n' > "$BIN"
chmod 755 "$BIN"
[ -z "$EMAIL" ] || "$BIN" users email 1 "$EMAIL" >/dev/null

# ---- итог
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"
else
    ADDR=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1 || true)
    URL="http://${ADDR:-адрес-сервера}:$port"
fi
echo
say "$(m "TapokHub установлен" "TapokHub is installed")"
echo "  $(m "Плагин для Lampa:  " "Lampa plugin:      ")$URL/t   ($(m "то же: " "same as ")$URL/tapokhub.js)"
echo "  $(m "Lampa: Настройки → Расширения → Добавить плагин → вставьте адрес выше." "Lampa: Settings → Extensions → Add plugin → paste the address above.")"
echo "  $(m "Затем Настройки → TapokHub → Авторизация → «Войти через аккаунт CUB»${EMAIL:+ (почта $EMAIL)}." "Then Settings → TapokHub → Authorization → “Sign in with a CUB account”${EMAIL:+ (email $EMAIL)}.")"
echo "  $(m "Добавить пользователя:  " "Add a user:           ")tapokhub users add $(m "почта" "email")@example.com"
echo "  $(m "Открыть регистрацию для всех:  " "Open registration to everyone:  ")tapokhub users registration open"
case "$URL" in http://*) echo "  $(m "Без HTTPS плагин работает в приложении Lampa (телевизор, телефон); страница Lampa по https такой адрес заблокирует. HTTPS: запустите заново с --domain." "Without HTTPS the plugin works in the Lampa app (TV, phone); a Lampa page over https will block this address. For HTTPS run again with --domain.")" ;; esac
echo "  $(m "Подробнее: https://github.com/$REPO#readme" "More: https://github.com/$REPO/blob/main/README.en.md")"
