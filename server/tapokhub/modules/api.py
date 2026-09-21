"""HTTP-слой: маршруты /tmdb/<токен>/{api,img,health,whoami,lib/...}, /tmdb/auth/cub и /healthz, встроенная раздача плагина (modules/web.py), CORS, сервер на потоках."""

from __future__ import annotations

import http.server
import json
import logging
import re
import socketserver
import sys
import threading
import urllib.parse
from typing import Any

from tapokhub.core.common import UpstreamError
from tapokhub import __version__
from tapokhub.core.config import Config
from tapokhub.core.net import RateLimiter
from tapokhub.modules.proxy import NAME_RE, Proxy
from tapokhub.modules.users import OWNER, LoginError
from tapokhub.modules.web import Web
from tapokhub.core.i18n import set_lang, tr

log = logging.getLogger("tapokhub")


API_HOST = "api.themoviedb.org"
IMG_HOST = "image.tmdb.org"

API_PATH_RE = re.compile(r"^[A-Za-z0-9/_\-.,]+$")
SIZE_RE = re.compile(r"^(w\d{2,4}|h\d{2,4}|original)$")
LIB_RE = re.compile(r"^/tmdb/(?P<token>[^/]+)/lib(?:/(?P<rest>[^?]*))?$")
MAX_BODY = 64 * 1024
AUTH_RE = re.compile(r"^/tmdb/auth/(?P<what>cub)$")
ROUTE_RE = re.compile(r"^/tmdb/(?P<token>[^/]+)/(?P<kind>api|img|health|whoami)(?:/(?:https?:/{1,2})?(?P<host>[^/?]+)/(?P<rest>[^?]*))?$")


# ---------------------------------------------------------------- HTTP

CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*"}

# Ответы сервера не страницы: ни скриптов, ни встраивания. Исключения (страница-подсказка, картинки) задают свой CSP.
SECURITY = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"}
PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
IMAGE_CSP = "default-src 'none'; sandbox"
TOKEN_IN_PATH = re.compile(r"(/tmdb/)(?!auth/)[^/\s\"?]+")      # токен доступа лежит в адресе: в журнал он не попадает
HEAVY = {"recommend", "franchises"}                              # тяжёлые POST: десятки запросов к TMDB или сборка коллекции
MAX_CONNECTIONS = 256
PLUGIN_PATHS = ("/tapokhub.js", "/t", "/t.js")                  # /t короткий: адрес плагина вводят пультом, каждая буква дорога


def make_handler(proxy: Proxy, web: Web | None = None):

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "TapokHubProxy/1.0"
        protocol_version = "HTTP/1.1"
        timeout = 180          # молчащее соединение закрывается (дольше, чем держит соединение Caddy: 2 минуты)

        def finish(self) -> None:
            try:
                super().finish()
            finally:
                proxy.store.close()

        def log_message(self, fmt: str, *args: Any) -> None:
            log.debug("%s - %s", self.address_string(), TOKEN_IN_PATH.sub(r"\1<token>", fmt % args))

        def send(self, status: int, body: bytes = b"", ctype: str = "application/json", headers: dict | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in {**CORS, **SECURITY, **(headers or {})}.items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send(204)

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

        def do_GET(self) -> None:  # noqa: N802
            self.dispatch(b"")

        def do_POST(self) -> None:  # noqa: N802
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self.close_connection = True      # тело не читаем, поэтому соединение дальше не годится
                return self.send(413, b'{"error":"body too large"}', headers={"Cache-Control": "no-store"})
            self.dispatch(self.rfile.read(length) if length else b"")

        def dispatch(self, body: bytes) -> None:
            set_lang(self.headers.get("Accept-Language"))      # язык сообщений: Accept-Language (плагин ставит язык Lampa)
            try:
                self.route(body)
            except UpstreamError as e:
                self.send(e.status if e.status >= 400 else 502, e.body or json.dumps({"error": str(e)}).encode(), e.ctype or "application/json", {"Cache-Control": "no-store"})
            except Exception:  # noqa: BLE001
                log.exception(tr("необработанная ошибка"))
                self.send(500, b'{"error":"internal"}', headers={"Cache-Control": "no-store"})

        def client_ip(self) -> str:
            # Доверенный proxy — локальный nginx (или адреса из TAPOK_TRUSTED_PROXIES, например Caddy в compose). Он перезаписывает X-Real-IP.
            # Произвольные CF-Connecting-IP/X-Forwarded-For от клиента не используются.
            if self.client_address[0] in ("127.0.0.1", "::1") or self.client_address[0] in proxy.cfg.trusted_proxies:
                return self.headers.get("X-Real-IP") or self.client_address[0]
            return self.client_address[0]

        def within_limits(self, uid: int, heavy: bool = False) -> bool:
            """Не превысил ли пользователь частоту запросов (общую и для тяжёлых действий)."""
            return proxy.limiter.allow(uid) and (not heavy or proxy.heavy_limiter.allow(uid))

        def too_many(self) -> None:
            self.send(429, json.dumps({"error": tr("слишком много запросов, подождите минуту")}, ensure_ascii=False).encode(),
                      headers={"Cache-Control": "no-store", "Retry-After": "60"})

        def auth(self, body: bytes) -> None:
            """POST /tmdb/auth/cub: обмен токена аккаунта CUB на токен устройства. Токен аккаунта нигде не сохраняем."""
            if self.command != "POST":
                return self.send(405, b'{"error":"POST only"}')
            try:
                data = json.loads(body.decode("utf-8")) if body else {}
                if not isinstance(data, dict):
                    raise ValueError
            except ValueError:
                return self.send(400, b'{"error":"bad json"}', headers={"Cache-Control": "no-store"})
            try:
                res = proxy.users.login_cub(self.client_ip(), str(data.get("domain") or ""), str(data.get("token") or ""),
                                            data.get("profile"), str(data.get("device") or ""))
            except LoginError as e:
                # токен аккаунта в журнал не попадает; домен не секрет и помогает понять отказ
                log.info(tr("вход через CUB отклонён (%s): %s; домен=%r"), e.status, e.message, str(data.get("domain") or "")[:60])
                return self.send(e.status, json.dumps({"error": e.message}, ensure_ascii=False).encode(), headers={"Cache-Control": "no-store"})
            return self.send(200, json.dumps(res, ensure_ascii=False).encode(), headers={"Cache-Control": "no-store"})

        def web_route(self, path: str) -> bool:
            """Плагин и страница-подсказка, если включена встроенная раздача (TAPOK_WEB_DIR). True: запрос обработан."""
            if web is None or self.command not in ("GET", "HEAD"):
                return False
            if path == "/":
                return self.send(200, web.index(web.base_url(self.headers)), "text/html; charset=utf-8",
                                 {"Cache-Control": "no-cache", "Content-Security-Policy": PAGE_CSP}) or True
            if path in PLUGIN_PATHS:
                js = web.plugin(web.base_url(self.headers))
                if js is None:
                    return self.send(404, b'{"error":"plugin not found"}') or True
                return self.send(200, js, "application/javascript; charset=utf-8", {"Cache-Control": "no-cache, no-store, must-revalidate"}) or True
            if path.startswith("/tapokhub-assets/"):
                found = web.asset(path[len("/tapokhub-assets/"):])
                if found is None:
                    return self.send(404, b'{"error":"not found"}') or True
                return self.send(200, found[0], found[1], {"Cache-Control": "public, max-age=3600", "Content-Security-Policy": IMAGE_CSP}) or True
            return False

        def route(self, body: bytes = b"") -> None:
            path, _, query = self.path.partition("?")

            if path == "/healthz":          # без токена и без данных: только «жив» и версия (проверка контейнера и балансировщика)
                return self.send(200, json.dumps({"ok": True, "version": __version__}).encode(), headers={"Cache-Control": "no-store"})
            if self.web_route(path):
                return

            am = AUTH_RE.match(path)
            if am:
                return self.auth(body)

            lm = LIB_RE.match(path)
            if lm:
                uid = proxy.users.authenticate(lm["token"])
                if uid is None:
                    return self.send(404, b'{"error":"not found"}')
                if not self.within_limits(uid, heavy=self.command == "POST" and (lm["rest"] or "").split("/")[0] in HEAVY):
                    return self.too_many()
                status, obj = proxy.library.handle("GET" if self.command == "HEAD" else self.command, lm["rest"] or "", query, body, uid)
                return self.send(status, json.dumps(obj, ensure_ascii=False).encode(), headers={"Cache-Control": "no-store"})

            m = ROUTE_RE.match(path)
            uid = proxy.users.authenticate(m["token"]) if m else None
            if not m or uid is None:
                return self.send(404, b'{"error":"not found"}')
            if not self.within_limits(uid):
                return self.too_many()

            if m["kind"] == "health":
                return self.send(200, json.dumps(proxy.health()).encode(), headers={"Cache-Control": "no-store"})
            if m["kind"] == "whoami":
                return self.send(200, json.dumps(proxy.users.whoami(uid), ensure_ascii=False).encode(), headers={"Cache-Control": "no-store"})

            host, rest = m["host"], m["rest"] or ""
            if m["kind"] == "api":
                if host != API_HOST or not rest.startswith("3/"):
                    return self.send(404, b'{"error":"not found"}')
                sub = rest[2:]
                if not API_PATH_RE.match(sub) or ".." in sub:
                    return self.send(400, b'{"error":"bad path"}')
                params = urllib.parse.parse_qsl(query, keep_blank_values=True)
                client_key = next((v for k, v in params if k == "api_key"), None)
                for k, v in params:
                    if k == "language":
                        proxy.store.seen("lang", v.split(",")[0])
                # ключ TMDB сервера запоминается только из запросов владельца: иначе любой вошедший пользователь подменил бы его своим
                st, body, ctype, state = proxy.get_api(sub, params, client_key, learn=(uid == OWNER))
                return self.send(st, body, ctype or "application/json", {"Cache-Control": "no-cache", "X-Tapok-Cache": state})

            # img
            if host != IMG_HOST:
                return self.send(404, b'{"error":"not found"}')
            im = re.match(r"^t/p/(?P<size>[^/]+)/(?P<name>[^/]+)$", rest)
            if not im or not SIZE_RE.match(im["size"]) or not NAME_RE.match(im["name"]):
                return self.send(400, b'{"error":"bad image path"}')
            proxy.store.seen("size", im["size"])
            file, ctype, state = proxy.get_image(im["size"], im["name"])
            st = file.stat()
            etag = f'"{im["size"]}-{im["name"]}-{int(st.st_mtime)}"'
            base = {"Cache-Control": "public, max-age=31536000, immutable", "ETag": etag, "X-Tapok-Cache": state, "Content-Security-Policy": IMAGE_CSP}
            if self.headers.get("If-None-Match") == etag:
                return self.send(304, b"", ctype, base)
            return self.send(200, file.read_bytes(), ctype, base)

    return Handler


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)      # соединений одновременно: остальным сразу 503, а не поток на каждое
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address) -> None:
        if not self.slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            return self.shutdown_request(request)
        super().process_request(request, client_address)

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):      # клиент оборвал связь или замолчал: не ошибка сервера
            log.debug("%s: %s", client_address[0], exc.__class__.__name__)
        else:
            log.exception(tr("необработанная ошибка"))

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def server_close(self) -> None:
        super().server_close()
        if hasattr(self, "proxy"):
            self.proxy.telegram.stop()
            self.proxy.library.stop()
            self.proxy.store.close()


def create_server(cfg: Config) -> tuple[Server, Proxy]:
    proxy = Proxy(cfg)
    web = Web(cfg.web_dir, cfg.public_url) if cfg.web_dir else None
    server = Server((cfg.listen_host, cfg.listen_port), make_handler(proxy, web))
    server.proxy = proxy
    return server, proxy
