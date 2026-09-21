#!/usr/bin/env bash
# Все тесты: плагин (заглушка Lampa) и сервер. Код возврата не ноль, если что-то упало.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

step() { printf '\033[1m==> %s\033[0m\n' "$1"; }

step "плагин: сборка и синтаксис"
python3 plugin/build.py --out dist/tapokhub.test.js >/dev/null && node --check dist/tapokhub.test.js || fail=1

step "плагин: тесты"
out=$(node plugin/tests/run.js 2>&1); echo "$out" | grep -E "^FAIL" -A4; echo "$out" | tail -1
echo "$out" | tail -1 | grep -q "all passed" || fail=1

step "плагин: регрессии аудита"
node plugin/tests/audit.js || fail=1

step "плагин: языки интерфейса"
node plugin/tests/i18n.js || fail=1

step "плагин: общая сборка (адрес сервера в настройках)"
node plugin/tests/universal.js || fail=1

step "плагин: общая сборка для GitHub Pages"
scripts/build-site.sh dist/site.test >/dev/null || fail=1

for t in test_proxy test_library test_users test_audit test_web test_security test_telegram test_i18n; do
    step "сервер: $t"
    out=$(python3 "server/tests/$t.py" 2>&1); echo "$out" | grep -E "^(Ran|OK|FAILED|FAIL:|ERROR:)"
    echo "$out" | grep -q "^OK" || { echo "$out" | tail -30; fail=1; }
done

[ "$fail" = 0 ] && { echo; echo "ВСЕ ТЕСТЫ ПРОШЛИ"; } || { echo; echo "ЕСТЬ ОШИБКИ"; }
exit "$fail"
