#!/usr/bin/env python3
"""Запуск настоящей Lampa в headless Chromium с нашим плагином.

Не заменяет проверку на устройстве (FPS в headless ничего не говорит о ТВ),
но показывает то, чего не видит заглушка: реальную вёрстку, ошибки консоли,
поведение нативных модулей.

  python3 plugin/tests/e2e/browser.py [plugin_url]

Папка снимков: переменная окружения TAPOK_SHOTS (по умолчанию /tmp/tapokhub-shots).
"""

import json
import os
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

LAMPA = "https://yumata.github.io/lampa/"
PLUGIN = os.environ.get("TAPOK_PLUGIN", "https://a.pcsrf.ru/tapokhub.js?v=browser")
OUT = Path(os.environ.get("TAPOK_SHOTS", "/tmp/tapokhub-shots"))
OUT.mkdir(parents=True, exist_ok=True)


PHONE_UA = ("Mozilla/5.0 (Linux; Android 16; CPH2653 Build/BP2A.250605.015; wv) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Version/4.0 Chrome/151.0.7922.137 Mobile Safari/537.36 lampa_client")


def make_driver(width=1280, height=720, mobile=False, block_hosts=None, resolve_hosts=None, extra_args=()):
    """mobile=True: как телефон пользователя (по логу nginx: Android 16, WebView, lampa_client).

    block_hosts: имена хостов (можно с *), которые браузер не сможет разрешить, как заблокированный TMDB.
    Блокировка именно по хосту: сетевая блокировка CDP (Network.setBlockedURLs) срабатывает по вхождению
    подстроки и режет заодно и адрес прокси, в пути которого есть «https://api.themoviedb.org/».
    """
    opts = Options()
    opts.binary_location = "/usr/bin/chromium"
    for a in ("--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
              f"--window-size={width},{height}", "--lang=ru-RU", "--hide-scrollbars"):
        opts.add_argument(a)
    for a in extra_args:
        opts.add_argument(a)
    if block_hosts:
        opts.add_argument("--host-resolver-rules=" + ", ".join(f"MAP {h} ~NOTFOUND" for h in block_hosts))
    if mobile:
        opts.add_experimental_option("mobileEmulation", {
            "deviceMetrics": {"width": 412, "height": 915, "pixelRatio": 2.625, "touch": True, "mobile": True},
            "userAgent": PHONE_UA})
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    return webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=opts)


def boot(driver, plugin=PLUGIN, storage=None):
    """Открыть Lampa, прописать плагин и настройки, перезагрузить до готовности.

    storage: дополнительные ключи localStorage Lampa (например, прокси TMDB).
    """
    driver.get(LAMPA)
    driver.execute_script(
        """
        localStorage.setItem('plugins', JSON.stringify([{url: arguments[0], status: 1, name: 'TapokHub'}]));
        localStorage.setItem('language', 'ru');
        localStorage.setItem('tmdb_lang', 'ru');
        localStorage.setItem('platform', 'browser');
        localStorage.setItem('animation', 'true');
        localStorage.setItem('advanced_animation', 'true');
        localStorage.setItem('start_page', 'main');
        var extra = arguments[1] || {};
        Object.keys(extra).forEach(function (k) { localStorage.setItem(k, extra[k]); });
        """,
        plugin,
        storage or {},
    )
    driver.get(LAMPA)
    for _ in range(90):
        if driver.execute_script("return !!window.appready"):
            break
        time.sleep(1)
    else:
        raise SystemExit("Lampa не стала готова за 90 с")
    time.sleep(3)


def shot(driver, name):
    path = OUT / f"{name}.png"
    driver.save_screenshot(str(path))
    print("screenshot:", path)
    return path


def console(driver, only_problems=True):
    rows = driver.get_log("browser")
    out = []
    for r in rows:
        if only_problems and r["level"] not in ("SEVERE", "WARNING") and "TapokHub" not in r["message"]:
            continue
        out.append(f'[{r["level"]}] {r["message"][:300]}')
    return out


if __name__ == "__main__":
    d = make_driver()
    try:
        boot(d, sys.argv[1] if len(sys.argv) > 1 else PLUGIN)
        print("TapokHub:", d.execute_script("return window.TapokHub ? window.TapokHub.version : null"))
        shot(d, "01-home")
        for line in console(d):
            print(line)
    finally:
        d.quit()
