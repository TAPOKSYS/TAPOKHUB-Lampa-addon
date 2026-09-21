#!/usr/bin/env python3
"""Telegram-бот: настройка через /lib/telegram, поиск, добавление в библиотеку, доступ только из своего чата.
Поддельный Telegram и TMDB. Запуск: python3 server/tests/test_telegram.py"""

import os as _os
_os.environ["TAPOK_LANG"] = "ru"      # тесты проверяют русские тексты; английские: test_i18n.py
import http.client
import http.server
import json
import re
import socketserver
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_library as tl  # noqa: E402
from tapokhub.modules.telegram import Telegram  # noqa: E402

BOT = "123456789:" + "A" * 35
OTHER_BOT = "987654321:" + "B" * 35
CHAT = "555001"


class FakeTelegram:
    """Поддельный api.telegram.org: очередь входящих, журнал отправленного."""

    def __init__(self):
        self.tokens = {BOT: "tapok_bot", OTHER_BOT: "other_bot"}
        self.reset()
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                m = re.match(r"^/bot([^/]+)/(\w+)$", self.path)
                token, method = m[1], m[2]
                if token not in outer.tokens:
                    return self.reply(401, {"ok": False, "error_code": 401, "description": "Unauthorized"})
                outer.log.append((token, method, body))
                if method == "getMe":
                    return self.reply(200, {"ok": True, "result": {"id": 1, "username": outer.tokens[token]}})
                if method == "getUpdates" and outer.cut_next > 0:      # ответ обрывается на полуслове
                    outer.cut_next -= 1
                    self.send_response(200)
                    self.send_header("Content-Length", "500")
                    self.end_headers()
                    self.wfile.write(b'{"ok": tr')
                    return
                if method == "getUpdates":
                    with outer.lock:
                        ups = [u for u in outer.queue if u["update_id"] >= (body.get("offset") or 0)]
                    if not ups:
                        time.sleep(0.05)
                    return self.reply(200, {"ok": True, "result": ups})
                if method == "sendMessage" and str(body["chat_id"]) in outer.blocked:
                    return self.reply(403, {"ok": False, "error_code": 403, "description": "Forbidden: bot can't initiate conversation with a user"})
                if method in ("sendMessage", "editMessageText", "answerCallbackQuery"):
                    return self.reply(200, {"ok": True, "result": True})
                self.reply(404, {"ok": False, "error_code": 404, "description": "Not Found"})

            def reply(self, status, obj):
                data = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.server = S(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reset(self):
        self.lock = threading.Lock()
        self.queue, self.log, self.blocked, self.seq, self.cut_next = [], [], set(), 0, 0

    def push(self, **kw):
        with self.lock:
            self.seq += 1
            self.queue.append(dict(update_id=self.seq, **kw))

    def say(self, chat, text, kind="private"):
        self.push(message={"chat": {"id": int(chat), "type": kind}, "from": {"id": abs(int(chat))}, "text": text})

    def press(self, chat, data, message_id=7):
        self.push(callback_query={"id": f"cb{self.seq}", "data": data, "message": {"chat": {"id": int(chat)}, "message_id": message_id}})

    def sent(self, method="sendMessage"):
        return [b for _, m, b in list(self.log) if m == method]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Bot(tl.Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tg = FakeTelegram()

    @classmethod
    def tearDownClass(cls):
        cls.tg.close()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.tg.reset()
        Telegram.POLL_TIMEOUT = 0
        Telegram.IDLE_PAUSE = 0.02
        Telegram.RETRY = 0.05
        self.bots = self.proxy.telegram
        self.bots.api = self.tg.url

    def tearDown(self):
        self.bots.stop()
        super().tearDown()

    def wait(self, cond, what, timeout=6.0):
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return
            time.sleep(0.03)
        self.fail("не дождались: " + what)

    def connect(self):
        st, out = self.api("POST", "telegram", {"token": BOT, "chat": CHAT})
        self.assertEqual(st, 200, out)
        return out

    def texts(self):
        return [b["text"] for b in self.tg.sent()]


class Setup(Bot):
    def test_starts_empty(self):
        st, out = self.api("GET", "telegram")
        self.assertEqual((st, out["token"], out["chat"], out["running"]), (200, False, None, False))

    def test_rejects_malformed_token_and_chat(self):
        st, out = self.api("POST", "telegram", {"token": "не токен"})
        self.assertEqual(st, 400)
        st, out = self.api("POST", "telegram", {"token": BOT})
        self.assertEqual((st, out["username"], out["pairing"]), (200, "tapok_bot", True), "чата нет: бот слушает и ждёт /start")
        st, out = self.api("POST", "telegram", {"chat": "abc"})
        self.assertEqual(st, 400)

    def test_telegram_refuses_token(self):
        st, out = self.api("POST", "telegram", {"token": "111111111:" + "C" * 35})
        self.assertEqual(st, 400)
        self.assertIn("токен", out["error"])
        self.assertEqual(self.api("GET", "telegram")[1]["token"], False, "неверный токен не сохраняется")

    def test_token_and_chat_start_bot_and_send_hello_without_leaking_token(self):
        out = self.connect()
        self.assertEqual((out["username"], out["chat"], out["test"]), ("tapok_bot", CHAT, "ok"))
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот запущен")
        self.assertIn("TapokHub подключён", self.texts()[0])
        for body in (out, self.api("GET", "telegram")[1]):
            self.assertNotIn(BOT, json.dumps(body))
            self.assertNotIn("A" * 20, json.dumps(body))

    def test_hello_failure_is_reported_but_settings_are_kept(self):
        self.tg.blocked.add(CHAT)
        out = self.connect()
        self.assertIn("Forbidden", out["test"])
        self.assertEqual(self.api("GET", "telegram")[1]["chat"], CHAT)

    def test_clear_stops_the_bot(self):
        self.connect()
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот запущен")
        st, out = self.api("POST", "telegram", {"clear": True})
        self.assertEqual((out["token"], out["chat"], out["running"]), (False, None, False))
        n = len(self.tg.sent("getUpdates"))
        time.sleep(0.3)
        self.assertLessEqual(len(self.tg.sent("getUpdates")) - n, 2, "после отключения опрос прекращается")

    def test_revoked_token_stops_the_bot(self):
        self.connect()
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот запущен")
        del self.tg.tokens[BOT]
        self.wait(lambda: not self.api("GET", "telegram")[1]["running"], "бот остановлен после 401")
        self.tg.tokens[BOT] = "tapok_bot"

    def test_token_of_another_user_is_refused(self):
        self.connect()
        self.proxy.store.conn().execute("INSERT INTO telegram(user_id,token,chat,username,updated_at) VALUES(2,?,?,?,0)", (OTHER_BOT, "1", "other_bot"))
        c = self.proxy.telegram
        st, out = c.handle("POST", {"token": OTHER_BOT}, 1)
        self.assertEqual(st, 409)

    def test_bot_survives_restart_of_the_server(self):
        self.connect()
        self.bots.stop()
        self.bots.start()
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот запущен после перезапуска")

    def test_needs_a_valid_user_token(self):
        self.assertEqual(self.api("GET", "telegram", token="wrong" * 5)[0], 404)


class Pairing(Bot):
    """Номер чата вводить не нужно: после токена достаточно написать боту /start."""

    def token_only(self):
        st, out = self.api("POST", "telegram", {"token": BOT})
        self.assertEqual(st, 200, out)
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот запущен")
        return out

    def test_start_binds_the_private_chat(self):
        out = self.token_only()
        self.assertEqual((out["chat"], out["pairing"]), (None, True))
        self.tg.say(CHAT, "/start")
        self.wait(lambda: self.api("GET", "telegram")[1]["chat"] == CHAT, "чат привязан")
        st = self.api("GET", "telegram")[1]
        self.assertEqual((st["pairing"], st["running"]), (False, True))
        self.wait(lambda: any("Чат привязан" in t for t in self.texts()), "ответ о привязке")
        self.assertEqual(self.proxy.telegram.workers[1].chat, CHAT, "бот сразу отвечает в этом чате")
        self.world.data["search"] = [dict(self.world.data["movies"][1000], media_type="movie")]
        self.tg.say(CHAT, "часть")
        self.wait(lambda: any(b.get("reply_markup") for b in self.tg.sent()), "поиск работает без ввода номера")

    def test_second_start_does_not_rebind(self):
        self.token_only()
        self.tg.say(CHAT, "/start")
        self.wait(lambda: self.api("GET", "telegram")[1]["chat"] == CHAT, "чат привязан")
        n = len(self.texts())
        self.tg.say("777", "/start")
        self.tg.say("777", "часть")
        self.tg.say("777", "/id")
        self.wait(lambda: any("Номер этого чата: 777" in t for t in self.texts()), "ответ на /id")
        time.sleep(0.2)
        self.assertEqual(len(self.texts()) - n, 1, "чужой /start молча игнорируется")
        self.assertEqual(self.api("GET", "telegram")[1]["chat"], CHAT)

    def test_group_chat_is_not_bound_by_start(self):
        self.token_only()
        self.tg.say("-100500", "/start", kind="supergroup")
        self.wait(lambda: any("только личный чат" in t for t in self.texts()), "отказ для группы")
        self.assertIsNone(self.api("GET", "telegram")[1]["chat"])

    def test_closed_window_does_not_bind(self):
        self.token_only()
        self.proxy.store.conn().execute("UPDATE telegram SET pair_until=0")
        self.assertFalse(self.api("GET", "telegram")[1]["pairing"])
        self.tg.say(CHAT, "/start")
        self.wait(lambda: any("Привязка закрыта" in t for t in self.texts()), "подсказка")
        self.assertIsNone(self.api("GET", "telegram")[1]["chat"])

    def test_pair_button_reopens_the_window_and_rebinds(self):
        self.connect()
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот запущен")
        self.assertFalse(self.api("GET", "telegram")[1]["pairing"], "чат уже привязан: окно закрыто")
        st, out = self.api("POST", "telegram", {"pair": True})
        self.assertEqual((st, out["pairing"], out["chat"]), (200, True, CHAT))
        self.tg.say("888", "/start")
        self.wait(lambda: self.api("GET", "telegram")[1]["chat"] == "888", "чат перепривязан")
        self.assertFalse(self.api("GET", "telegram")[1]["pairing"])

    def test_pair_needs_a_token(self):
        st, out = self.api("POST", "telegram", {"pair": True})
        self.assertEqual(st, 400)

    def test_id_works_before_binding(self):
        self.token_only()
        self.tg.say("4242", "/id")
        self.wait(lambda: any("Номер этого чата: 4242" in t for t in self.texts()), "ответ на /id")
        self.assertIsNone(self.api("GET", "telegram")[1]["chat"], "/id ничего не привязывает")

    def test_bot_answers_in_the_language_of_the_sender(self):
        self.token_only()
        self.tg.push(message={"chat": {"id": 4242, "type": "private"}, "from": {"id": 4242, "language_code": "en"}, "text": "/id"})
        self.wait(lambda: any("This chat’s number: 4242" in t for t in self.texts()), "ответ на /id по-английски")
        self.tg.push(message={"chat": {"id": 4243, "type": "private"}, "from": {"id": 4243, "language_code": "uk"}, "text": "/id"})
        self.wait(lambda: any("Номер этого чата: 4243" in t for t in self.texts()), "ответ на /id по-русски (украинский язык даёт русский)")

    def test_api_errors_follow_accept_language(self):
        import http.client
        for lang, want in (("en", "does not look like a bot token"), ("ru", "не похоже на токен бота"), (None, "не похоже на токен бота")):
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
            headers = {"Content-Type": "application/json"}
            if lang:
                headers["Accept-Language"] = lang
            c.request("POST", f"/tmdb/{tl.TOKEN}/lib/telegram", body=json.dumps({"token": "не токен"}).encode(), headers=headers)
            r = c.getresponse()
            body = json.loads(r.read())
            c.close()
            self.assertEqual(r.status, 400)
            self.assertIn(want, body["error"], lang)

    def test_manual_chat_closes_the_window(self):
        self.token_only()
        st, out = self.api("POST", "telegram", {"chat": "999"})
        self.assertEqual((out["chat"], out["pairing"]), ("999", False))

    def test_bot_without_chat_survives_restart(self):
        self.token_only()
        self.bots.stop()
        self.bots.start()
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот без чата запущен после перезапуска")


class Chat(Bot):
    def setUp(self):
        super().setUp()
        self.world.data["search"] = [dict(self.world.data["movies"][1000], media_type="movie"), {"id": 999, "media_type": "person", "name": "Актёр"},
                                     dict(self.world.data["tv"][3000], media_type="tv")]
        self.connect()
        self.wait(lambda: self.api("GET", "telegram")[1]["running"], "бот запущен")

    def test_search_shows_movies_and_series_only(self):
        self.tg.say(CHAT, "часть 1")
        self.wait(lambda: any(b.get("reply_markup") for b in self.tg.sent()), "результаты поиска")
        kb = [b["reply_markup"] for b in self.tg.sent() if b.get("reply_markup")][0]["inline_keyboard"]
        self.assertEqual([r[0]["callback_data"] for r in kb], ["pick:m:1000", "pick:t:3000"])

    def test_pick_add_and_remove_change_the_library(self):
        self.tg.press(CHAT, "pick:m:1000")
        self.wait(lambda: self.tg.sent("editMessageText"), "карточка")
        card = self.tg.sent("editMessageText")[-1]
        self.assertIn("В библиотеке: нет", card["text"])
        self.assertEqual(card["reply_markup"]["inline_keyboard"][0][0]["callback_data"], "add:m:1000")

        self.tg.press(CHAT, "add:m:1000")
        self.wait(lambda: any("✅ Добавлено" in b["text"] for b in self.tg.sent("editMessageText")), "добавлено")
        items = self.api("GET", "items")[1]["items"]
        self.assertEqual([i["id"] for i in items], [1000])
        card = self.tg.sent("editMessageText")[-1]
        self.assertIn("В библиотеке: да", card["text"])
        self.assertEqual(card["reply_markup"]["inline_keyboard"][0][0]["callback_data"], "del:m:1000")

        self.tg.press(CHAT, "del:m:1000")
        self.wait(lambda: any("🗑 Убрано" in b["text"] for b in self.tg.sent("editMessageText")), "убрано")
        self.assertEqual(self.api("GET", "items")[1]["items"], [])

    def test_track_and_untrack_collection(self):
        self.tg.press(CHAT, "fr:m:1000")
        self.wait(lambda: any("Коллекция добавлена" in b["text"] for b in self.tg.sent("editMessageText")), "коллекция добавлена")
        self.assertTrue(self.lib.wait_idle(20))
        self.assertEqual(len(self.api("GET", "franchises")[1]["franchises"]), 1)
        self.tg.press(CHAT, "unfr:m:1000")
        self.wait(lambda: any("больше не отслеживается" in b["text"] for b in self.tg.sent("editMessageText")), "коллекция убрана")
        self.assertEqual(self.api("GET", "franchises")[1]["franchises"], [])

    def test_library_and_regen_commands(self):
        self.api("POST", "items/add", {"kind": "movie", "id": 1000})
        self.tg.say(CHAT, "/library")
        self.wait(lambda: any(t.startswith("Библиотека") for t in self.texts()), "сводка")
        self.assertIn("Фильмы: 1", [t for t in self.texts() if t.startswith("Библиотека")][0])
        self.tg.say(CHAT, "/regen@tapok_bot")
        self.wait(lambda: any("Обновление коллекций" in t for t in self.texts()), "обновление")

    def test_other_chats_are_ignored_except_id(self):
        n = len(self.texts())
        self.tg.say("777", "часть 1")
        self.tg.say("777", "/library")
        self.tg.press("777", "add:m:1000")
        self.tg.say("777", "/id")
        self.wait(lambda: any("Номер этого чата: 777" in t for t in self.texts()), "ответ на /id")
        time.sleep(0.2)
        self.assertEqual(len(self.texts()) - n, 1, "на чужие сообщения кроме /id бот не отвечает")
        self.assertEqual(self.api("GET", "items")[1]["items"], [], "чужая кнопка ничего не добавляет")

    def test_unknown_and_empty_search(self):
        self.world.data["search"] = []
        self.tg.say(CHAT, "ничего такого")
        self.wait(lambda: "Ничего не найдено." in self.texts(), "пустой поиск")
        self.tg.say(CHAT, "/что-то")
        self.wait(lambda: any("Напишите название" in t for t in self.texts()), "подсказка")

    def test_bot_survives_a_cut_off_response(self):
        self.tg.cut_next = 2
        self.wait(lambda: self.tg.cut_next == 0, "обрывы прошли")
        self.tg.say(CHAT, "/library")
        self.wait(lambda: any(t.startswith("Библиотека") for t in self.texts()), "бот отвечает после обрывов связи")
        self.assertTrue(self.api("GET", "telegram")[1]["running"])

    def test_limits_are_reported_in_the_chat(self):
        self.lib.ITEMS_MAX = 0
        self.tg.press(CHAT, "add:m:1000")
        self.wait(lambda: any("⚠" in b["text"] and "предел" in b["text"] for b in self.tg.sent("editMessageText")), "сообщение о пределе")
        self.assertEqual(self.api("GET", "items")[1]["items"], [])

    def test_admin_commands_list_and_clear(self):
        import contextlib, io
        from types import SimpleNamespace
        from tapokhub.cli import telegram_cli
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            telegram_cli(self.proxy, SimpleNamespace(top="list"))
        self.assertIn("@tapok_bot", out.getvalue())
        self.assertIn(CHAT, out.getvalue())
        self.assertNotIn("A" * 20, out.getvalue(), "токен не печатается")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(telegram_cli(self.proxy, SimpleNamespace(top="clear", ref="1")), 0)
        self.assertFalse(self.api("GET", "telegram")[1]["token"])

    def test_bad_callback_data_is_harmless(self):
        for data in ("add:x:1", "add:m:abc", "boom", "add:m:1000:2"):
            self.tg.press(CHAT, data)
        self.tg.say(CHAT, "/library")
        self.wait(lambda: any(t.startswith("Библиотека") for t in self.texts()), "бот жив после мусора")


if __name__ == "__main__":
    unittest.main()
