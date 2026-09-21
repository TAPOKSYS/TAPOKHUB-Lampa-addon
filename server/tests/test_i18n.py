#!/usr/bin/env python3
"""Языки сервера: выбор языка, подстановки, полнота английского каталога и английские ответы. Запуск: python3 server/tests/test_i18n.py"""

import ast
import os
import re
import sys
import unittest
from pathlib import Path

os.environ["TAPOK_LANG"] = "ru"
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tapokhub.core import i18n  # noqa: E402
from tapokhub.core.i18n_en import EN  # noqa: E402
from tapokhub.modules import web  # noqa: E402

CYR = re.compile("[А-Яа-яЁё]")
# тексты, которые попадают в tr() не литералом: названия групп из базы (модули library) и разбираемые в коде составные строки
DYNAMIC = {"Другие фильмы", "Скоро", "Сериалы", "Мультсериалы", "Прочее", "Фильмы"}


def used_keys() -> set:
    keys = set()
    for path in (ROOT / "tapokhub").rglob("*.py"):
        if path.name.startswith("i18n"):
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "tr" and node.args \
                    and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                keys.add(node.args[0].value)
    return keys


class Language(unittest.TestCase):
    def setUp(self):
        i18n.set_lang("")

    def test_normalize(self):
        for raw, want in [("ru", "ru"), ("ru-RU", "ru"), ("uk", "ru"), ("be", "ru"), ("en", "en"), ("en_US.UTF-8", "en"),
                          ("de,en;q=0.8", "en"), ("pt-BR", "en"), ("", ""), (None, ""), ("C", ""), ("C.UTF-8", ""), ("POSIX", ""), ("*", "")]:
            self.assertEqual(i18n.normalize(raw), want, raw)

    def test_default_language_from_environment(self):
        saved = {k: os.environ.pop(k, None) for k in ("TAPOK_LANG", "LC_ALL", "LC_MESSAGES", "LANG")}
        try:
            self.assertEqual(i18n.default_lang(), "ru")                    # ничего не задано: русский
            os.environ["LANG"] = "en_US.UTF-8"
            self.assertEqual(i18n.default_lang(), "en")
            os.environ["LC_ALL"] = "ru_RU.UTF-8"                          # LC_ALL сильнее LANG
            self.assertEqual(i18n.default_lang(), "ru")
            os.environ["TAPOK_LANG"] = "en"                                # TAPOK_LANG сильнее всех
            self.assertEqual(i18n.default_lang(), "en")
            os.environ["TAPOK_LANG"] = "C"                                 # нераспознанное значение пропускается
            self.assertEqual(i18n.default_lang(), "ru")
        finally:
            for k, v in saved.items():
                os.environ.pop(k, None)
                if v is not None:
                    os.environ[k] = v

    def test_tr_follows_the_request_language_and_falls_back_to_the_key(self):
        i18n.set_lang("en-US")
        self.assertEqual(i18n.tr("нет такого пользователя"), "no such user")
        self.assertEqual(i18n.tr("текста нет в каталоге"), "текста нет в каталоге")
        i18n.set_lang("ru")
        self.assertEqual(i18n.tr("нет такого пользователя"), "нет такого пользователя")
        i18n.set_lang("de")
        self.assertEqual(i18n.lang(), "en")
        i18n.set_lang(None)
        self.assertEqual(i18n.lang(), i18n.default_lang())

    def test_substitutions_only_when_arguments_are_given(self):
        i18n.set_lang("en")
        self.assertEqual(i18n.tr("итого: {len}", len=3), "total: 3")
        self.assertEqual(i18n.tr("registration: {x}"), "registration: {x}")      # без аргументов скобки не трогаем
        self.assertEqual(i18n.tr("прогрев: %s") % "ok", "warm-up: ok")            # текст для журнала с %s
        i18n.set_lang("ru")
        self.assertEqual(i18n.tr("итого: {len}", len=3), "итого: 3")

    def test_language_is_per_thread(self):
        import threading
        seen = {}
        i18n.set_lang("ru")

        def other():
            i18n.set_lang("en")
            seen["other"] = i18n.lang()

        t = threading.Thread(target=other)
        t.start()
        t.join()
        self.assertEqual((seen["other"], i18n.lang()), ("en", "ru"))


class Catalog(unittest.TestCase):
    def test_every_text_has_a_translation_and_nothing_extra(self):
        from tapokhub import cli
        keys = used_keys() | DYNAMIC | {cli.__doc__}
        missing = sorted(k for k in keys if k not in EN)
        stale = sorted(k for k in EN if k not in keys)
        self.assertEqual(missing, [], "нет перевода: " + " | ".join(missing))
        self.assertEqual(stale, [], "лишние ключи каталога: " + " | ".join(stale))
        self.assertGreater(len(keys), 150)

    def test_translations_are_english_and_keep_placeholders(self):
        for key, value in EN.items():
            self.assertFalse(CYR.search(value), key)
            self.assertTrue(value.strip(), key)
            self.assertEqual(sorted(re.findall(r"\{\w+(?:![rsa])?(?::[^}]*)?\}", key)), sorted(re.findall(r"\{\w+(?:![rsa])?(?::[^}]*)?\}", value)), key)
            self.assertEqual(sorted(re.findall(r"%[sdr]", key)), sorted(re.findall(r"%[sdr]", value)), key)


class Pages(unittest.TestCase):
    def test_hint_page_language(self):
        page = object.__new__(web.Web)          # index() не использует состояние
        i18n.set_lang("en")
        html = page.index("http://10.0.0.5:8080").decode()
        self.assertIn('lang="en"', html)
        self.assertIn("The server is running", html)
        self.assertIn("README.en.md", html)
        self.assertIn("An http address", html)
        i18n.set_lang("ru")
        html = page.index("http://10.0.0.5:8080").decode()
        self.assertIn('lang="ru"', html)
        self.assertIn("Сервер работает", html)
        self.assertNotIn("README.en.md", html)


if __name__ == "__main__":
    unittest.main()
