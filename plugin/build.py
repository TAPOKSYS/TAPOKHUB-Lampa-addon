#!/usr/bin/env python3
"""Склеивает plugin/src/**/*.js в один плагин dist/tapokhub.js (единый IIFE с защитой от двойной загрузки).

Слои (порядок сборки — порядок в LAYERS):
  core       ядро: объект TH, жизненный цикл, доступ к серверу и TMDB, вход на устройстве, запуск
  libraries  библиотеки: самостоятельные помощники без знания о разделах плагина (фон, карточка, логотипы, геометрия помех)
  modules    модули: возможности плагина (коллекции, библиотека, главный экран, воспроизведение, рекомендации, синхронизация)
Внутри слоя файлы идут в порядке списка; запуск (core/init.js) всегда последний.
"""

from pathlib import Path
import argparse
import hashlib
import sys

PLUGIN = Path(__file__).resolve().parent
ROOT = PLUGIN.parent
SRC = PLUGIN / "src"

LAYERS = {
    "core": ["core.js", "i18n.js", "i18n-en.js", "proxy.js", "tmdb.js", "auth.js"],
    "libraries": ["icons.js", "clock.js", "fx.js", "background.js", "backdrop.js", "card.js", "toast.js", "logos.js", "clipboard.js"],
    "modules": ["collections.js", "status.js", "sync.js", "telegram.js", "registration.js", "play.js", "library/api.js", "recs.js", "library/screens.js",
                "ui/line.js", "home/sections.js", "home/css.js", "home/anim.js", "home/fx-settings.js", "home/fx-edit.js",
                "home/screen.js", "ui/autostart.js", "ui/embed.js"],
}
LAST = ["core/init.js"]


def manifest() -> list[str]:
    """Файлы в порядке сборки. Файл, которого нет в списке, или запись без файла — ошибка: слои не должны расходиться с диском."""
    order = [f"{layer}/{name}" for layer, names in LAYERS.items() for name in names] + LAST
    on_disk = sorted(str(p.relative_to(SRC)) for p in SRC.rglob("*.js"))
    missing = sorted(set(order) - set(on_disk))
    extra = sorted(set(on_disk) - set(order))
    if missing or extra:
        sys.exit(f"список сборки и plugin/src расходятся: нет файлов {missing}, не включены {extra}")
    return order


def version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def version_label(v: str) -> str:
    """0.9.0-pre -> «0.9 pre-release»; 1.2.3 -> «1.2.3»."""
    core, _, pre = v.partition("-")
    if pre:
        parts = core.split(".")
        short = ".".join(parts[:2]) if parts[2:] == ["0"] else core
        return f"{short} {'pre-release' if pre.startswith('pre') else pre}"
    return core

HEAD = """(function () {
    'use strict';

    // Защита от повторной загрузки плагина.
    if (window.tapokhub_ready) return;
    window.tapokhub_ready = true;

"""

TAIL = """
    if (!TH.supported()) {
        TH.log('Lampa 3.0.5 or newer is required / нужна Lampa версии 3.0.5 или новее (app_digital >= ' + TH.minimumLampa + '), the plugin did not start / плагин не запущен');
        window.tapokhub_ready = false;
        return;
    }

    window.TapokHub = TH;
    TH.ready(TH.init);
})();
"""


def proxy_base(args) -> str:
    """Личная сборка с вшитым адресом и токеном (https://хост/tmdb/<токен>). Публичная сборка токена не содержит."""
    return args.proxy_base.rstrip("/") if args.proxy_base else ""


def proxy_host(args) -> str:
    """Публичная сборка: только адрес сервера; токен устройство получает при входе (см. src/auth.js).
    Общая сборка (--universal) адреса не содержит: его вводит человек в настройках плагина."""
    return args.host.rstrip("/") if args.auto_proxy and not args.universal else ""


def assets_base(args) -> str:
    """Где лежат картинки из assets/ (публичный адрес). Пусто = без картинок."""
    if args.universal:
        return ""          # картинки берутся с сервера человека
    if args.assets_base:
        return args.assets_base.rstrip("/")
    return f"{args.host.rstrip('/')}/tapokhub-assets" if args.auto_proxy else ""


def assets_version() -> str:
    """Хеш файлов assets/: при замене картинки адрес меняется, и кеш браузера не мешает."""
    h = hashlib.md5()
    for f in sorted((PLUGIN / "assets").glob("*")):
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return h.hexdigest()[:8]


def main() -> int:
    ap = argparse.ArgumentParser(description="Сборка dist/tapokhub.js")
    ap.add_argument("--proxy-base", help="адрес кеширующего сервера вместе с токеном")
    ap.add_argument("--auto-proxy", action="store_true", help="публичная сборка: адрес сервера (--host) без токена, вход на устройстве")
    ap.add_argument("--host", default="https://a.pcsrf.ru", help="публичный адрес сервера (с --auto-proxy)")
    ap.add_argument("--assets-base", help="адрес папки с картинками (по умолчанию <host>/tapokhub-assets с --auto-proxy)")
    ap.add_argument("--universal", action="store_true", help="общая сборка без адреса сервера: его вводят в настройках плагина (для публикации на GitHub Pages)")
    ap.add_argument("--out", default="dist/tapokhub.js")
    args = ap.parse_args()
    base = proxy_base(args)

    parts = []
    for name in manifest():
        text = (SRC / name).read_text(encoding="utf-8").rstrip() + "\n"
        parts.append("    // ==== " + name + " ====\n" + "\n".join(("    " + l) if l else l for l in text.splitlines()) + "\n")

    out = ROOT / args.out
    out.parent.mkdir(exist_ok=True)
    text = HEAD + "\n".join(parts) + TAIL
    text = text.replace("@@VERSION@@", version()).replace("@@VERSION_LABEL@@", version_label(version()))
    text = text.replace("@@UNIVERSAL@@", "true" if args.universal else "false")
    text = text.replace("@@PROXY_BASE@@", base)
    text = text.replace("@@PROXY_HOST@@", proxy_host(args))
    a_base = assets_base(args)
    text = text.replace("@@ASSETS_BASE@@", a_base)
    text = text.replace("@@ASSETS_VERSION@@", assets_version() if a_base else "")
    out.write_text(text, encoding="utf-8")
    print("built", out, out.stat().st_size, "bytes", "| версия:", version(), "| прокси:", "личный (токен вшит)" if base else ("общая: адрес сервера вводится в настройках" if args.universal else "сервер " + proxy_host(args) + ", вход на устройстве" if proxy_host(args) else "выключен"), "| картинки:", a_base or "нет")
    return 0


if __name__ == "__main__":
    sys.exit(main())
