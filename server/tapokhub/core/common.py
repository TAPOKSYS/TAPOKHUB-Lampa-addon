"""Общее для всех слоёв сервиса: единицы времени и исключение ответа источника (TMDB, Wikidata)."""

HOUR = 3600
DAY = 24 * HOUR


class UpstreamError(Exception):
    def __init__(self, status: int, body: bytes = b"", ctype: str = "application/json", msg: str = ""):
        super().__init__(msg or f"upstream {status}")
        self.status, self.body, self.ctype = status, body, ctype
