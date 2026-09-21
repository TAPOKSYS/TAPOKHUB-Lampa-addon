"""Языки сервера: русский текст служит ключом, английский перевод лежит в core/i18n_en.py.

    tr("нет такого пользователя")                    -> на английском: "no such user"
    tr("почта пользователя {id}: {email}", id=1, email="a@b")

Язык выбирается по запросу: HTTP-запрос несёт Accept-Language (плагин ставит туда язык Lampa), сообщение Telegram несёт
language_code отправителя, а команды администратора и журнал берут язык по умолчанию: TAPOK_LANG (ru | en), иначе язык
системы (LC_ALL, LC_MESSAGES, LANG), иначе русский. Русский, украинский и белорусский дают русский текст, остальные английский.
Нет перевода: показывается ключ, то есть русский текст. Подстановки выполняются только если переданы аргументы, поэтому
текст с «%s» для журнала и с фигурными скобками без аргументов остаётся как есть.
"""

import contextvars
import os

from tapokhub.core.i18n_en import EN

RU_LIKE = ("ru", "uk", "be")
_current: contextvars.ContextVar = contextvars.ContextVar("tapokhub_lang", default="")


def normalize(code) -> str:
    """'ru-RU', 'uk', 'en_US.UTF-8', 'de,en;q=0.8' -> 'ru' | 'en'; пусто или нераспознано -> ''."""
    first = str(code or "").split(",")[0].split(";")[0].strip().lower()
    base = first.replace("_", "-").split(".")[0].split("-")[0]

    if not base or base in ("c", "posix", "*"):
        return ""

    return "ru" if base in RU_LIKE else "en"


def default_lang() -> str:
    """TAPOK_LANG, иначе язык системы, иначе русский."""
    for name in ("TAPOK_LANG", "LC_ALL", "LC_MESSAGES", "LANG"):
        lang = normalize(os.environ.get(name))
        if lang:
            return lang

    return "ru"


def lang() -> str:
    return _current.get() or default_lang()


def set_lang(code) -> None:
    """Язык текущего потока/запроса; пусто или нераспознано: язык по умолчанию."""
    _current.set(normalize(code))


def tr(key: str, **values) -> str:
    text = EN.get(key, key) if lang() == "en" else key

    return text.format(**values) if values else text
