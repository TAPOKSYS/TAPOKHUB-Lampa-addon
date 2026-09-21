#!/usr/bin/env bash
# Сайт для GitHub Pages: общая сборка плагина (адрес сервера вводится в настройках) и страница с инструкцией.
# Запуск: scripts/build-site.sh [папка]   (по умолчанию dist/site). В CI выкладывается по тегу релиза (.github/workflows/release.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-dist/site}"
V=$(tr -d ' \n' < VERSION)

rm -rf "$OUT"
mkdir -p "$OUT"
python3 plugin/build.py --universal --out "$OUT/tapokhub.js" >/dev/null
node --check "$OUT/tapokhub.js"
grep -q "universal: true" "$OUT/tapokhub.js" || { echo "в общей сборке нет universal: true" >&2; exit 1; }
if grep -Eq "@@[A-Z_]+@@" "$OUT/tapokhub.js"; then echo "в общей сборке остались неподставленные метки" >&2; exit 1; fi
grep -q "proxyHost: ''" "$OUT/tapokhub.js" || { echo "в общей сборке не должно быть адреса сервера" >&2; exit 1; }
grep -q "version: '$V'" "$OUT/tapokhub.js" || { echo "версия $V не попала в общую сборку" >&2; exit 1; }
sed "s/@@VERSION@@/$V/g" scripts/site/index.html > "$OUT/index.html"
install -m 644 install.sh "$OUT/install.sh"     # установщик: https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh
echo "сайт: $OUT ($(du -h "$OUT/tapokhub.js" | cut -f1), версия $V)"
