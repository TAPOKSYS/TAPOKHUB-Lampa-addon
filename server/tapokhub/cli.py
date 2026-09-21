"""TapokHub: сервер и команды администратора.

  serve                      запустить сервер (по умолчанию)
  stats                      состояние кеша и сервера
  users ...                  пользователи, токены устройств, вход через CUB, регистрация
  library ...                коллекции-франшизы
  collections ...            коллекции главного экрана
  telegram ...               Telegram-боты пользователей
  warm, refresh-key          прогрев кеша, обновление ключа TMDB
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import secrets
import sys
import threading
import time

from tapokhub import __version__
from tapokhub.core.config import load_config
from tapokhub.modules.api import create_server
from tapokhub.modules.proxy import Proxy
from tapokhub.modules.users import OWNER
from tapokhub.core.i18n import tr

log = logging.getLogger("tapokhub")


def warm_loop(proxy: Proxy, stop: threading.Event) -> None:
    stop.wait(20)  # дать сервису подняться и принять первые запросы
    while not stop.is_set():
        try:
            proxy.warm()
        except Exception:  # noqa: BLE001
            log.exception(tr("прогрев упал"))
        try:
            n = proxy.library.refresh_all()      # ежедневное отслеживание франшиз
            if n:
                log.info(tr("библиотека: на обновление поставлено франшиз: %d"), n)
        except Exception:  # noqa: BLE001
            log.exception(tr("обновление библиотеки упало"))
        stop.wait(proxy.cfg.warm_interval)


# ---------------------------------------------------------------- CLI


def users_cli(proxy: Proxy, args) -> int:
    u = proxy.users
    if args.uop == "list":
        for x in u.list_users():
            state = tr(" (отключён)") if x["disabled"] else ""
            print(tr("[{x_id}] {x_name}  {v5}{state}", x_id=x['id'], x_name=x['name'], v5=x['email'] or tr('почта не задана'), state=state))
            for d in x["devices"]:
                seen = time.strftime("%Y-%m-%d %H:%M", time.localtime(d["last_seen"])) if d["last_seen"] else tr("не использовался")
                print(tr("      устройство {d_id}: {v3}  [{d_source}]  {seen}", d_id=d['id'], v3=d['label'] or '-', d_source=d['source'], seen=seen))
        return 0
    if args.uop == "add":
        uid = u.add_user(args.email, args.name)
        print(tr("разрешён вход через CUB: {email} (пользователь {uid})", email=args.email, uid=uid))
        return 0
    if args.uop in ("email", "token", "disable", "enable"):
        row = u.find(args.ref)
        if not row:
            print(tr("нет такого пользователя"), file=sys.stderr)
            return 1
        if args.uop == "email":
            u.set_email(row["id"], args.email)
            print(tr("почта пользователя {row_id}: {norm_email}", row_id=row['id'], norm_email=u.norm_email(args.email)))
        elif args.uop == "token":
            print(u.issue_token(row["id"], args.label or tr("выдан вручную"), "manual"))
        else:
            u.set_disabled(row["id"], args.uop == "disable")
            print(tr("готово"))
        return 0
    if args.uop == "settings":
        row = u.find(args.ref)
        if not row:
            print(tr("нет такого пользователя"), file=sys.stderr)
            return 1
        got = proxy.library.settings_get(row["id"])
        for k in sorted(got):
            print(f"{k} = {got[k]['value']}    ({time.strftime('%Y-%m-%d %H:%M', time.localtime(got[k]['at'] / 1000))})")
        if not got:
            print(tr("настроек нет: плагин ещё ничего не синхронизировал"))
        return 0
    if args.uop == "limit":
        row = u.find(args.ref)
        if not row:
            print(tr("нет такого пользователя"), file=sys.stderr)
            return 1
        lib = proxy.library
        caps = {} if args.clear else lib.user_caps(row["id"])
        for key, val in (("movie", args.movies), ("tv", args.tv), ("franchise", args.franchises)):
            if val is not None:
                caps.pop(key, None)
                if val > 0:
                    caps[key] = val
        if args.clear or args.movies is not None or args.tv is not None or args.franchises is not None:
            caps = lib.set_user_caps(row["id"], caps)
        names = {"movie": tr("фильмов"), "tv": tr("сериалов"), "franchise": tr("коллекций")}
        print(tr("пользователь {row_id}: ", row_id=row['id']) + (", ".join(tr("{v0} не больше {v}", v0=names[k], v=v) for k, v in caps.items()) if caps else tr("своих пределов нет (действуют общие)")))
        return 0
    if args.uop == "registration":
        u.set_registration(args.mode == "open")
        print(tr("регистрация"), tr("открыта") if args.mode == "open" else tr("закрыта: войти смогут только добавленные (`users add`)"))
        return 0
    if args.uop == "merge":
        a, b = u.find(args.src), u.find(args.dst)
        if not a or not b:
            print(tr("нет такого пользователя"), file=sys.stderr)
            return 1
        try:
            u.merge(a["id"], b["id"])
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1
        print(tr("пользователь {a_id} слит в {b_id}", a_id=a['id'], b_id=b['id']))
        for gone, keep in proxy.library.dedupe(b["id"]):       # у слитых пользователей бывают одни и те же коллекции: остаётся старая
            print(tr("  убран дубль коллекции {gone} (осталась {keep})", gone=gone, keep=keep))
        return 0
    if args.uop == "domain":
        if args.dop == "list":
            print(tr("встроенные:"), ", ".join(u.cub_domains))
            print(tr("добавленные:"), ", ".join(u.extra_domains()) or tr("нет"))
        elif args.dop == "add":
            try:
                print(tr("добавлен:"), u.add_domain(args.name, http=args.http), "(http)" if args.http else "")
            except ValueError as e:
                print(e, file=sys.stderr)
                return 1
        else:
            print(tr("убран") if u.remove_domain(args.name) else tr("такого нет среди добавленных"))
        return 0
    if args.uop == "revoke":
        print(tr("отозван") if u.revoke(args.device) else tr("нет такого устройства"))
        return 0
    return 2


def telegram_cli(proxy: Proxy, args) -> int:
    if args.top == "list":
        rows = proxy.store.conn().execute("SELECT t.*, u.email FROM telegram t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.user_id").fetchall()
        for r in rows:
            print(tr("[{r_user_id}] {v3}  @{v5}  чат: {v7}", r_user_id=r['user_id'], v3=r['email'] or tr('почта не задана'), v5=r['username'] or '?', v7=r['chat'] or tr('не привязан')))
        if not rows:
            print(tr("ботов нет"))
        return 0
    row = proxy.users.find(args.ref)
    if not row:
        print(tr("нет такого пользователя"), file=sys.stderr)
        return 1
    proxy.store.conn().execute("DELETE FROM telegram WHERE user_id=?", (row["id"],))
    print(tr("бот отключён (запущенный сервер перестанет отвечать при следующей перезагрузке; сразу — через настройки плагина или перезапуск сервиса)"))
    return 0


def print_franchise(d: dict) -> None:
    c = d["counts"]
    print(tr("[{d_id}] {d_title}  ({d_status}; видимых {c_visible}, скрытых {c_hidden}, новых {c_new}; wikidata {d_wikidata})", d_id=d['id'], d_title=d['title'], d_status=d['status'], c_visible=c['visible'], c_hidden=c['hidden'], c_new=c['new'], d_wikidata=d['wikidata']))
    for g in d.get("groups", []):
        print(tr("  ── {g_title} ({len}{v4})", g_title=g['title'], len=len(g['items']), v4=tr(', скрыто ') + str(g['hidden_count']) if g['hidden_count'] else ''))
        for it in g["items"]:
            date_ = it.get("release_date") or it.get("first_air_date") or "----"
            mark = "×" if it["hidden"] else ("NEW" if it["is_new"] else " ")
            print(f"     {mark:3s} {date_[:10]}  {(it.get('title') or it.get('name'))[:60]}  [{it['media_type']} {it['id']}]")


def show_library(proxy: "Proxy", args) -> None:
    lib = proxy.library
    if args.lop == "list":
        for f in lib.rows("SELECT * FROM franchises WHERE merged_into IS NULL ORDER BY id"):
            s = lib.franchise_summary(f)
            print(f"[{s['id']}] {s['title']}  {s['status']}  {s['counts']}")
    elif args.lop == "resolve":
        lib.start()
        f = lib.create(args.kind, args.id)
        print(tr("собираю (Wikidata просит не частить, это может занять минуту-две)…"))
        lib.wait_idle(900)
        fid = f["id"]
        d = lib.franchise_detail(fid, include_hidden=True)
        if d.get("merged_into"):
            d = lib.franchise_detail(d["merged_into"], include_hidden=True)
        if d["status"] == "needs_choice":
            print(tr("нужен выбор франшизы:"), json.dumps(d["choices"], ensure_ascii=False))
        elif d["status"] == "error":
            print(tr("ошибка:"), d["error"])
        else:
            print_franchise(d)
    elif args.lop == "show":
        d = lib.franchise_detail(args.fid, include_hidden=args.hidden)
        print_franchise(d) if d else print(tr("нет такой франшизы"))
    elif args.lop == "dedupe":
        found = lib.dedupe(args.user, dry=args.dry)
        for gone, keep in found:
            print((tr("найден дубль ") if args.dry else tr("убран дубль ")) + tr("{gone}, осталась {keep}", gone=gone, keep=keep))
        print(tr("итого: {len}", len=len(found)))
    elif args.lop == "logos":
        for f in lib.rows("SELECT id, title FROM franchises WHERE status='ready'"):
            lib.ensure_logo(f["id"], force=True)
            print(f["id"], f["title"], "->", lib.franchise(f["id"])["logo"] or tr("нет логотипа"))
    elif args.lop == "refresh-all":
        print(tr("поставлено на обновление:"), lib.refresh_all(min_age=0))
        lib.start()
        lib.wait_idle(900)


def apply_first_start(proxy: Proxy, cfg) -> None:
    """Настройки из окружения, которые применяются один раз (контейнер): регистрация на новой базе и почта администратора."""
    if cfg.registration and proxy.store.meta_get("registration") is None:
        proxy.users.set_registration(cfg.registration == "open")
        log.info(tr("регистрация: %s"), tr("открыта") if cfg.registration == "open" else tr("закрыта"))
    if cfg.admin_email:
        owner = proxy.users.user(OWNER)
        if owner is not None and not owner["email"]:
            try:
                proxy.users.set_email(OWNER, cfg.admin_email)
                log.info(tr("почта администратора: %s"), cfg.admin_email)
            except ValueError as e:
                log.warning(tr("TAPOK_ADMIN_EMAIL не применена: %s"), e)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=tr(__doc__), formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version=f"tapokhub {__version__}")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("serve")
    sub.add_parser("warm")
    sub.add_parser("refresh-key")
    sub.add_parser("stats")
    col = sub.add_parser("collections")
    cs = col.add_subparsers(dest="op", required=True)
    cs.add_parser("list")
    add = cs.add_parser("add")
    add.add_argument("id")
    add.add_argument("title")
    add.add_argument("tmdb_collection", type=int)
    add.add_argument("--extra", action="append", default=[], help=tr("type:id, например movie:384018"))
    rm = cs.add_parser("remove")
    rm.add_argument("id")
    lib = sub.add_parser("library")
    ls = lib.add_subparsers(dest="lop", required=True)
    ls.add_parser("list")
    r = ls.add_parser("resolve", help=tr("создать франшизу от позиции и дождаться сборки"))
    r.add_argument("kind", choices=["movie", "tv"])
    r.add_argument("id", type=int)
    sh = ls.add_parser("show")
    sh.add_argument("fid", type=int)
    sh.add_argument("--hidden", action="store_true")
    ls.add_parser("refresh-all")
    ls.add_parser("logos")
    dd = ls.add_parser("dedupe", help=tr("убрать одинаковые коллекции пользователя (остаётся самая старая)"))
    dd.add_argument("--user", type=int, default=1)
    dd.add_argument("--dry", action="store_true", help=tr("только показать"))
    tg = sub.add_parser("telegram", help=tr("Telegram-боты пользователей")).add_subparsers(dest="top", required=True)
    tg.add_parser("list", help=tr("у кого подключён бот (токен не показывается)"))
    tgc = tg.add_parser("clear", help=tr("отключить бота пользователя (сервер забудет токен и чат)"))
    tgc.add_argument("ref", help=tr("номер или почта"))
    us = sub.add_parser("users", help=tr("пользователи и токены устройств")).add_subparsers(dest="uop", required=True)
    us.add_parser("list")
    ua = us.add_parser("add", help=tr("заранее завести пользователя по почте (нужно при закрытой регистрации)"))
    ua.add_argument("email")
    ua.add_argument("--name")
    ue = us.add_parser("email", help=tr("задать почту существующему пользователю (например, владельцу: 1)"))
    ue.add_argument("ref")
    ue.add_argument("email")
    ut = us.add_parser("token", help=tr("выдать токен устройства (для ручного ввода в настройках плагина)"))
    ut.add_argument("ref", help=tr("номер или почта"))
    ut.add_argument("--label", default="")
    ur = us.add_parser("revoke", help=tr("отозвать токен устройства по номеру из `users list`"))
    ur.add_argument("device", type=int)
    ud = us.add_parser("disable")
    ud.add_argument("ref")
    uen = us.add_parser("enable")
    uen.add_argument("ref")
    uset = us.add_parser("settings", help=tr("настройки плагина пользователя (то, что плагин синхронизирует с сервера)"))
    uset.add_argument("ref", help=tr("номер или почта"))
    ul = us.add_parser("limit", help=tr("свои пределы пользователя (сильнее общих TAPOK_LIMIT_*, действуют и на владельца); без ключей показывает текущие"))
    ul.add_argument("ref", help=tr("номер или почта"))
    ul.add_argument("--movies", type=int, help=tr("фильмов в библиотеке; 0 = снять этот предел"))
    ul.add_argument("--tv", type=int, help=tr("сериалов в библиотеке; 0 = снять"))
    ul.add_argument("--franchises", type=int, help=tr("коллекций франшиз; 0 = снять"))
    ul.add_argument("--clear", action="store_true", help=tr("убрать все свои пределы пользователя"))
    ureg = us.add_parser("registration", help=tr("открыта ли регистрация новых пользователей при входе через CUB"))
    ureg.add_argument("mode", choices=["open", "closed"])
    umg = us.add_parser("merge", help=tr("слить пользователя FROM в TO (устройства и данные переходят к TO)"))
    umg.add_argument("src")
    umg.add_argument("dst")
    udm = us.add_parser("domain", help=tr("зеркала CUB, которым доверяем при входе")).add_subparsers(dest="dop", required=True)
    udm.add_parser("list")
    udd = udm.add_parser("add")
    udd.add_argument("name")
    udd.add_argument("--http", action="store_true", help=tr("зеркало открывается только по http (порт 443 закрыт)"))
    udm.add_parser("remove").add_argument("name")
    args = ap.parse_args(argv)

    logging.basicConfig(level=os.environ.get("TAPOK_LOG", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()
    cmd = args.cmd or "serve"

    if cmd == "serve":
        if (not cfg.token or len(cfg.token) < 16) and cfg.auto_token and not cfg.token_file.exists():
            cfg.token_file.parent.mkdir(parents=True, exist_ok=True)
            cfg.token = secrets.token_hex(24)
            fd = os.open(cfg.token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(cfg.token)
            log.info(tr("создан токен доступа, он лежит в файле %s"), cfg.token_file)
        if not cfg.token or len(cfg.token) < 16:
            print(tr("нужен токен (TAPOK_TOKEN, файл токена или TAPOK_AUTO_TOKEN=1; не короче 16 символов)"), file=sys.stderr)
            return 2
        try:
            server, proxy = create_server(cfg)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 2
        apply_first_start(proxy, cfg)
        proxy.library.start()
        proxy.telegram.start()
        stop = threading.Event()
        threading.Thread(target=warm_loop, args=(proxy, stop), daemon=True).start()
        log.info(tr("слушаю %s:%s, данные: %s"), cfg.listen_host, cfg.listen_port, cfg.data_dir)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            stop.set()
            server.server_close()
        return 0

    proxy = Proxy(cfg)
    if cmd == "stats":
        print(json.dumps(proxy.health(), ensure_ascii=False, indent=2))
    elif cmd == "warm":
        print(json.dumps(proxy.warm(), ensure_ascii=False))
    elif cmd == "refresh-key":
        print(tr("ключ обновлён из Lampa") if proxy.refresh_key_from_lampa() else tr("не удалось"))
    elif cmd == "library":
        show_library(proxy, args)
    elif cmd == "users":
        return users_cli(proxy, args)
    elif cmd == "telegram":
        return telegram_cli(proxy, args)
    elif cmd == "collections":
        c = proxy.store.conn()
        if args.op == "list":
            for r in proxy.collections():
                print(f"{r['id']:20s} tmdb={r['tmdb_collection']:<8} {r['title']}  extras={r['extras']}")
        elif args.op == "add":
            extras = []
            for e in args.extra:
                t, _, i = e.partition(":")
                extras.append({"type": t, "id": int(i)})
            pos = c.execute("SELECT COALESCE(MAX(position),0)+1 p FROM collections").fetchone()["p"]
            c.execute("INSERT OR REPLACE INTO collections VALUES(?,?,?,?,?)", (args.id, args.title, args.tmdb_collection, json.dumps(extras), pos))
            print(tr("добавлено:"), args.id)
        elif args.op == "remove":
            n = c.execute("DELETE FROM collections WHERE id=?", (args.id,)).rowcount
            print(tr("удалено") if n else tr("не найдено"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
