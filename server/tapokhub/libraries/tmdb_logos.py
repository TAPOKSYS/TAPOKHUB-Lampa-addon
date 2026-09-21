"""Выбор логотипа из ответа TMDB (images.logos)."""


def pick_logo(logos: list, lang: str):
    """Лучший логотип: язык интерфейса -> en -> без языка -> любой; внутри языка выше оценка.
    Сначала только «вытянутые» (ширина ≥ 2× высоты): у квадратных и высоких надпись мелкая, в плитке не читается.
    Нет вытянутых: берём любые. -> file_path | None."""
    usable = [lg for lg in logos if lg.get("file_path")]

    def wide(lg):
        w, h = lg.get("width"), lg.get("height")
        return bool(w and h and w >= 2 * h)

    for group in ([lg for lg in usable if wide(lg)], usable):
        for code in dict.fromkeys([lang, "en", None]):
            found = [lg for lg in group if ((lg.get("iso_639_1") or None) == code if code else not lg.get("iso_639_1"))]
            if found:
                return max(found, key=lambda lg: lg.get("vote_average") or 0)["file_path"]
        if group:
            return group[0]["file_path"]
    return None
