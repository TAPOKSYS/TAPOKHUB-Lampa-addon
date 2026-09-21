"""TapokHub: сервер (кеширующий прокси TMDB, пользователи, библиотека франшиз).

Слои: core (ядро) <- libraries (библиотеки) <- modules (модули) <- cli. Зависимости идут только в эту сторону.
"""

from pathlib import Path


def _version() -> str:
    for p in (Path(__file__).resolve().parent / "VERSION", Path(__file__).resolve().parents[2] / "VERSION"):
        try:
            return p.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return "0+unknown"


__version__ = _version()
