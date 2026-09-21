"""Отдача плагина самим сервером (без nginx): /tapokhub.js, /tapokhub-assets/*, страница-подсказка на /.

Нужна Docker-контейнеру и установке без домена. Адрес сервера в плагин подставляется при отдаче: из TAPOK_PUBLIC_URL, а если он не
задан, из заголовка Host запроса (так плагин, открытый по http://192.168.1.5:8080/tapokhub.js, ходит на тот же адрес)."""

from __future__ import annotations

import html
import re
import threading
from pathlib import Path

from tapokhub import __version__
from tapokhub.core.i18n import lang, tr

# Что заменяется в собранном плагине: метка образа Docker и адрес по умолчанию публичной сборки релиза
PLACEHOLDER = "http://tapokhub.placeholder"
BAKED = ("https://a.pcsrf.ru",)

HOST_RE = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$")
PUBLIC_URL_RE = re.compile(r"^https?://" + HOST_RE.pattern[1:-1] + r"$")
COMMON_PLUGIN = "https://tapoksys.github.io/t.js"     # общий плагин на GitHub Pages: адрес сервера вводится в настройках
ASSET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml"}


class Web:
    def __init__(self, web_dir: Path, public_url: str = ""):
        if public_url and not PUBLIC_URL_RE.match(public_url):
            raise ValueError(tr("TAPOK_PUBLIC_URL «{public_url}» неверен (пример: http://192.168.1.5:8080 или https://tapok.example.com)", public_url=public_url))
        self.dir = Path(web_dir)
        self.public_url = public_url
        self._lock = threading.Lock()
        self._cache: tuple[float, str] | None = None

    def base_url(self, headers) -> str:
        """Адрес, по которому клиент обратился к серверу (или заданный TAPOK_PUBLIC_URL)."""
        if self.public_url:
            return self.public_url
        host = (headers.get("Host") or "").strip()
        if not HOST_RE.match(host):
            return ""
        proto = "https" if (headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower() == "https" else "http"
        return f"{proto}://{host}"

    def _source(self) -> str | None:
        f = self.dir / "tapokhub.js"
        try:
            m = f.stat().st_mtime
        except OSError:
            return None
        with self._lock:
            if not self._cache or self._cache[0] != m:
                self._cache = (m, f.read_text(encoding="utf-8"))
            return self._cache[1]

    def plugin(self, base: str) -> bytes | None:
        """tapokhub.js с адресом сервера base; None: плагина нет в папке или адрес неизвестен."""
        src = self._source()
        if src is None or not base:
            return None
        for old in (PLACEHOLDER,) + BAKED:
            src = src.replace(old, base)
        return src.encode("utf-8")

    def asset(self, name: str) -> tuple[bytes, str] | None:
        ext = Path(name).suffix.lower()
        if not ASSET_RE.match(name) or ext not in TYPES:
            return None
        f = self.dir / "tapokhub-assets" / name
        try:
            return f.read_bytes(), TYPES[ext]
        except OSError:
            return None

    def index(self, base: str) -> bytes:
        url = html.escape(f"{base}/tapokhub.js") if base else tr("(адрес сервера)/tapokhub.js")
        short = html.escape(f"{base}/t") if base else tr("(адрес сервера)/t")
        plain = base.startswith("http://")
        note = (tr("<p class=\"warn\">Адрес по http (без HTTPS): плагин подключится в приложении Lampa на телевизоре, телефоне или в браузере, открытом по http. Страница Lampa, открытая по https (например, lampa.mx), заблокирует загрузку по http.</p>")) if plain else ""
        readme = "README.md" if lang() == "ru" else "README.en.md"
        common = ""
        if base:
            common = (f"<p>{tr('Или общий плагин для любого сервера:')} <code>{html.escape(COMMON_PLUGIN)}</code><br>"
                      f"{tr('Затем в Настройки → TapokHub укажите адрес этого сервера:')} <code>{html.escape(base)}</code></p>")
        return f"""<!doctype html>
<html lang="{lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TapokHub</title>
<style>body{{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;background:#0f1216;color:#e8eaed}}
code{{background:#1c222a;padding:.15em .4em;border-radius:4px;word-break:break-all}}.warn{{color:#ffd24a}}a{{color:#8ab4f8}}</style></head>
<body><h1>TapokHub {html.escape(__version__)}</h1>
<p>{tr("Сервер работает. Адрес плагина для Lampa:")}</p>
<p><code>{url}</code></p>
<p>{tr("Короткий адрес, если набирать пультом:")} <code>{short}</code></p>
<ol><li>{tr("Lampa → Настройки → Расширения → Добавить плагин")}</li><li>{tr("Вставьте адрес выше и перезапустите Lampa")}</li>
<li>{tr("Настройки → TapokHub → Авторизация: вход через аккаунт CUB или по токену доступа")}</li></ol>
{note}
{common}
<p><a href="https://github.com/TAPOKSYS/TAPOKHUB-Lampa-addon/blob/main/{readme}">{tr("Описание проекта")}</a></p></body></html>""".encode("utf-8")
