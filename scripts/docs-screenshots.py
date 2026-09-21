#!/usr/bin/env python3
"""Снимки экранов для руководства (docs/GUIDE.md): настоящая Lampa в headless Chromium и тестовый экземпляр TapokHub.

Снимать лучше с отдельного тестового экземпляра с демо-данными, а не с боевого: на снимках не должно быть чужой почты,
токенов и личной библиотеки.

  docker run -d --name tapokhub-shots -p 127.0.0.1:8081:8080 -v tapokhub-shots-data:/data \\
      -e TAPOK_PUBLIC_URL=http://127.0.0.1:8081 ghcr.io/tapoksys/tapokhub-lampa-addon:latest
  # наполнить: несколько фильмов (POST /tmdb/<токен>/lib/items/add) и коллекций (POST .../lib/franchises)
  SHOTS_URL=http://127.0.0.1:8081 SHOTS_TOKEN=$(docker exec tapokhub-shots cat /data/token) python3 scripts/docs-screenshots.py

Папка снимков: TAPOK_SHOTS (по умолчанию docs/images). Нужны chromium, chromedriver и selenium.
"""

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("TAPOK_SHOTS", str(ROOT / "docs" / "images"))
sys.path.insert(0, str(ROOT / "plugin" / "tests" / "e2e"))
import browser as b  # noqa: E402

URL = os.environ.get("SHOTS_URL", "http://127.0.0.1:8081").rstrip("/")
TOKEN = os.environ.get("SHOTS_TOKEN", "")
if not TOKEN:
    sys.exit("нужен SHOTS_TOKEN (токен тестового экземпляра)")

# Страница Lampa открыта по https, а сервер на loopback: Chromium по умолчанию блокирует такие запросы
FLAGS = ("--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,"
         "PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,"
         "LocalNetworkAccessChecksWebTransport",)


def js(d, code, *args):
    return d.execute_script(code, *args)


def settle(seconds=2.5):
    time.sleep(seconds)


def settings(d, page, name):
    # панель настроек открывается контроллером «settings», затем в неё выводится страница нужного раздела;
    # окно выше обычного, чтобы в панель поместилось больше строк
    d.set_window_size(1280, 1000)
    js(d, "Lampa.Controller.toggle('settings'); Lampa.Settings.create(arguments[0])", page)
    settle(2)
    b.shot(d, name)


def close_settings(d):
    js(d, "$('body').toggleClass('settings--open', false); Lampa.Controller.toggle('content')")
    d.set_window_size(1280, 720)
    settle(1)


def compress():
    """PNG -> JPEG: снимки идут в репозиторий, их вес важен."""
    try:
        from PIL import Image
    except ImportError:
        print("PIL нет: снимки оставлены в PNG")
        return
    for png in sorted(Path(os.environ["TAPOK_SHOTS"]).glob("*.png")):
        Image.open(png).convert("RGB").save(png.with_suffix(".jpg"), quality=86, optimize=True)
        png.unlink()


def push(d, component_key, title, extra=""):
    js(d, "Lampa.Activity.push(Object.assign({url:'', title: arguments[1], component: TapokHub.components[arguments[0]], page: 1}, arguments[2] || {}))",
       component_key, title, {} if not extra else extra)
    settle(4)


def main():
    d = b.make_driver(1280, 720, extra_args=FLAGS)
    try:
        b.boot(d, f"{URL}/tapokhub.js")
        settle(3)
        print("TapokHub", js(d, "return window.TapokHub && window.TapokHub.version"))

        # настройки снимаем поверх хаба: фон главной страницы Lampa зависит от ленты TMDB и может оказаться любым
        js(d, "TapokHub.openHome()")
        settle(5)

        # до входа: как выглядят настройки на новом устройстве
        settings(d, "tapokhub", "settings-main")
        settings(d, "tapokhub_auth", "settings-auth-empty")

        # вход по токену доступа
        js(d, "window.TapokHub.auth.setToken(arguments[0], function(){})", TOKEN)
        settle(3)
        settings(d, "tapokhub_auth", "settings-auth-done")
        settings(d, "tapokhub_tg", "settings-telegram")
        settings(d, "tapokhub_play", "settings-play")
        settings(d, "tapokhub_anim", "settings-anim")
        settings(d, "tapokhub_fx", "settings-fx")
        close_settings(d)
        settle(3)
        b.shot(d, "hub-home")

        push(d, "library", "Библиотека")
        b.shot(d, "library")
        push(d, "collections", "Коллекции")
        b.shot(d, "collections")
        fid = js(d, "return (window.__fid || 1)")
        push(d, "franchise", "Коллекция", {"franchise_id": fid})
        b.shot(d, "franchise")

        # карточка фильма с кнопками TapokHub («В библиотеку», «Создать коллекцию», «Торренты»)
        js(d, "Lampa.Activity.push({url:'', component:'full', id: 603, method:'movie', card:{id:603, title:'Матрица'}, source:'tmdb'})")
        settle(6)
        b.shot(d, "card")

        # автозапуск: включить и перезагрузить Lampa, снимок на середине отсчёта
        js(d, "Lampa.Storage.set('tapokhub_autostart', true)")
        b.boot(d, f"{URL}/tapokhub.js", storage={"tapokhub_autostart": "true", "tapokhub_token": TOKEN})
        settle(0.5)
        b.shot(d, "autostart-countdown")
        for line in b.console(d):
            print(line)
    finally:
        d.quit()

    # телефон
    m = b.make_driver(mobile=True, extra_args=FLAGS)
    try:
        b.boot(m, f"{URL}/tapokhub.js", storage={"tapokhub_token": TOKEN})
        settle(3)
        js(m, "TapokHub.openHome()")
        settle(6)
        b.shot(m, "hub-phone")
    finally:
        m.quit()


if __name__ == "__main__":
    main()
    compress()
