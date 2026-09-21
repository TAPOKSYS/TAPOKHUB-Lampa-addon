"""Настройки сервиса: значения по умолчанию и чтение из переменных окружения (TAPOK_*, TMDB_*, WIKIDATA_API, LAMPA_APP_URL, WD_MIN_INTERVAL).

Отдельно для Docker и установки без nginx: TAPOK_WEB_DIR (папка с plugin: tapokhub.js и tapokhub-assets/; сервер сам отдаёт плагин),
TAPOK_PUBLIC_URL (адрес сервера для плагина; без него берётся из запроса), TAPOK_AUTO_TOKEN=1 (создать токен доступа при первом запуске),
TAPOK_ADMIN_EMAIL и TAPOK_REGISTRATION=open|closed (применяются один раз, на новой базе).
Демо-сервер: TAPOK_LIMIT_MOVIES, TAPOK_LIMIT_TV, TAPOK_LIMIT_FRANCHISES ограничивают библиотеку каждого пользователя, кроме владельца.
TAPOK_RATE_LIMIT=запросов в минуту на пользователя (по умолчанию 1200; 0 = без ограничения).
TAPOK_TRUSTED_PROXIES=адрес,адрес: прокси, кроме локального, которому верим в X-Real-IP (Caddy в compose с профилем https)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from tapokhub.core.common import DAY, HOUR
from tapokhub.core.i18n import default_lang

# с каких доменов CUB принимаем токен аккаунта Lampa (см. modules/users.py)
CUB_DOMAINS = ("cub.best", "cub.black", "cub.red", "cub.rip", "durex.monster", "cubnotrip.top", "bylampa.online")


@dataclass
class Config:
    data_dir: Path = Path("/var/lib/tapokhub")
    token: str = ""
    token_file: Path = Path("/etc/tapokhub/token")
    auto_token: bool = False        # нет токена: создать и сохранить в token_file (контейнер)
    web_dir: Path | None = None     # папка с готовым плагином: сервер отдаёт /tapokhub.js и картинки без nginx
    public_url: str = ""            # адрес сервера, который вшивается в плагин (http://1.2.3.4:8080); пусто = из заголовка Host запроса
    admin_email: str = ""
    registration: str = ""          # "open" | "closed" | "" (не менять)
    limit_movies: int = 0           # демо-сервер: фильмов в библиотеке одного пользователя (кроме владельца); 0 = без отдельного предела
    limit_tv: int = 0               # то же для сериалов
    limit_franchises: int = 0       # то же для коллекций франшиз
    rate_limit: int = 1200          # запросов в минуту на пользователя (картинки и API вместе); 0 = без ограничения
    heavy_limit: int = 30           # в минуту на пользователя для тяжёлых действий (рекомендации, создание коллекций)
    listen_host: str = "127.0.0.1"
    listen_port: int = 8890
    api_upstream: str = "https://api.themoviedb.org"
    img_upstream: str = "https://image.tmdb.org"
    lampa_app_url: str = "https://yumata.github.io/lampa/app.min.js"
    wikidata_api: str = "https://www.wikidata.org/w/api.php"
    telegram_api: str = "https://api.telegram.org"
    wd_min_interval: float = 3.0      # пауза между запросами к Wikidata
    wd_backoff: tuple = (30, 60, 120)  # ожидание при 429
    upstream_timeout: float = 15.0
    stale_max: int = 30 * DAY        # сколько отдавать устаревшую копию, если TMDB недоступен
    img_max_total: int = 5 * 1024**3  # предел кеша картинок; сверх него удаляются давно не запрашивавшиеся
    api_max_total: int = 512 * 1024**2  # предел кеша ответов TMDB (сумма тел ответов); сверх него удаляются давно не запрашивавшиеся
    max_download: int = 20 * 1024**2  # больше этого с апстрима не читаем
    warm_interval: int = 6 * HOUR
    warm_langs: tuple = (default_lang(),)   # язык описаний TMDB, пока клиенты его не сообщили (TAPOK_LANG, язык системы, иначе ru)
    warm_poster_sizes: tuple = ("w300",)
    warm_backdrop_sizes: tuple = ("w1280",)
    warm_logo_sizes: tuple = ("w500",)
    cub_domains: tuple = CUB_DOMAINS  # с каких доменов CUB принимаем токен аккаунта при входе
    trusted_proxies: tuple = ()       # адреса прокси помимо локального, чьему X-Real-IP верим (TAPOK_TRUSTED_PROXIES: Caddy в compose)
    extra: dict = field(default_factory=dict)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "tapokhub.sqlite3"

    @property
    def img_dir(self) -> Path:
        return self.data_dir / "img"


def env_int(name: str) -> int:
    """Целое из переменной окружения; пусто, не число или отрицательное: 0 (предел не задан)."""
    try:
        return max(0, int(os.environ.get(name, "").strip() or 0))
    except ValueError:
        return 0


def load_config() -> Config:
    data_dir = Path(os.environ.get("TAPOK_DATA", "/var/lib/tapokhub"))
    token_file = Path(os.environ.get("TAPOK_TOKEN_FILE", "/etc/tapokhub/token"))
    token = os.environ.get("TAPOK_TOKEN") or (token_file.read_text().strip() if token_file.exists() else "")
    host, _, port = os.environ.get("TAPOK_LISTEN", "127.0.0.1:8890").partition(":")
    web_dir = os.environ.get("TAPOK_WEB_DIR")
    registration = os.environ.get("TAPOK_REGISTRATION", "").strip().lower()
    return Config(
        data_dir=data_dir, token=token, token_file=token_file, listen_host=host, listen_port=int(port or 8890),
        auto_token=os.environ.get("TAPOK_AUTO_TOKEN", "").strip().lower() in ("1", "true", "yes", "on"),
        web_dir=Path(web_dir) if web_dir else None,
        public_url=os.environ.get("TAPOK_PUBLIC_URL", "").strip().rstrip("/"),
        admin_email=os.environ.get("TAPOK_ADMIN_EMAIL", "").strip(),
        registration=registration if registration in ("open", "closed") else "",
        rate_limit=env_int("TAPOK_RATE_LIMIT") if os.environ.get("TAPOK_RATE_LIMIT", "").strip() else 1200,
        limit_movies=env_int("TAPOK_LIMIT_MOVIES"), limit_tv=env_int("TAPOK_LIMIT_TV"), limit_franchises=env_int("TAPOK_LIMIT_FRANCHISES"),
        api_upstream=os.environ.get("TMDB_API_UPSTREAM", "https://api.themoviedb.org"),
        img_upstream=os.environ.get("TMDB_IMG_UPSTREAM", "https://image.tmdb.org"),
        lampa_app_url=os.environ.get("LAMPA_APP_URL", "https://yumata.github.io/lampa/app.min.js"),
        wikidata_api=os.environ.get("WIKIDATA_API", "https://www.wikidata.org/w/api.php"),
        telegram_api=os.environ.get("TAPOK_TELEGRAM_API", "https://api.telegram.org"),
        wd_min_interval=float(os.environ.get("WD_MIN_INTERVAL", "3")),
        trusted_proxies=tuple(x.strip() for x in os.environ.get("TAPOK_TRUSTED_PROXIES", "").split(",") if x.strip()),
        cub_domains=tuple(x.strip() for x in os.environ["TAPOK_CUB_DOMAINS"].split(",") if x.strip()) if os.environ.get("TAPOK_CUB_DOMAINS") else CUB_DOMAINS,
    )
