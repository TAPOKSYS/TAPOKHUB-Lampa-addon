"""Пользователи и устройства.

Пользователь: своя библиотека (коллекции, отдельные фильмы и сериалы, события). Устройство: токен доступа, привязанный
к пользователю. Токен вводится на устройстве один раз и действует только там, где введён; отозвать можно по одному.

Как устройство получает токен:
- вручную: администратор выдаёт токен командой `users token`, его вводят в настройках плагина;
- через аккаунт CUB (cub.best и зеркала, bylampa): плагин отправляет серверу токен аккаунта Lampa, сервер спрашивает у
  CUB, чей он, и, если электронная почта есть в списке разрешённых (`users add`), выдаёт токен устройства. Токен
  аккаунта сервер нигде не сохраняет и в журнал не пишет.

В базе лежат только хеши токенов.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from tapokhub.core.config import CUB_DOMAINS  # noqa: F401 (список доменов задаёт core/config, здесь его используют и тесты)
from tapokhub.core.i18n import tr

log = logging.getLogger("tapokhub.users")

OWNER = 1                         # владелец: сюда попали все данные, накопленные до появления пользователей
MAX_DEVICES = 20                  # на пользователя: самое старое устройство вытесняется
CACHE_TTL = 60                    # проверка токена не чаще раза в минуту (отзыв доходит за минуту)
LOGIN_WINDOW = 600                # окно ограничения попыток входа, с
LOGIN_MAX = 12                    # попыток входа с одного адреса за окно


SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices(
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    label TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
"""


class LoginError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Users:
    def __init__(self, store, master_token: str = "", cub_domains: tuple = CUB_DOMAINS, timeout: float = 10.0, now=time.time,
                 cub_url: str = "{scheme}://{domain}/api/users/get"):
        self.store = store
        self.master = master_token.encode() if master_token else b""
        self.cub_domains = tuple(cub_domains)
        self.timeout = timeout
        self.now = now
        self.cub_url = cub_url
        self.lock = threading.Lock()
        self.cache: dict[str, tuple[float, int | None]] = {}
        self.attempts: dict[str, list[float]] = {}
        c = store.conn()
        c.executescript(SCHEMA)
        if not c.execute("SELECT 1 FROM users WHERE id=?", (OWNER,)).fetchone():
            c.execute("INSERT INTO users(id,name,created_at) VALUES(?,?,?)", (OWNER, tr("владелец"), int(now())))

    # ------------------------------------------------------------------ проверка токена

    def authenticate(self, token: str) -> int | None:
        """Токен из адреса запроса -> id пользователя или None. Главный токен из настроек сервера = владелец."""
        if not token:
            return None
        if self.master and hmac.compare_digest(token.encode(), self.master):
            return OWNER
        h = digest(token)
        t = self.now()
        hit = self.cache.get(h)
        if hit and t - hit[0] < CACHE_TTL:
            return hit[1]
        row = self.store.conn().execute(
            "SELECT d.id did, u.id uid FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND u.disabled=0", (h,)).fetchone()
        uid = row["uid"] if row else None
        if len(self.cache) > 2000:
            self.cache.clear()
        self.cache[h] = (t, uid)
        if row:
            self.store.conn().execute("UPDATE devices SET last_seen=? WHERE id=? AND COALESCE(last_seen,0) < ?", (int(t), row["did"], int(t) - 3600))
        return uid

    def forget_cache(self) -> None:
        self.cache.clear()

    def user(self, uid: int):
        return self.store.conn().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

    def whoami(self, uid: int) -> dict:
        u = self.user(uid)
        return {"id": uid, "name": u["name"] if u else None, "email": u["email"] if u else None}

    # ------------------------------------------------------------------ управление (CLI)

    @staticmethod
    def norm_email(email: str) -> str:
        return (email or "").strip().lower()

    def add_user(self, email: str | None = None, name: str | None = None) -> int:
        email = self.norm_email(email) if email else None
        c = self.store.conn()
        if email:
            row = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
            if row:
                c.execute("UPDATE users SET disabled=0 WHERE id=?", (row["id"],))
                return row["id"]
        cur = c.execute("INSERT INTO users(name,email,created_at) VALUES(?,?,?)", (name or email or tr("пользователь"), email, int(self.now())))
        return cur.lastrowid

    def set_email(self, uid: int, email: str | None) -> None:
        self.store.conn().execute("UPDATE users SET email=? WHERE id=?", (self.norm_email(email) if email else None, uid))

    def set_disabled(self, uid: int, disabled: bool) -> None:
        self.store.conn().execute("UPDATE users SET disabled=? WHERE id=?", (1 if disabled else 0, uid))
        self.forget_cache()

    def find(self, ref: str):
        """Пользователь по номеру или почте."""
        c = self.store.conn()
        if str(ref).isdigit():
            return c.execute("SELECT * FROM users WHERE id=?", (int(ref),)).fetchone()
        return c.execute("SELECT * FROM users WHERE email=?", (self.norm_email(ref),)).fetchone()

    def issue_token(self, uid: int, label: str = "", source: str = "manual") -> str:
        c = self.store.conn()
        token = secrets.token_urlsafe(24)
        c.execute("INSERT INTO devices(user_id,token_hash,label,source,created_at) VALUES(?,?,?,?,?)",
                  (uid, digest(token), (label or "")[:60], source, int(self.now())))
        old = c.execute("SELECT id FROM devices WHERE user_id=? ORDER BY id DESC LIMIT -1 OFFSET ?", (uid, MAX_DEVICES)).fetchall()
        if old:
            c.executemany("DELETE FROM devices WHERE id=?", [(r["id"],) for r in old])
            self.forget_cache()
        return token

    def revoke(self, device_id: int) -> bool:
        cur = self.store.conn().execute("DELETE FROM devices WHERE id=?", (device_id,))
        self.forget_cache()
        return cur.rowcount > 0

    def list_users(self) -> list[dict]:
        out = []
        for u in self.store.conn().execute("SELECT * FROM users ORDER BY id"):
            devs = self.store.conn().execute("SELECT id,label,source,created_at,last_seen FROM devices WHERE user_id=? ORDER BY id", (u["id"],)).fetchall()
            out.append({"id": u["id"], "name": u["name"], "email": u["email"], "disabled": bool(u["disabled"]), "devices": [dict(d) for d in devs]})
        return out

    # ------------------------------------------------------------------ вход через аккаунт CUB

    def _throttle(self, who: str) -> float:
        """Записать попытку входа с адреса who; -> её время (для _refund)."""
        t = self.now()
        with self.lock:
            hits = [x for x in self.attempts.get(who, []) if t - x < LOGIN_WINDOW]
            if len(hits) >= LOGIN_MAX:
                self.attempts[who] = hits
                raise LoginError(429, tr("слишком много попыток, подождите"))
            hits.append(t)
            self.attempts[who] = hits
            if len(self.attempts) > 5000:
                self.attempts.clear()
        return t

    def _refund(self, who: str, t: float) -> None:
        """Удачный вход уже известного пользователя лимит не расходует: иначе общий адрес (демо за прокси) блокировали бы своими же входами."""
        with self.lock:
            if t in self.attempts.get(who, ()):
                self.attempts[who].remove(t)

    # ---- зеркала CUB, добавленные администратором (домены меняются, список в коде устаревает)

    def extra_domains(self) -> list[str]:
        try:
            v = json.loads(self.store.meta_get("cub_domains_extra") or "[]")
        except ValueError:
            v = []
        return [d for d in v if isinstance(d, str)]

    def add_domain(self, domain: str, http: bool = False) -> str:
        """http=True: зеркало работает только по обычному http (порт 443 закрыт), как в приложении Lampa с protocol=http."""
        d = (domain or "").strip().lower()
        if not d or "/" in d or ":" in d or " " in d or "." not in d:
            raise ValueError(tr("нужно имя домена, например cub.example"))
        entry = ("http://" + d) if http else d
        extra = self.extra_domains()
        if entry not in extra and (http or d not in self.cub_domains):
            extra.append(entry)
            self.store.meta_set("cub_domains_extra", json.dumps(extra))
        return d

    def remove_domain(self, domain: str) -> bool:
        d = (domain or "").strip().lower()
        extra = self.extra_domains()
        gone = [e for e in extra if e in (d, "http://" + d)]
        if not gone:
            return False
        self.store.meta_set("cub_domains_extra", json.dumps([e for e in extra if e not in gone]))
        return True

    def schemes(self, domain: str) -> list[str]:
        """По каким протоколам ходить на домен: сначала https; http только если администратор явно разрешил."""
        extra = self.extra_domains()
        out = []
        if domain in self.cub_domains or domain in extra:
            out.append("https")
        if "http://" + domain in extra:
            out.append("http")
        return out

    def cub_profile(self, domain: str, token: str, profile) -> dict:
        """Спросить у CUB, чей это токен. -> {"email", "id"}. Домен только из списка, только https."""
        domain = (domain or "").strip().lower()
        schemes = self.schemes(domain)
        if not schemes:
            # СЕРВЕР ДОВЕРЯЕТ ответу этого домена о том, чья это почта, поэтому произвольные домены нельзя:
            # подставной «CUB» назвал бы любую почту из списка разрешённых. Новое зеркало добавляет администратор.
            raise LoginError(400, tr("неизвестный домен CUB: {v1}", v1=domain[:60]))
        if not token or len(str(token)) > 4096:
            raise LoginError(400, tr("нет токена аккаунта"))
        data = None
        for i, scheme in enumerate(schemes):
            req = urllib.request.Request(
                self.cub_url.format(scheme=scheme, domain=domain), headers={"token": str(token), "profile": str(profile or ""), "User-Agent": "TapokHub/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    data = json.loads(r.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                # CUB на неверный токен отвечает не 401, а 500 с телом {"error":true,"code":700,"text":"Вход не выполнен"}
                try:
                    body = json.loads(e.read().decode("utf-8"))
                except (ValueError, OSError):
                    body = {}
                denied = e.code in (401, 403) or (isinstance(body, dict) and body.get("code") == 700)
                text = body.get("text") if isinstance(body, dict) else None
                # Коды 5xx наружу не отдаём: Cloudflare подменяет их страницей без CORS-заголовков, и Lampa видит только «network»
                if denied:
                    raise LoginError(403, tr("CUB не признал токен аккаунта") + (f" ({text})" if text else tr(" (ответ {code})", code=e.code))) from None
                raise LoginError(424, tr("CUB не подтвердил аккаунт (ответ {code})", code=e.code)) from None
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                if i == len(schemes) - 1:
                    raise LoginError(424, tr("CUB недоступен с сервера")) from None
        user = (data or {}).get("user") or {}
        email = self.norm_email(user.get("email") or "")
        if not email:
            raise LoginError(403, tr("CUB не подтвердил аккаунт"))
        return {"email": email, "id": user.get("id")}

    def registration_open(self) -> bool:
        return self.store.meta_get("registration") == "open"       # без явного решения регистрация закрыта

    def set_registration(self, open_: bool) -> None:
        self.store.meta_set("registration", "open" if open_ else "closed")

    def registration_api(self, method: str, data: dict, uid: int) -> tuple[int, dict]:
        """GET /lib/registration -> {admin, open}; POST {open: true|false} -> то же. Менять и видеть текущее значение может
        только владелец (пользователь 1): остальным сервер отвечает лишь «admin: false»."""
        if uid != OWNER:
            if method == "GET":
                return 200, {"admin": False}
            return 403, {"error": tr("регистрацию меняет только владелец сервера")}
        if method == "POST":
            if not isinstance(data.get("open"), bool):
                return 400, {"error": tr("open: true или false")}
            self.set_registration(data["open"])
            log.info(tr("регистрация %s (из настроек плагина)"), tr("открыта") if data["open"] else tr("закрыта"))
        elif method != "GET":
            return 405, {"error": "GET or POST"}
        return 200, {"admin": True, "open": self.registration_open()}

    def login_cub(self, who: str, domain: str, token: str, profile, device: str = "") -> dict:
        """Обмен токена аккаунта CUB на токен устройства. Почта подтверждена самим CUB. Новая почта = новый пользователь
        (регистрация открыта; администратор может закрыть её командой `users registration closed`)."""
        attempt = self._throttle(who)
        info = self.cub_profile(domain, token, profile)
        u = self.store.conn().execute("SELECT * FROM users WHERE email=?", (info["email"],)).fetchone()
        if u and u["disabled"]:
            log.info(tr("вход через CUB отклонён: пользователь %s отключён"), u["id"])
            raise LoginError(403, tr("доступ для этой почты закрыт администратором"))
        if not u:
            if not self.registration_open():
                log.info(tr("вход через CUB отклонён: регистрация закрыта (%s)"), info["email"])
                raise LoginError(403, tr("регистрация на сервере закрыта"))
            name = info["email"].split("@")[0]
            uid = self.add_user(info["email"], name)
            u = self.user(uid)
            log.info(tr("зарегистрирован пользователь %s: %s"), uid, info["email"])
        else:
            self._refund(who, attempt)
        label = (device or tr("устройство")) + f" ({domain})"
        return {"token": self.issue_token(u["id"], label, "cub"), "user": {"id": u["id"], "name": u["name"], "email": u["email"]}}

    def merge(self, src: int, dst: int) -> None:
        """Слить пользователя src в dst: устройства и все данные переходят к dst, почта dst становится почтой src
        (чтобы вход через CUB вёл к dst). Нужно, если при первом входе зарегистрировался новый пользователь, а данные
        лежат у прежнего (например, у владельца)."""
        if src == dst or not self.user(src) or not self.user(dst):
            raise ValueError(tr("нужны два разных существующих пользователя"))
        c = self.store.conn()
        email = self.user(src)["email"]
        c.execute("BEGIN IMMEDIATE")
        try:
            c.execute("UPDATE devices SET user_id=? WHERE user_id=?", (dst, src))
            c.execute("UPDATE franchises SET user_id=? WHERE user_id=?", (dst, src))
            c.execute("UPDATE OR IGNORE library_items SET user_id=? WHERE user_id=?", (dst, src))
            c.execute("DELETE FROM library_items WHERE user_id=?", (src,))
            # При конфликте сохраняем более позднюю запись; при равном времени — запись dst.
            for table, columns, key in (
                ("torrent_choices", "kind,tmdb_id,title,magnet,link,poster,tracker,at", "kind,tmdb_id"),
                ("user_settings", "key,value,at", "key"),
            ):
                fields = columns.split(",")
                updates = ",".join(f"{x}=excluded.{x}" for x in fields if x not in key.split(","))
                c.execute(f"INSERT INTO {table}(user_id,{columns}) SELECT ?,{columns} FROM {table} WHERE user_id=? "
                          f"ON CONFLICT(user_id,{key}) DO UPDATE SET {updates} WHERE excluded.at>{table}.at", (dst, src))
                c.execute(f"DELETE FROM {table} WHERE user_id=?", (src,))
            c.execute("DELETE FROM users WHERE id=?", (src,))
            if email:
                c.execute("UPDATE users SET email=? WHERE id=?", (email, dst))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        self.forget_cache()
