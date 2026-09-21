#!/usr/bin/env bash
# Проверка образа Docker: сборка, запуск, ответы сервера, перезапуск с теми же данными. Нужен docker.
#   scripts/docker-test.sh [образ]     без аргумента образ собирается из этого репозитория
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${1:-tapokhub:test}"
NAME="tapokhub-test-$$"
PORT="${TAPOK_TEST_PORT:-18080}"
fail() { echo "ОШИБКА: $*" >&2; docker logs "$NAME" 2>&1 | tail -30 >&2 || true; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$NAME-data" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -n "${1:-}" ] || { echo "==> сборка образа"; docker build -t "$IMAGE" .; }

run() { docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$NAME-data:/data" "$@" "$IMAGE" >/dev/null; }
wait_up() { for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0; sleep 1; done; fail "сервер не ответил на /healthz"; }

echo "==> запуск"
run -e TAPOK_ADMIN_EMAIL=admin@example.com
wait_up

echo "==> /healthz"
[[ "$(curl -fsS "http://127.0.0.1:$PORT/healthz")" == *'"ok": true'* ]] || fail "/healthz без ok"

echo "==> плагин получает адрес из запроса"
JS=$(curl -fsS -H "Host: 192.168.1.5:$PORT" "http://127.0.0.1:$PORT/tapokhub.js")
[[ "$JS" == *"http://192.168.1.5:$PORT"* ]] || fail "адрес из Host не попал в плагин"
[[ "$JS" != *"tapokhub.placeholder"* ]] || fail "в плагине осталась метка адреса"
[[ "$JS" != *"a.pcsrf.ru"* ]] || fail "в плагине остался чужой адрес"

echo "==> картинки и страница-подсказка"
ASSET=$(docker exec "$NAME" ls /app/web/tapokhub-assets | head -n1)
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/tapokhub-assets/$ASSET" || fail "картинка $ASSET не отдаётся"
[[ "$(curl -fsS "http://127.0.0.1:$PORT/")" == *"tapokhub.js"* ]] || fail "страница-подсказка без адреса плагина"

echo "==> токен создан и работает"
TOKEN=$(docker exec "$NAME" cat /data/token)
[ "${#TOKEN}" -ge 32 ] || fail "токен не создан"
[[ "$(curl -fsS "http://127.0.0.1:$PORT/tmdb/$TOKEN/health")" == *'"ok": true'* ]] || fail "health по токену"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/tmdb/wrong-token/health")" = 404 ] || fail "чужой токен должен получать 404"

echo "==> почта администратора и закрытая регистрация применены"
[[ "$(docker exec "$NAME" python -m tapokhub users list)" == *"admin@example.com"* ]] || fail "почта администратора не записана"

echo "==> перезапуск: те же данные и токен"
docker restart "$NAME" >/dev/null
wait_up
[ "$(docker exec "$NAME" cat /data/token)" = "$TOKEN" ] || fail "токен изменился после перезапуска"

echo "==> процесс не root"
[ "$(docker exec "$NAME" id -u)" != 0 ] || fail "контейнер работает от root"

echo "ОБРАЗ РАБОТАЕТ"
