"""Регрессии аудита: изоляция входа, атомарное объединение и освобождение ресурсов."""
import os as _os
_os.environ["TAPOK_LANG"] = "ru"      # тесты проверяют русские тексты; английские: test_i18n.py
import http.client
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tapokhub.core.config import Config
from tapokhub.modules.api import create_server, make_handler
from tapokhub.modules.users import LoginError


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server, self.proxy = create_server(Config(data_dir=Path(self.tmp.name), listen_port=0))

    def tearDown(self):
        self.server.server_close()
        self.tmp.cleanup()

    def test_spoofed_forwarding_headers_do_not_reset_login_limit(self):
        def denied(*args):
            raise LoginError(403, 'test account denied')
        self.proxy.users.cub_profile = denied
        thread = threading.Thread(target=self.server.serve_forever)
        thread.start()
        try:
            statuses = []
            for i in range(14):
                conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
                conn.request('POST', '/tmdb/auth/cub', '{}', {
                    'CF-Connecting-IP': '192.0.2.' + str(i),
                    'X-Forwarded-For': '198.51.100.' + str(i)})
                response = conn.getresponse()
                statuses.append(response.status)
                response.read()
                conn.close()
            self.assertEqual(statuses, [403] * 12 + [429, 429])
        finally:
            self.server.shutdown()
            thread.join()

    def test_only_loopback_proxy_may_supply_real_ip(self):
        handler = make_handler(self.proxy).__new__(make_handler(self.proxy))
        handler.headers = {'X-Real-IP': '192.0.2.99'}
        handler.client_address = ('198.51.100.1', 123)
        self.assertEqual(handler.client_ip(), '198.51.100.1')
        handler.client_address = ('127.0.0.1', 123)
        self.assertEqual(handler.client_ip(), '192.0.2.99')

    def test_configured_proxy_may_supply_real_ip_and_others_still_may_not(self):
        import dataclasses
        proxy = self.proxy
        proxy.cfg = dataclasses.replace(proxy.cfg, trusted_proxies=('172.29.0.250',))
        handler = make_handler(proxy).__new__(make_handler(proxy))
        handler.headers = {'X-Real-IP': '192.0.2.99'}
        handler.client_address = ('172.29.0.250', 123)
        self.assertEqual(handler.client_ip(), '192.0.2.99')
        handler.client_address = ('172.29.0.3', 123)
        self.assertEqual(handler.client_ip(), '172.29.0.3')

    def test_merge_moves_settings_and_torrents_and_keeps_newest_conflicts(self):
        p = self.proxy
        src = p.users.add_user('source@example.test')
        dst = p.users.add_user('target@example.test')
        token = p.users.issue_token(src)
        for uid, at, magnet in [(src, 10, 'source'), (dst, 20, 'target')]:
            with patch('tapokhub.modules.library.time.time', return_value=at):
                p.library.choose(uid, 'movie', 1, {'MagnetUri': magnet})
                p.library.settings_set(uid, {'tapokhub_play_auto': magnet})
        p.library.choose(src, 'movie', 2, {'MagnetUri': 'only-source'})
        p.library.settings_set(src, {'tapokhub_anim_crt': 'true'})
        p.users.merge(src, dst)
        self.assertIsNone(p.users.user(src))
        self.assertEqual(p.users.authenticate(token), dst)
        choices = {x['id']: x['MagnetUri'] for x in p.library.choices(dst)}
        self.assertEqual(choices, {1: 'target', 2: 'only-source'})
        self.assertEqual(p.library.settings_get(dst)['tapokhub_play_auto']['value'], 'target')
        self.assertEqual(p.library.settings_get(dst)['tapokhub_anim_crt']['value'], 'true')
        self.assertEqual(p.library.choices(src), [])
        self.assertEqual(p.library.settings_get(src), {})

    def test_failed_merge_rolls_back_every_table(self):
        p = self.proxy
        src = p.users.add_user('source@example.test')
        token = p.users.issue_token(src)
        p.library.settings_set(src, {'tapokhub_anim_crt': 'true'})
        p.store.conn().execute("CREATE TRIGGER fail_merge BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            p.users.merge(src, 1)
        self.assertIsNotNone(p.users.user(src))
        self.assertEqual(p.users.authenticate(token), src)
        self.assertEqual(p.library.settings_get(src)['tapokhub_anim_crt']['value'], 'true')
        self.assertEqual(p.library.settings_get(1), {})

    def test_close_stops_worker_and_releases_sqlite(self):
        p = self.proxy
        p.library.start()
        worker = p.library.thread
        connection = p.store.conn()
        self.server.server_close()
        self.assertFalse(worker.is_alive())
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute('SELECT 1')


if __name__ == '__main__':
    unittest.main(verbosity=2)
