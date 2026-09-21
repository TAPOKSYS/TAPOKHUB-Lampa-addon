"""Telegram-бот пользователя: поиск фильмов и сериалов, добавление в библиотеку, отслеживание коллекций.

Токен бота вводится в настройках плагина (Настройки -> TapokHub -> Telegram) и приходит на /lib/telegram. Номер чата вписывать
не обязательно: после токена достаточно написать боту /start, и личный чат привяжется сам. Чтобы этим не воспользовался
чужой, привязка открыта только 5 минут (после ввода токена или кнопки «Привязать чат»), только для личных чатов и только пока
окно не закрыто первым /start. Группу привязывают вписыванием номера.
Сервер сам опрашивает Telegram (getUpdates), отдельный процесс не нужен. Бот отвечает только в своём чате, кроме /id:
эта команда сообщает номер чата любому, чтобы его можно было узнать и вписать в настройки. Токен наружу не отдаётся:
ни в ответах API, ни в журнале (адрес запроса к Telegram его содержит, поэтому ошибки сети сводим к короткому тексту).
Все действия идут через Library.handle, то есть так же, как из плагина.
"""

from __future__ import annotations

import http.client
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from tapokhub.core.i18n import set_lang, tr

log = logging.getLogger("tapokhub")

TOKEN_RE = re.compile(r"^\d{5,15}:[A-Za-z0-9_-]{30,50}$")
CHAT_RE = re.compile(r"^-?\d{1,20}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS telegram(
    user_id INTEGER PRIMARY KEY, token TEXT, chat TEXT, username TEXT, updated_at INTEGER NOT NULL, pair_until INTEGER NOT NULL DEFAULT 0
);
"""

PAIR_WINDOW = 300          # секунд, в течение которых /start привязывает чат

def hello() -> str:
    return tr("✅ TapokHub подключён к этому чату.\n\nНапишите название фильма или сериала, чтобы найти и добавить в библиотеку.\n\nКоманды: /library /regen /id")


class TelegramError(Exception):
    def __init__(self, message: str, code: int = 0):
        super().__init__(message)
        self.message = message
        self.code = code


def call(api: str, token: str, method: str, payload: dict | None = None, timeout: float = 15.0):
    """Вызов метода Bot API -> result. Текст ошибки без адреса запроса (в нём токен)."""
    req = urllib.request.Request(f"{api}/bot{token}/{method}", data=json.dumps(payload or {}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "TapokHub/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(4 << 20)
    except urllib.error.HTTPError as e:            # Telegram отвечает JSON-ом и на 4xx
        raw = e.read(1 << 20)
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):    # обрыв посреди ответа тоже «нет связи»
        raise TelegramError(tr("нет связи с Telegram")) from None
    try:
        data = json.loads(raw)
    except ValueError:
        raise TelegramError(tr("Telegram ответил не так, как ожидалось")) from None
    if not isinstance(data, dict) or not data.get("ok"):
        d = data if isinstance(data, dict) else {}
        raise TelegramError(str(d.get("description") or tr("ошибка Telegram"))[:200], int(d.get("error_code") or 0))
    return data.get("result")


class Worker:
    """Опрос Telegram для одного пользователя. Чат можно менять на ходу, токен меняется новым потоком."""

    def __init__(self, bots: "Telegram", user: int, token: str, chat: str | None):
        self.bots, self.user, self.token, self.chat = bots, user, token, chat
        self.stop = threading.Event()
        self.error: str | None = None
        self.thread = threading.Thread(target=self.run, name=f"telegram-{user}", daemon=True)

    def run(self) -> None:
        bots, offset = self.bots, None
        wait = bots.RETRY
        try:
            while not self.stop.is_set():
                try:
                    payload = {"timeout": bots.POLL_TIMEOUT, "limit": 20, "allowed_updates": ["message", "callback_query"]}
                    if offset is not None:
                        payload["offset"] = offset
                    updates = call(bots.api, self.token, "getUpdates", payload, timeout=bots.POLL_TIMEOUT + 10) or []
                    self.error, wait = None, bots.RETRY
                except TelegramError as e:
                    self.error = e.message
                    if e.code == 401:                  # токен отозван: дальше опрашивать нечего
                        log.warning(tr("telegram (пользователь %s): токен не принят, бот остановлен"), self.user)
                        return
                    if e.code != 409:                  # 409: тот же бот ещё опрашивает старый поток, подождём
                        log.warning(tr("telegram (пользователь %s): %s"), self.user, e.message)
                    self.stop.wait(wait)
                    wait = min(wait * 2, 60)
                    continue
                except Exception as e:  # noqa: BLE001 — непредвиденное не должно молча останавливать бота; в журнал только тип (в тексте бывает адрес с токеном)
                    self.error = tr("внутренняя ошибка")
                    log.warning(tr("telegram (пользователь %s): %s"), self.user, type(e).__name__)
                    self.stop.wait(wait)
                    wait = min(wait * 2, 60)
                    continue
                for u in updates:
                    offset = int(u["update_id"]) + 1
                    try:
                        bots.dispatch(self, u)
                    except Exception:  # noqa: BLE001 — один плохой апдейт не должен останавливать бота
                        log.exception(tr("telegram (пользователь %s): ошибка обработки"), self.user)
                if not updates:
                    self.stop.wait(bots.IDLE_PAUSE)
        finally:
            bots.store.close()


class Telegram:
    MAX_BOTS = 10               # сколько пользователей могут подключить бота
    POLL_TIMEOUT = 25           # секунд удержания getUpdates
    IDLE_PAUSE = 0.1
    RETRY = 5                   # пауза после сбоя связи, дальше удваивается до минуты
    SEARCH_LIMIT = 8

    def __init__(self, proxy):
        self.proxy = proxy
        self.store = proxy.store
        self.api = proxy.cfg.telegram_api.rstrip("/")
        c = self.store.conn()
        c.executescript(SCHEMA)
        if "pair_until" not in {r["name"] for r in c.execute("PRAGMA table_info(telegram)")}:      # база до привязки по /start
            c.execute("ALTER TABLE telegram ADD COLUMN pair_until INTEGER NOT NULL DEFAULT 0")
        self.lock = threading.Lock()
        self.workers: dict[int, Worker] = {}

    # ------------------------------------------------------------------ жизненный цикл

    def start(self) -> None:
        for r in self.store.conn().execute("SELECT * FROM telegram WHERE token IS NOT NULL"):
            self._spawn(r["user_id"], r["token"], r["chat"])

    def stop(self) -> None:
        with self.lock:
            for w in self.workers.values():
                w.stop.set()
            self.workers.clear()

    def _spawn(self, user: int, token: str, chat: str | None) -> None:
        with self.lock:
            old = self.workers.get(user)
            if old and old.token == token and not old.stop.is_set() and old.thread.is_alive():
                old.chat = chat
                return
            if old:
                old.stop.set()
            w = self.workers[user] = Worker(self, user, token, chat)
            w.thread.start()

    def _drop(self, user: int) -> None:
        with self.lock:
            w = self.workers.pop(user, None)
        if w:
            w.stop.set()

    # ------------------------------------------------------------------ настройки (API плагина)

    def row(self, user: int):
        return self.store.conn().execute("SELECT * FROM telegram WHERE user_id=?", (user,)).fetchone()

    def status(self, user: int) -> dict:
        r = self.row(user)
        w = self.workers.get(user)
        return {"token": bool(r and r["token"]), "chat": (r["chat"] if r else None), "username": (r["username"] if r else None),
                "pairing": bool(r and r["token"] and r["pair_until"] > time.time()),
                "running": bool(w and w.thread.is_alive() and not w.stop.is_set()), "error": (w.error if w else None)}

    def handle(self, method: str, data: dict, user: int) -> tuple[int, dict]:
        """GET /lib/telegram -> состояние; POST {token?, chat?}, {pair: true} (открыть привязку чата по /start) или {clear: true} -> состояние.
        Токен в ответе не возвращается."""
        if method == "GET":
            return 200, self.status(user)
        if method != "POST":
            return 405, {"error": "GET or POST"}
        if data.get("clear"):
            self.store.conn().execute("DELETE FROM telegram WHERE user_id=?", (user,))
            self._drop(user)
            return 200, self.status(user)

        r = self.row(user)
        token, chat, username = (r["token"], r["chat"], r["username"]) if r else (None, None, None)
        pair = r["pair_until"] if r else 0
        if data.get("pair"):
            if not token:
                return 400, {"error": tr("сначала введите токен бота")}
            pair = int(time.time()) + PAIR_WINDOW
        if not r and self.store.conn().execute("SELECT COUNT(*) c FROM telegram").fetchone()["c"] >= self.MAX_BOTS:
            return 429, {"error": tr("на этом сервере уже подключено максимум ботов")}

        if data.get("token") is not None:
            new = str(data["token"]).strip()
            if not TOKEN_RE.match(new):
                return 400, {"error": tr("это не похоже на токен бота (его выдаёт @BotFather, вид 123456789:AAE…)")}
            if self.store.conn().execute("SELECT 1 FROM telegram WHERE token=? AND user_id<>?", (new, user)).fetchone():
                return 409, {"error": tr("этот бот уже подключён другим пользователем")}
            try:
                me = call(self.api, new, "getMe", timeout=10) or {}
            except TelegramError as e:
                return 400, {"error": tr("Telegram не принял токен: ") + (tr("неверный токен") if e.code == 401 else e.message)}
            token, username = new, str(me.get("username") or "")
            if not chat:
                pair = int(time.time()) + PAIR_WINDOW        # чата нет: сразу ждём /start
        if data.get("chat") is not None:
            new = str(data["chat"]).strip()
            if not CHAT_RE.match(new):
                return 400, {"error": tr("номер чата состоит из цифр (для группы начинается с минуса); узнать его можно командой /id у бота")}
            chat, pair = new, 0

        self.store.conn().execute(
            "INSERT INTO telegram(user_id,token,chat,username,updated_at,pair_until) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET token=excluded.token, chat=excluded.chat, username=excluded.username, "
            "updated_at=excluded.updated_at, pair_until=excluded.pair_until",
            (user, token, chat, username, int(time.time()), pair))

        out: dict
        if token:
            self._spawn(user, token, chat)        # без чата бот тоже слушает: ему нужно услышать /start и /id
            out = self.status(user)
            if chat and not data.get("pair"):
                try:
                    call(self.api, token, "sendMessage", {"chat_id": int(chat), "text": hello()}, timeout=10)
                    out["test"] = "ok"
                except TelegramError as e:        # чаще всего: бот ещё не получал /start от этого человека
                    out["test"] = e.message
        else:
            self._drop(user)
            out = self.status(user)
        return 200, out

    # ------------------------------------------------------------------ обработка сообщений

    def send(self, w: Worker, chat_id, text: str, markup: dict | None = None) -> None:
        payload = {"chat_id": chat_id, "text": text[:4000], "disable_web_page_preview": True}
        if markup:
            payload["reply_markup"] = markup
        try:
            call(self.api, w.token, "sendMessage", payload)
        except TelegramError as e:
            log.warning(tr("telegram (пользователь %s): не отправлено: %s"), w.user, e.message)

    def edit(self, w: Worker, chat_id, message_id, text: str, markup: dict | None = None) -> None:
        payload = {"chat_id": chat_id, "message_id": message_id, "text": text[:4000], "disable_web_page_preview": True}
        if markup:
            payload["reply_markup"] = markup
        try:
            call(self.api, w.token, "editMessageText", payload)
        except TelegramError as e:
            if "not modified" not in e.message.lower():
                log.warning(tr("telegram (пользователь %s): не изменено: %s"), w.user, e.message)

    def answer(self, w: Worker, callback_id: str, text: str | None = None) -> None:
        try:
            call(self.api, w.token, "answerCallbackQuery", dict({"callback_query_id": callback_id}, **({"text": text} if text else {})))
        except TelegramError:
            pass

    def dispatch(self, w: Worker, update: dict) -> None:
        sender = ((update.get("message") or update.get("callback_query") or {}).get("from") or {})
        set_lang(sender.get("language_code"))          # бот отвечает на языке Telegram того, кто пишет
        if isinstance(update.get("message"), dict):
            self.on_message(w, update["message"])
        elif isinstance(update.get("callback_query"), dict):
            self.on_callback(w, update["callback_query"])

    def lib(self, w: Worker, method: str, path: str, query: str = "", body: dict | None = None):
        return self.proxy.library.handle(method, path, query, json.dumps(body).encode() if body is not None else b"", w.user)

    def on_message(self, w: Worker, m: dict) -> None:
        chat_id = (m.get("chat") or {}).get("id")
        text = str(m.get("text") or "").strip()
        if chat_id is None or not text:
            return
        cmd = text.split()[0].split("@")[0].lower() if text.startswith("/") else ""
        if cmd == "/id":                    # номер чата нужен, чтобы вписать его в настройки, поэтому отвечаем в любом чате
            return self.send(w, chat_id, tr("Номер этого чата: {chat_id}", chat_id=chat_id))
        if cmd == "/start" and str(chat_id) != w.chat:
            return self.pair(w, m)          # чат ещё не привязан или привязывается заново; чужому чату отвечает pair()
        if str(chat_id) != w.chat:
            return                          # чужой чат: молчим
        if cmd in ("/start", "/help"):
            return self.send(w, chat_id, hello())
        if cmd == "/library":
            _, s = self.lib(w, "GET", "stats")
            return self.send(w, chat_id, tr("Библиотека\n\nФильмы: {s_movies}\nСериалы: {s_tv}\nКоллекции: {s_collections}", s_movies=s['movies'], s_tv=s['tv'], s_collections=s['collections']))
        if cmd == "/regen":
            ids = [r["id"] for r in self.proxy.library.rows("SELECT id FROM franchises WHERE user_id=? AND merged_into IS NULL", w.user)]
            for fid in ids:
                self.lib(w, "POST", f"franchises/{fid}/refresh", body={})
            return self.send(w, chat_id, tr("Обновление коллекций запущено: {len}", len=len(ids)))
        if cmd:
            return self.send(w, chat_id, tr("Напишите название фильма или сериала."))

        _, res = self.lib(w, "GET", "search", urllib.parse.urlencode({"query": text}))
        cards = (res.get("results") or [])[:self.SEARCH_LIMIT] if isinstance(res, dict) else []
        if not cards:
            return self.send(w, chat_id, tr("Ничего не найдено."))
        rows = []
        for c in cards:
            movie = c["media_type"] == "movie"
            year = str((c.get("release_date") if movie else c.get("first_air_date")) or "")[:4] or "----"
            label = f"{'🎬' if movie else '📺'} {c.get('title') if movie else c.get('name')} ({year})"
            rows.append([{"text": label[:55], "callback_data": f"pick:{'m' if movie else 't'}:{c['id']}"}])
        self.send(w, chat_id, tr("Выберите результат:"), {"inline_keyboard": rows})

    def pair(self, w: Worker, m: dict) -> None:
        """/start из чата, который ещё не привязан: привязать, если окно открыто и чат личный."""
        chat_id = m["chat"]["id"]
        r = self.store.conn().execute("SELECT pair_until FROM telegram WHERE user_id=? AND token=?", (w.user, w.token)).fetchone()
        if not r or r["pair_until"] <= time.time():
            if not w.chat:      # чат не привязан вообще: подсказываем как; привязанный бот чужим /start не отвечает
                self.send(w, chat_id, tr("Привязка закрыта. В Lampa откройте Настройки → TapokHub → Telegram и нажмите «Привязать чат», затем снова напишите мне /start."))
            return
        if (m.get("chat") or {}).get("type") != "private":
            return self.send(w, chat_id, tr("Так можно привязать только личный чат. Для группы впишите её номер в настройках (номер покажет /id)."))
        self.store.conn().execute("UPDATE telegram SET chat=?, pair_until=0, updated_at=? WHERE user_id=?", (str(chat_id), int(time.time()), w.user))
        w.chat = str(chat_id)
        self.send(w, chat_id, tr("✅ Чат привязан.\n\n") + hello())

    def card_text(self, kind: str, n: dict, st: dict, note: str = "") -> str:
        year = (n["date"] or "")[:4] or "----"
        lines = [f"{'🎬' if kind == 'movie' else '📺'} {n['title']} ({year})"]
        if n["original"] and n["original"].casefold() != n["title"].casefold():
            lines.append(n["original"])
        lines += ["", f"TMDB: {n['id']}", tr("Тип: {v1}", v1=tr('Фильм') if kind == 'movie' else tr('Сериал'))]
        if n["rating"]:
            lines.append(tr("Рейтинг: {float:.1f}", float=float(n['rating'])))
        lines.append(tr("В библиотеке: ") + (tr("да") if st["in_library"] else tr("нет")))
        if st["franchise"]:
            lines.append(tr("Коллекция: ") + (st["franchise"]["title"] if st["franchise"]["title"] != "…" else tr("собирается")))
        if n["overview"]:
            lines += ["", n["overview"]]
        if note:
            lines += ["", note]
        return "\n".join(lines)

    def card_keyboard(self, kind: str, tid: int, st: dict) -> dict:
        k = "m" if kind == "movie" else "t"
        return {"inline_keyboard": [
            [{"text": tr("🗑 Убрать из библиотеки") if st["in_library"] else tr("⭐ В библиотеку"), "callback_data": f"{'del' if st['in_library'] else 'add'}:{k}:{tid}"}],
            [{"text": tr("⛔ Не отслеживать коллекцию") if st["franchise"] else tr("🎞 Отслеживать коллекцию"), "callback_data": f"{'unfr' if st['franchise'] else 'fr'}:{k}:{tid}"}],
            [{"text": tr("Закрыть"), "callback_data": "cancel"}]]}

    def on_callback(self, w: Worker, cb: dict) -> None:
        cid = str(cb.get("id") or "")
        msg = cb.get("message") or {}
        chat_id, message_id = (msg.get("chat") or {}).get("id"), msg.get("message_id")
        if chat_id is None or message_id is None or str(chat_id) != w.chat:
            return self.answer(w, cid, tr("Нет доступа"))
        self.answer(w, cid)
        data = str(cb.get("data") or "")
        if data == "cancel":
            return self.edit(w, chat_id, message_id, tr("Закрыто."))
        parts = data.split(":")
        if len(parts) != 3 or parts[1] not in ("m", "t") or not parts[2].isdigit():
            return
        action, kind, tid = parts[0], "movie" if parts[1] == "m" else "tv", int(parts[2])
        n = self.proxy.library.details(kind, tid)
        if not n:
            return self.edit(w, chat_id, message_id, tr("TMDB сейчас не отвечает по этой позиции, попробуйте позже."))
        note = ""
        if action == "add":
            st, out = self.lib(w, "POST", "items/add", body={"kind": kind, "id": tid})
            note = tr("✅ Добавлено в библиотеку") if st < 400 else "⚠ " + str(out.get("error") or tr("не удалось добавить"))
        elif action == "del":
            self.lib(w, "POST", "items/remove", body={"kind": kind, "id": tid})
            note = tr("🗑 Убрано из библиотеки")
        elif action == "fr":
            st, out = self.lib(w, "POST", "franchises", body={"kind": kind, "id": tid})
            note = tr("🎞 Коллекция добавлена, состав соберётся в фоне") if st < 400 else "⚠ " + str(out.get("error") or tr("не удалось добавить"))
        elif action == "unfr":
            f = self.lib(w, "GET", "status", urllib.parse.urlencode({"kind": kind, "id": tid}))[1].get("franchise")
            if f:
                self.lib(w, "POST", f"franchises/{f['id']}/delete", body={})
            note = tr("⛔ Коллекция больше не отслеживается")
        elif action != "pick":
            return
        st = self.lib(w, "GET", "status", urllib.parse.urlencode({"kind": kind, "id": tid}))[1]
        self.edit(w, chat_id, message_id, self.card_text(kind, n, st, note), self.card_keyboard(kind, tid, st))
