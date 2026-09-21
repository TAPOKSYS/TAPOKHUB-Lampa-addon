# Установка TapokHub

🇷🇺 Русский · 🇬🇧 [English](en/INSTALL.md)

TapokHub работает в Docker: один контейнер с сервером, он сам отдаёт плагин для Lampa, картинки и API. Образы для `amd64` и `arm64`
(обычные серверы, мини-ПК, NAS, Raspberry Pi). Краткая версия с одной командой: в [README](../README.md#быстрый-старт).

## Что нужно заранее

| Что | Подробности |
|---|---|
| Сервер | Linux с доступом root (`sudo`), 1 ГБ памяти и 5 ГБ диска хватит на старт. **Docker ставить заранее не нужно**: установщик поставит сам |
| Домен | для HTTPS: например `tapok.example.com`, в DNS **A-запись** на IP сервера. Lampa, открытая по https, загружает плагин только с https. **Без домена** работает по http |
| Порты | с доменом 80 и 443 свободны и открыты; без домена один порт (по умолчанию 8080) |
| Почта | ваша: с ней вы входите в плагин через аккаунт CUB как администратор |
| Lampa | версия 3.0.5 или новее |

## Установка одной командой

С доменом и HTTPS (сертификат Let's Encrypt, продлевается сам):

```bash
curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --domain tapok.example.com --email you@example.com
```

Без домена, по http (для домашней сети):

```bash
curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --email you@example.com
```

| Параметр | Что значит |
|---|---|
| `--domain` | домен сервера: включает HTTPS |
| `--email` | почта администратора |
| `--port` | порт без домена (по умолчанию 8080) |
| `--version 0.10.0` | конкретная версия образа вместо самой новой |
| `--dir` | куда положить настройки (по умолчанию `/opt/tapokhub`) |

**Что делает установщик** (`install.sh` в корне репозитория, его можно прочитать до запуска):
1. Ставит Docker, если его нет (официальным скриптом get.docker.com).
2. Кладёт `compose.yaml` и `.env` в `/opt/tapokhub`. Настройки хранятся в `.env` (доступ только у root).
3. Скачивает образ и запускает контейнер `tapokhub` (с доменом ещё и Caddy для HTTPS), ждёт ответа `/healthz`.
4. Ставит команду администратора `tapokhub` и записывает вашу почту.
5. Печатает адрес плагина.

Регистрация на новом сервере **закрыта**: войти могут вы и те, кого вы добавите. Повторный запуск той же команды обновляет
TapokHub до самой новой версии; данные и настройки сохраняются.

## Без установщика

```bash
mkdir -p /opt/tapokhub && cd /opt/tapokhub
curl -fsSLO https://raw.githubusercontent.com/TAPOKSYS/TAPOKHUB-Lampa-addon/main/compose.yaml
docker compose up -d
```

Дальше откройте `http://адрес-сервера:8080/`: страница покажет адрес плагина. У него есть короткий вариант для ввода пультом: `http://адрес-сервера:8080/t` (то же самое, что `/tapokhub.js`; Lampa нужен адрес вместе с `http://` или `https://`). Настройки задаются в файле `.env` рядом с `compose.yaml`.
Без compose, одним контейнером:

```bash
docker run -d --name tapokhub --restart unless-stopped -p 8080:8080 -v tapokhub-data:/data ghcr.io/tapoksys/tapokhub-lampa-addon:latest
```

Команда администратора без установщика: `docker compose exec tapokhub python -m tapokhub ...` вместо `tapokhub ...`.

## Войти в плагине

В Lampa: Настройки → Расширения → Добавить плагин → адрес плагина → перезапустить Lampa. Дальше Настройки → TapokHub → Авторизация:

1. **Через аккаунт CUB.** «Войти через аккаунт CUB»: нужна почта, которую вы указали при установке (`--email`).
2. **По токену доступа.** Токен создаётся при первом запуске: `docker compose exec tapokhub cat /data/token`, вставьте его в «Ввести токен вручную».

Других людей добавляйте командой `tapokhub users add почта@example.com` или откройте регистрацию: `tapokhub users registration open`.

## Настройки

Файл `.env` рядом с `compose.yaml`, все переменные необязательные. После изменения: `docker compose up -d`.

| Переменная | Что делает |
|---|---|
| `TAPOK_PORT` | порт на сервере (по умолчанию 8080) |
| `TAPOK_BIND` | `127.0.0.1`: принимать подключения только с этого компьютера (с HTTPS через Caddy; установщик с доменом ставит сам) |
| `TAPOK_VERSION` | версия образа, например `0.10.0` (по умолчанию самая новая) |
| `TAPOK_PUBLIC_URL` | адрес, по которому Lampa ходит на сервер. Без него берётся адрес из запроса; задайте, если сервер стоит за своим прокси или доменом |
| `TAPOK_LANG` | язык сообщений сервера, журнала и команд: `ru` или `en` (без него язык системы, иначе русский) |
| `TAPOK_DOMAIN`, `COMPOSE_PROFILES=https` | включают Caddy с сертификатом для домена |
| `TAPOK_HTTP_PORT`, `TAPOK_HTTPS_PORT` | порты Caddy (по умолчанию 80 и 443) |
| `TAPOK_TRUSTED_PROXIES` | адреса прокси (через запятую), которым верим в `X-Real-IP`; в `compose.yaml` задан адрес Caddy |
| `TAPOK_ADMIN_EMAIL` | почта администратора; применяется один раз, на первом запуске |
| `TAPOK_REGISTRATION` | `closed` (по умолчанию) или `open`; применяется один раз, на первом запуске, потом `tapokhub users registration` |
| `TAPOK_RATE_LIMIT` | запросов в минуту на пользователя (по умолчанию 1200; 0 без ограничения) |
| `TAPOK_LIMIT_MOVIES`, `TAPOK_LIMIT_TV`, `TAPOK_LIMIT_FRANCHISES` | демо-сервер: сколько фильмов, сериалов и коллекций может добавить каждый пользователь, кроме владельца |
| `TAPOK_LOG` | уровень журнала: `INFO` (по умолчанию) или `DEBUG` |

## HTTPS

**Caddy из compose** (то, что включает `--domain`): сам получает и продлевает сертификат. Вручную: в `.env` строки
`TAPOK_DOMAIN=tapok.example.com`, `COMPOSE_PROFILES=https`, `TAPOK_BIND=127.0.0.1`, затем `docker compose up -d`. Выключить: убрать
`COMPOSE_PROFILES=https` и `docker compose rm -sf caddy`. Адрес посетителя Caddy передаёт в `X-Real-IP`, а сервер верит ему только от
Caddy (`TAPOK_TRUSTED_PROXIES`), поэтому ограничение попыток входа считается по настоящему адресу.

**За вашим nginx** (если он уже стоит и сам отдаёт сертификаты). Пусть контейнер слушает только этот компьютер и верит nginx: в `.env`
`TAPOK_BIND=127.0.0.1`, `TAPOK_PORT=8890`, `TAPOK_TRUSTED_PROXIES=172.29.0.250,172.29.0.1` (nginx приходит в контейнер с адреса шлюза
сети compose, `172.29.0.1`), затем `docker compose up -d`. В `server { }` добавьте:

```nginx
location / {
    proxy_pass http://127.0.0.1:8890;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_http_version 1.1;
    access_log off;                       # в адресе запросов лежит токен: в журнал его не пишем
    add_header Strict-Transport-Security "max-age=31536000" always;
}
```

Страница Lampa, открытая по `https://`, не загрузит плагин с http-адреса. Приложение Lampa на телевизоре и телефоне работает и по http
в домашней сети. Без своего прокси и Caddy ограничение попыток входа считается по адресу прокси, а не посетителя.

## Данные, обновление, откат, удаление

Всё нужное лежит в томе `/data` контейнера: база (коллекции, библиотека, пользователи), кеш картинок и токен.

```bash
cd /opt/tapokhub
docker compose pull && docker compose up -d         # обновить (или повторить команду установки)
TAPOK_VERSION=0.9.0-pre.7 docker compose up -d      # откатиться на другую версию (или --version у установщика)
docker compose logs -f                              # журнал
docker compose down                                 # остановить, данные остаются
docker compose down -v                              # остановить и УДАЛИТЬ данные
```

Копия данных (перед обновлением полезно):

```bash
docker compose stop
docker run --rm --volumes-from tapokhub -v "$PWD":/backup alpine tar czf /backup/tapokhub-data.tar.gz -C /data .
docker compose start
```

Вернуть из копии: `docker compose stop`, затем
`docker run --rm --volumes-from tapokhub -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/tapokhub-data.tar.gz -C /data'`, затем `docker compose start`.

Полностью убрать TapokHub: `docker compose down -v`, `rm -rf /opt/tapokhub /usr/local/bin/tapokhub`.

Папку вместо тома можно подключить так: `-v /srv/tapokhub:/data`, но она должна принадлежать пользователю с номером `10001`
(`chown 10001:10001 /srv/tapokhub`): контейнер работает не от root.

## Пользователи

```bash
tapokhub users list                     # кто есть, какие устройства
tapokhub users add друг@example.com     # разрешить вход (нужна почта его аккаунта CUB)
tapokhub users registration open        # разрешить всем (по умолчанию закрыта); то же: Настройки → TapokHub → «Регистрация на сервере»
tapokhub users revoke 3                 # отозвать устройство
tapokhub users token 2                  # выдать токен для ввода вручную (Настройки → TapokHub → Авторизация)
tapokhub users disable 2                # отключить пользователя
```

Полный список команд администратора: [server/README.md](../server/README.md).

## Язык

- **Плагин** берёт язык из настройки Lampa: русский, украинский и белорусский дают русский интерфейс, остальные языки английский.
- **Ответы сервера плагину** следуют заголовку `Accept-Language`, который плагин заполняет языком Lampa. **Telegram-бот** отвечает на языке Telegram того, кто ему пишет.
- **Команды администратора, журнал, страница-подсказка и установщик** используют язык по умолчанию: переменная `TAPOK_LANG` (`ru` или `en`), иначе язык системы (`LC_ALL`, `LC_MESSAGES`, `LANG`), а если ничего не задано, русский. Например: `TAPOK_LANG=en` в `.env`.
- **Описания и названия фильмов** приходят из TMDB на том языке, который Lampa запрашивает у TMDB (настройка Lampa «Язык TMDB»).
- Английская версия этого руководства: [docs/en/INSTALL.md](en/INSTALL.md).

## Разбор проблем

| Симптом | Причина и что делать |
|---|---|
| Сервер не отвечает | `cd /opt/tapokhub && docker compose ps`, `docker compose logs --tail 50`, `tapokhub stats` |
| С доменом нет сертификата | домен не указывает на сервер или порты 80/443 закрыты. Исправьте и повторите установку |
| Lampa не загружает плагин | адрес должен быть `https://…/tapokhub.js` и открываться в браузере как текст; проверьте сертификат |
| «Регистрация на сервере закрыта» | `tapokhub users add ваша@почта` |
| Docker отвечает `denied` при загрузке образа | образ этой версии ещё не опубликован: укажите `--version` с существующей версией или соберите образ из репозитория (`docker compose up -d --build`) |
| Порт занят | другой `--port`, либо освободите порт |
| Проверить образ на своём Docker | `scripts/docker-test.sh` (так же проверяет CI) |
