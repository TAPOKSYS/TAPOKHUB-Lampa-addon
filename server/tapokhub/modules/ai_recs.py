"""ИИ-подборка дня: раз в сутки по библиотеке владельца спрашиваем у ИИ (OpenAI-совместимый API) 18 фильмов и сериалов,
каждую позицию проверяем в TMDB (выдуманное отсеивается), убираем то, что уже в библиотеке или уже советовали, и сохраняем.
Только для владельца (uid 1). Ключ ИИ владелец вводит в настройках плагина (хранится на сервере, наружу не отдаётся) или задаёт
в TAPOK_AI_KEY; ключ из настроек главнее. Без ключа подборка выключена. Адрес TAPOK_AI_URL, модель TAPOK_AI_MODEL."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request

from tapokhub.core.i18n import tr
from tapokhub.modules.library import card_of, norm_title, normalize
from tapokhub.modules.users import OWNER

log = logging.getLogger("tapokhub")

SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_recs(user_id INTEGER PRIMARY KEY, day TEXT NOT NULL, items TEXT NOT NULL, error TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS ai_history(user_id INTEGER NOT NULL, kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, day TEXT NOT NULL,
    PRIMARY KEY(user_id, kind, tmdb_id));
"""
WANT = 18             # сколько позиций в подборке
ASK = 30              # сколько просим у ИИ: часть отсеется проверкой
PROFILE_MAX = 120     # сколько позиций библиотеки показываем ИИ (самые свежие)
HISTORY_SHOW = 150    # сколько прежних советов напоминаем ИИ, чтобы не повторял


class AiError(Exception):
    pass


def chat(cfg, key: str, system: str, user: str, timeout: float = 90.0) -> str:
    """Один запрос chat/completions -> текст ответа. Ключ в журнал и в сообщения об ошибках не попадает."""
    body = json.dumps({"model": cfg.ai_model, "temperature": 0.8, "response_format": {"type": "json_object"},
                       "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(f"{cfg.ai_url}/v1/chat/completions" if not cfg.ai_url.endswith("/v1") else f"{cfg.ai_url}/chat/completions",
                                 data=body, headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read(4 << 20).decode("utf-8"))
        return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        raise AiError(f"HTTP {e.code}") from None       # 401 - ключ, 402 - кончились деньги, 429 - лимит
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
        raise AiError(type(e).__name__) from None


def parse_titles(text: str) -> list[dict]:
    """Ответ ИИ -> [{title, year, kind, why}]. Принимает {"items":[...]} или просто список; лишнее отбрасывает."""
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if isinstance(data, dict):
        data = next((v for v in data.values() if isinstance(v, list)), [])
    out = []
    for x in data if isinstance(data, list) else []:
        if not isinstance(x, dict) or not str(x.get("title") or "").strip():
            continue
        kind = "tv" if str(x.get("kind") or x.get("type") or "").lower() in ("tv", "series", "show", "сериал") else "movie"
        try:
            year = int(str(x.get("year") or "")[:4])
        except ValueError:
            year = 0
        out.append({"title": str(x["title"]).strip()[:120], "year": year, "kind": kind, "why": str(x.get("why") or "").strip()[:200]})
    return out


class AiRecs:
    def __init__(self, library):
        self.lib = library
        self.cfg = library.proxy.cfg
        self.store = library.store
        self.store.conn().executescript(SCHEMA)
        self.lock = threading.Lock()
        self.busy = False

    KEY_RE = re.compile(r"^[A-Za-z0-9._-]{16,200}$")

    def key(self) -> str:
        """Ключ ИИ: из настроек плагина (хранится в базе) или из TAPOK_AI_KEY."""
        return self.store.meta_get("ai_key") or self.cfg.ai_key

    @property
    def enabled(self) -> bool:
        return bool(self.key())

    def key_info(self) -> dict:
        """Что можно показать владельцу: задан ли ключ, откуда, последние четыре символа. Сам ключ наружу не уходит."""
        k = self.key()
        r = self.lib.row("SELECT day, error FROM ai_recs WHERE user_id=?", OWNER)
        return {"admin": True, "set": bool(k), "source": "settings" if self.store.meta_get("ai_key") else ("server" if k else ""),
                "hint": k[-4:] if k else "", "day": r["day"] if r else "", "error": r["error"] if r else None, "busy": self.busy}

    def set_key(self, value: str) -> bool:
        """Задать ключ из настроек (пусто = убрать и вернуться к TAPOK_AI_KEY). False: ключ не похож на ключ."""
        value = (value or "").strip()
        if not value:
            self.store.conn().execute("DELETE FROM meta WHERE k='ai_key'")
            return True
        if not self.KEY_RE.match(value):
            return False
        self.store.meta_set("ai_key", value)
        return True

    # ---- вкус

    def library_nodes(self, user: int) -> list[dict]:
        """Позиции библиотеки с данными TMDB, свежие первыми (то, что человек добавил недавно, важнее для вкуса)."""
        added = {(r["kind"], r["tmdb_id"]): r["added_at"] for r in self.lib.rows("SELECT kind, tmdb_id, added_at FROM library_items WHERE user_id=?", user)}
        ids = self.lib.stats(user)["ids"]
        keys = [(k, i) for k in ("movie", "tv") for i in ids[k]]
        keys.sort(key=lambda k: -added.get(k, 0))
        det = self.lib.details_many(keys[:PROFILE_MAX])
        return [det[k] for k in keys[:PROFILE_MAX] if k in det]

    @staticmethod
    def profile(nodes: list[dict]) -> str:
        lines = []
        for n in nodes:
            r = f", {n['rating']:.1f}" if n.get("rating") else ""
            lines.append(f"- {n['title']}" + (f" / {n['original']}" if n.get("original") and n["original"] != n["title"] else "") +
                         f" ({n['date'][:4] or '?'}, {'сериал' if n['kind'] == 'tv' else 'фильм'}{r})")
        return "\n".join(lines)

    # ---- запрос и проверка

    def ask(self, nodes: list[dict], avoid: list[str]) -> list[dict]:
        system = ("Ты опытный кинокритик и подбираешь фильмы и сериалы под вкус человека по его библиотеке. Предлагай только реально существующие "
                  "и достаточно известные позиции, которых нет в библиотеке и в списке уже советованного. Не повторяйся, смешивай фильмы и сериалы, "
                  "добавляй неочевидные вещи, а не только хиты. Ответ: JSON-объект {\"items\":[{\"title\":\"название на русском\",\"year\":2010,"
                  "\"kind\":\"movie|tv\",\"why\":\"одно короткое предложение по-русски, чем подходит\"}]}.")
        user = f"Библиотека (от свежих добавлений):\n{self.profile(nodes)}\n\n"
        if avoid:
            user += "Уже советовал, не повторять:\n" + ", ".join(avoid) + "\n\n"
        user += f"Предложи {ASK} позиций."
        return parse_titles(chat(self.cfg, self.key(), system, user))

    def resolve(self, want: dict, skip: set) -> dict | None:
        """Позиция от ИИ -> карточка TMDB или None, если такой нет, она уже есть у человека, без постера и т.п."""
        res = (self.lib.tmdb("search/" + want["kind"], [("query", want["title"])] + ([("year" if want["kind"] == "movie" else "first_air_date_year", str(want["year"]))] if want["year"] else [])) or {}).get("results") or []
        for r in res[:5]:
            n = normalize(want["kind"], r)
            if (n["kind"], n["id"]) in skip or n["adult"] or not n["poster"] or n["votes"] < 50:
                continue
            if want["year"] and n["date"] and abs(int(n["date"][:4]) - want["year"]) > 1:
                continue
            if norm_title(want["title"]) not in (norm_title(n["title"]), norm_title(n["original"])) and want["year"] == 0:
                continue
            return dict(card_of(n), why=want["why"])
        return None

    # ---- подборка дня

    def history(self, user: int) -> list:
        return self.lib.rows("SELECT kind, tmdb_id, day FROM ai_history WHERE user_id=? ORDER BY day DESC LIMIT 1000", user)

    def refresh(self, user: int = OWNER, force: bool = False) -> dict:
        """Собрать подборку на сегодня (если её ещё нет или force). Сбой не трогает прежнюю подборку: пишется только error."""
        day = self.lib.today()
        with self.lock:
            if self.busy:
                return self.get(user)
            cur = self.lib.row("SELECT day FROM ai_recs WHERE user_id=?", user)
            if cur and cur["day"] == day and not force:
                return self.get(user)
            self.busy = True
        try:
            nodes = self.library_nodes(user)
            if not nodes:
                raise AiError(tr("в библиотеке пока ничего нет"))
            hist = self.history(user)
            skip = {(n["kind"], n["id"]) for n in nodes} | {(h["kind"], h["tmdb_id"]) for h in hist}
            names = [t for t in (self._title_of(h["kind"], h["tmdb_id"]) for h in hist[:HISTORY_SHOW]) if t]
            found, seen = [], set()
            for want in self.ask(nodes, names):
                card = self.resolve(want, skip)
                key = (card["media_type"], card["id"]) if card else None
                if card and key not in seen:
                    seen.add(key)
                    found.append(card)
                if len(found) >= WANT:
                    break
            if not found:
                raise AiError(tr("ИИ не предложил ничего подходящего"))
            c = self.store.conn()
            c.execute("INSERT INTO ai_recs(user_id,day,items,error,at) VALUES(?,?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET day=excluded.day, "
                      "items=excluded.items, error=NULL, at=excluded.at", (user, day, json.dumps(found, ensure_ascii=False), int(time.time())))
            c.executemany("INSERT OR IGNORE INTO ai_history(user_id,kind,tmdb_id,day) VALUES(?,?,?,?)", [(user, x["media_type"], x["id"], day) for x in found])
            c.execute("DELETE FROM ai_history WHERE user_id=? AND rowid NOT IN (SELECT rowid FROM ai_history WHERE user_id=? ORDER BY day DESC LIMIT 1000)", (user, user))
            log.info(tr("ИИ-подборка: сохранено позиций %d"), len(found))
        except AiError as e:
            log.warning(tr("ИИ-подборка не получилась: %s"), e)
            self.store.conn().execute("INSERT INTO ai_recs(user_id,day,items,error,at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET error=excluded.error, at=excluded.at",
                                      (user, "", "[]", str(e), int(time.time())))
        finally:
            self.busy = False
        return self.get(user)

    def _title_of(self, kind: str, tid: int) -> str:
        d = self.lib.details(kind, tid)
        return d["title"] if d else ""

    def get(self, user: int = OWNER) -> dict:
        if user != OWNER or not self.enabled:
            return {"enabled": False, "items": []}
        r = self.lib.row("SELECT * FROM ai_recs WHERE user_id=?", user)
        return {"enabled": True, "busy": self.busy, "day": r["day"] if r else "", "items": json.loads(r["items"]) if r else [], "error": r["error"] if r else None}

    def daily(self) -> None:
        """Вызывается из фонового цикла: раз в сутки обновить подборку владельца."""
        if self.enabled:
            self.refresh(OWNER)
