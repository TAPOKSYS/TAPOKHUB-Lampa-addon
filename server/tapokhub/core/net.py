"""Сетевые примитивы: один запрос на ключ для параллельных клиентов, ограничитель частоты и ограниченный по размеру GET."""

from __future__ import annotations

import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from tapokhub.core.common import UpstreamError


# ---------------------------------------------------------------- вспомогательное

class SingleFlight:
    """Одинаковые одновременные запросы к TMDB склеиваются в один."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.calls: dict[str, dict] = {}

    def do(self, key: str, fn: Callable[[], Any]) -> Any:
        with self.lock:
            call = self.calls.get(key)
            leader = call is None
            if leader:
                call = self.calls[key] = {"ev": threading.Event(), "res": None, "err": None}
        if leader:
            try:
                call["res"] = fn()
            except BaseException as e:  # noqa: BLE001 — передаём ожидающим
                call["err"] = e
            finally:
                with self.lock:
                    self.calls.pop(key, None)
                call["ev"].set()
        else:
            call["ev"].wait(timeout=120)
        if call["err"] is not None:
            raise call["err"]
        return call["res"]


class RateLimiter:
    """Не больше limit событий за window секунд на ключ (скользящее окно). limit=0: без ограничения."""

    def __init__(self, limit: int, window: float = 60.0, now=time.monotonic) -> None:
        self.limit, self.window, self.now = limit, window, now
        self.lock = threading.Lock()
        self.hits: dict = {}

    def allow(self, key) -> bool:
        if self.limit <= 0:
            return True
        t = self.now()
        with self.lock:
            hits = [x for x in self.hits.get(key, ()) if t - x < self.window]
            ok = len(hits) < self.limit
            if ok:
                hits.append(t)
            self.hits[key] = hits
            if len(self.hits) > 5000:
                self.hits = {k: v for k, v in self.hits.items() if v and t - v[-1] < self.window}
            return ok


def http_get(url: str, timeout: float, limit: int) -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "TapokHub-proxy/1.0", "Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(limit + 1)
            if len(data) > limit:
                raise UpstreamError(502, msg="upstream response too large")
            return r.status, data, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(limit), e.headers.get("Content-Type", "")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise UpstreamError(502, msg=f"upstream unreachable: {e}") from e
