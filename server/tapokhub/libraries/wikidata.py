"""Клиент Wikidata для сбора франшиз.

Wikidata хранит связь «часть франшизы» (P8345) и «часть серии» (P179) для фильмов и сериалов, а также их
идентификаторы в TMDB (P4947 для фильмов, P4983 для сериалов). По ним можно найти всё, что относится к
франшизе, чего нет в коллекции TMDB: спин-оффы, сериалы, мультсериалы.

Пользуемся обычным API (www.wikidata.org/w/api.php), а не SPARQL: у сервиса запросов SPARQL очень жёсткий
лимит (1 запрос в минуту при сбоях). API тоже ограничивает частоту, поэтому:
- между запросами пауза (min_interval), общая на все потоки;
- при ответе 429 ждём и повторяем (backoff);
- всё кешируется в SQLite (ttl), франшизы меняются редко.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from tapokhub.core.i18n import tr

log = logging.getLogger("tapokhub.wikidata")

DAY = 24 * 3600
UA = "TapokHub/1.0 (personal media library; https://a.pcsrf.ru)"

CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS wd_cache(
    key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
"""


class WikidataError(RuntimeError):
    pass


class WikidataClient:
    def __init__(self, base: str, conn_factory, min_interval: float = 3.0, ttl: int = 14 * DAY,
                 backoff: tuple = (30, 60, 120), timeout: float = 40.0, sleep=time.sleep,
                 label_langs: tuple = ("ru", "en")):
        self.base = base
        self.conn = conn_factory          # -> sqlite3.Connection текущего потока
        self.min_interval = min_interval
        self.ttl = ttl
        self.backoff = backoff
        self.timeout = timeout
        self.sleep = sleep
        self.label_langs = tuple(label_langs)   # языки названий по порядку предпочтения
        self.lock = threading.Lock()
        self.last = 0.0
        self.requests = 0                 # сколько раз реально сходили в сеть (для тестов и диагностики)
        self.conn().executescript(CACHE_SCHEMA)

    # ---- низкий уровень

    def _key(self, params: dict) -> str:
        return urllib.parse.urlencode(sorted(params.items()))

    def get(self, params: dict) -> dict:
        params = {"format": "json", **params}
        key = self._key(params)
        row = self.conn().execute("SELECT body, fetched_at FROM wd_cache WHERE key=?", (key,)).fetchone()
        if row and time.time() - row["fetched_at"] < self.ttl:
            return json.loads(row["body"])

        last_error: Exception | None = None
        for attempt in range(len(self.backoff) + 1):
            with self.lock:                      # один запрос за раз и не чаще min_interval
                wait = self.min_interval - (time.time() - self.last)
                if wait > 0:
                    self.sleep(wait)
                try:
                    req = urllib.request.Request(self.base + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA})
                    self.requests += 1
                    with urllib.request.urlopen(req, timeout=self.timeout) as r:
                        body = r.read().decode("utf-8")
                    self.last = time.time()
                    data = json.loads(body)
                    if "error" in data:
                        raise WikidataError(f"wikidata: {data['error'].get('code')}: {data['error'].get('info')}")
                    self.conn().execute(
                        "INSERT INTO wd_cache(key,body,fetched_at) VALUES(?,?,?) "
                        "ON CONFLICT(key) DO UPDATE SET body=excluded.body, fetched_at=excluded.fetched_at",
                        (key, body, int(time.time())),
                    )
                    return data
                except urllib.error.HTTPError as e:
                    self.last = time.time()
                    last_error = e
                    if e.code not in (429, 503):
                        raise WikidataError(f"wikidata HTTP {e.code}") from e
                except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                    self.last = time.time()
                    last_error = e
            if attempt < len(self.backoff):
                log.warning(tr("wikidata: лимит/сбой (%s), жду %s с"), last_error, self.backoff[attempt])
                self.sleep(self.backoff[attempt])

        # своих сил нет: устаревшая копия лучше, чем ничего
        if row:
            return json.loads(row["body"])
        raise WikidataError(tr("wikidata недоступна: {last_error}", last_error=last_error))

    # ---- разбор

    def entities(self, qids: list[str]) -> dict[str, dict]:
        """-> {qid: {label, claims: {P…: [значения]}}} (значения: id элемента или строка внешнего идентификатора)."""
        out: dict[str, dict] = {}
        qids = list(dict.fromkeys(qids))
        for i in range(0, len(qids), 50):
            data = self.get({"action": "wbgetentities", "ids": "|".join(qids[i:i + 50]), "props": "claims|labels", "languages": "|".join(self.label_langs)})
            for q, e in (data.get("entities") or {}).items():
                labels = e.get("labels") or {}
                label = next((labels[c]["value"] for c in self.label_langs if labels.get(c)), None) or q
                claims: dict[str, list] = {}
                for prop, lst in (e.get("claims") or {}).items():
                    vals = []
                    for c in lst:
                        snak = c.get("mainsnak") or {}
                        dv = snak.get("datavalue")
                        if not dv:
                            continue
                        v = dv["value"]
                        vals.append(v["id"] if isinstance(v, dict) and "id" in v else v)
                    claims[prop] = vals
                out[q] = {"label": label, "claims": claims}
        return out

    def search_statement(self, query: str, limit: int = 500) -> list[str]:
        """QID элементов по поисковому запросу вида «haswbstatement:P8345=Q462 haswbstatement:P4947»."""
        titles: list[str] = []
        offset = 0
        while len(titles) < limit:
            data = self.get({"action": "query", "list": "search", "srsearch": query, "srlimit": 500, "sroffset": offset})
            titles += [x["title"] for x in (data.get("query") or {}).get("search", [])]
            if "continue" in data:
                offset = data["continue"]["sroffset"]
            else:
                break
        return titles[:limit]

    def members(self, qid: str, prop: str) -> list[dict]:
        """Фильмы и сериалы франшизы/серии qid с идентификаторами TMDB: [{kind, id, label, qid}]."""
        out: list[dict] = []
        for id_prop, kind in (("P4947", "movie"), ("P4983", "tv")):
            found = self.search_statement(f"haswbstatement:{prop}={qid} haswbstatement:{id_prop}")
            for q, e in self.entities(found).items():
                for v in e["claims"].get(id_prop, []):
                    try:
                        out.append({"kind": kind, "id": int(v), "label": e["label"], "qid": q})
                    except (TypeError, ValueError):
                        pass
        return out

    # ---- граф связей произведений

    LINKS = ("P155", "P156", "P144", "P4969")       # предыдущее, следующее, основано на, производное произведение

    def related(self, start: str, depth: int = 3, max_nodes: int = 60, hub_limit: int = 25) -> list[dict]:
        """Всё, что связано с произведением start цепочками «предыдущее/следующее/основано на/производное».

        Так находятся ремейки, сиквелы и экранизации одного первоисточника (роман -> мультфильм 1961, фильм 1996,
        «102 далматинца», «Круэлла»), когда общей «франшизы» в Wikidata нет. Промежуточные звенья (книга) сами в
        результат не попадают: нужны только фильмы и сериалы с идентификаторами TMDB.
        Обратные связи (кто «основан на» этом) ищем поиском; у слишком популярного первоисточника (больше hub_limit
        экранизаций: Дракула, Шерлок Холмс) дальше не идём, иначе в коллекцию попало бы пол-кинематографа.
        -> [{kind, id, label, qid}], включая сам start, если он фильм/сериал.
        """
        seen = {start}
        frontier = [start]
        found: dict[str, dict] = {}
        for _ in range(depth):
            if not frontier or len(seen) >= max_nodes:
                break
            ents = self.entities(frontier)
            nxt: list[str] = []
            for q in frontier:
                e = ents.get(q)
                if not e:
                    continue
                for id_prop, kind in (("P4947", "movie"), ("P4983", "tv")):
                    for v in e["claims"].get(id_prop, []):
                        try:
                            found.setdefault(q, {"kind": kind, "id": int(v), "label": e["label"], "qid": q})
                        except (TypeError, ValueError):
                            pass
                linked = [t for p in self.LINKS for t in e["claims"].get(p, []) if isinstance(t, str) and t.startswith("Q")]
                for p in ("P144", "P155", "P156"):        # обратные связи
                    hits = self.search_statement(f"haswbstatement:{p}={q}", limit=hub_limit + 1)
                    if len(hits) > hub_limit:
                        log.info(tr("wikidata: %s слишком популярен (%s+ связей по %s), не раскрываем"), q, hub_limit, p)
                        continue
                    linked += hits
                for t in linked:
                    if t not in seen and len(seen) < max_nodes:
                        seen.add(t)
                        nxt.append(t)
            frontier = nxt
        # последний слой ещё не разобран на фильмы: доберём метки и идентификаторы
        if frontier:
            for q, e in self.entities(frontier).items():
                for id_prop, kind in (("P4947", "movie"), ("P4983", "tv")):
                    for v in e["claims"].get(id_prop, []):
                        try:
                            found.setdefault(q, {"kind": kind, "id": int(v), "label": e["label"], "qid": q})
                        except (TypeError, ValueError):
                            pass
        return list(found.values())
