# TapokHub: guide

🇷🇺 [Русский](../GUIDE.md) · 🇬🇧 English

> The screenshots show the Russian interface. In the text, the names of buttons and settings are given as they appear in the English interface
> (Lampa language other than Russian, Ukrainian and Belarusian).

## Contents

1. [What it is and how it works](#1-what-it-is-and-how-it-works)
2. [What you need](#2-what-you-need)
3. [Deploying the server](#3-deploying-the-server)
4. [Connecting the plugin and signing in](#4-connecting-the-plugin-and-signing-in)
5. [Working with it: the features in order](#5-working-with-it-the-features-in-order)
6. [Plugin settings](#6-plugin-settings)
7. [The Telegram bot](#7-the-telegram-bot)
8. [Managing the server](#8-managing-the-server)
9. [Updating, copies, rollback](#9-updating-copies-rollback)
10. [Security and limits](#10-security-and-limits)
11. [Diagnostics](#11-diagnostics)
12. [Reference](#12-reference)

---

## 1. What it is and how it works

TapokHub consists of two parts.

- **A Lampa plugin.** It runs on your device (a TV, a phone, a browser): the home screen hub, the “Library”, “Recommendations” and “Collections” sections, buttons on the movie card, settings.
- **A server.** It runs at your place (a VPS, a home computer, a mini PC, a NAS). It stores collections, the library, chosen torrents and settings, caches TMDB responses and images, assembles franchises from TMDB and Wikidata data, and runs the Telegram bot.

![The TapokHub home screen](../images/hub-home.jpg)

The data is shared across all devices of one user: sign in with the same CUB email on another device, and the collections, library, chosen torrents and settings are already there. The plugin stores nothing on the device that cannot be restored from the server.

What the server does **not** store: your CUB account token (the server only asks CUB whose email it is), passwords, viewing history (only Lampa knows the “watched” list).

## 2. What you need

| What | Details |
|---|---|
| Lampa | version **3.0.5 or newer** (a TV, a phone or a browser) |
| Server | any Linux computer: 1 GB of memory and 5 GB of disk are enough to start. TapokHub runs in Docker; the installer sets it up itself |
| CUB account | you sign in to the plugin through a CUB account (or its mirrors) that Lampa is already signed in to |
| Domain (optional) | needed for HTTPS; without it the server works over http in a home network |
| TorrServer and a parser (optional) | needed only to launch torrents, as for regular Lampa. |

**About http and https.** A Lampa page opened over `https://` (for example, lampa.mx) loads a plugin only from `https://`. The Lampa app on a TV and a phone works with `http://` in a home network too. Do not keep a server on the internet without HTTPS: tokens are not encrypted.

## 3. Deploying the server

TapokHub runs in Docker. One command installs Docker (if it is missing), starts the server and prints the plugin address. In detail (all options, HTTPS, updating, copies): [Installation](INSTALL.md).

### A. With a domain and HTTPS

The domain (for example `tapok.example.com`) already points to the server IP, ports 80 and 443 are free.

```bash
curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --domain tapok.example.com --email you@example.com
```

The installer installs Docker, starts the server and Caddy, which obtains a Let's Encrypt certificate itself, and prints the plugin address. Registration on a new server is **closed**: you (the email from `--email`) and the people you add can sign in. Running the same command again updates the server, the data is kept.

### B. Without a domain (http)

```bash
curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --email you@example.com
```

The plugin will be at `http://server-address:8080/tapokhub.js`; another port: `--port`. For a home network only: the traffic is not encrypted.

### C. By hand, with Docker Compose

```bash
mkdir -p /opt/tapokhub && cd /opt/tapokhub
curl -fsSLO https://raw.githubusercontent.com/TAPOKSYS/TAPOKHUB-Lampa-addon/main/compose.yaml
docker compose up -d
```

Open `http://computer-address:8080/`: the page shows the plugin address. The access token is created on the first start: `docker compose exec tapokhub cat /data/token`. The settings are variables in the `.env` file next to `compose.yaml` (the full table is in the [reference](#12-reference)):

```
TAPOK_ADMIN_EMAIL=you@example.com    # the administrator email: you sign in through CUB with it
TAPOK_REGISTRATION=closed            # closed (default) or open
TAPOK_PUBLIC_URL=https://tapok.example.com   # if the server is behind your own proxy or domain
TAPOK_LANG=en                        # the language of server messages: ru or en
TAPOK_PORT=8080
```

### D. Behind your nginx

If nginx is already on the server and serves the certificates itself, the container listens only on this computer and nginx proxies requests to it. The settings and a configuration example: [Installation → HTTPS](INSTALL.md#https).

## 4. Connecting the plugin and signing in

### 4.1. Adding the plugin

There are two ways, choose either.

**Your server's plugin.** Lampa → Settings → Extensions → Add plugin → enter the address `https://tapok.example.com/tapokhub.js` (the server serves the plugin itself, with your address inside) → restart Lampa.

**The common plugin.** One file for all servers: `https://tapoksys.github.io/t.js`. Add it the same way (Settings → Extensions → Add plugin), restart Lampa, then **Settings → TapokHub → “Enter the server address by hand”** (or “Paste the server address from the clipboard”) and give the address of your server, for example `https://tapok.example.com`. The plugin checks that TapokHub answers there and connects; when the address changes, the sign-in on the previous server is reset. The hub images are taken from your server. A server of version 0.9.0-pre.5 or newer is needed (for the address check) and, if Lampa is opened over `https://`, a server address with `https://`.

After that the **TapokHub** item appears in the side menu (the third one), and in Settings → TapokHub the version is shown in the first line.

![TapokHub settings](../images/settings-main.jpg)

The **“Server”** line shows what answers: the server version (for example “Version 0.10.0”).

### 4.2. Signing in

Settings → TapokHub → **Authorization**.

![Authorization before signing in](../images/settings-auth-empty.jpg)

Two ways:

1. **“Sign in with a CUB account”.** A CUB account (or its mirrors) that Lampa is already signed in to is needed. The email must be allowed: for the first user it is `--email` from the installation, for others add it: `tapokhub users add friend@example.com` (when registration is closed).
2. **With an access token.** “Paste the token from the clipboard” (copy the token and press) or “Enter the token by hand”. The token is issued by the administrator: `tapokhub users token 1`. A token works only on the device where it was entered.

![Authorization after signing in](../images/settings-auth-done.jpg)

The sign-in is remembered on the device. On other devices repeat steps 4.1 and 4.2.

## 5. Working with it: the features in order

### 5.1. The home screen (hub)

The **TapokHub** item in the side menu opens a retro room with a TV. Choose a section with the remote, Enter opens it. On the TV “glass”: counters (movies, TV shows, collections, watched) and connection indicators: **server**, **parser**, **TorrServer**.

### 5.2. Library

Individual movies and TV shows added with the “Add to library” button on a card. At the top are filter buttons by group: movies, TV shows, animated movies, animated series, anime and manga, documentaries (with counts). The group is determined by the server.

![Library](../images/library.jpg)

### 5.3. The movie card

On the standard Lampa card TapokHub has its own buttons (yellow icons next to “Watch” and “Bookmarks”):

- **“Add to library”** adds or removes a movie or TV show.
- **“Create collection”** starts assembling the whole franchise. It goes in the background, the button shows progress and the result.
- **“Torrents”** launches the previously chosen torrent (see 5.6).

![The movie card](../images/card.jpg)

### 5.4. Collections

A whole franchise: parts, spin-offs, TV shows, animated series (TMDB and Wikidata data). Inside there are groups: parts of the TMDB collection, “Other movies”, “Coming soon”, “TV shows”, “Animated series”. The collection cover is taken by the best rating, the logo from TMDB when possible.

![Collections](../images/collections.jpg)

Inside a collection:

![The “Wizarding World” collection](../images/franchise.jpg)

- **“Customize”** (the gear): hide a part, restore what was hidden, add your own (one movie, a whole TMDB collection or everything related), reassemble the collection.
- **A long press on a card** → “Remove from collection” (it can be restored through “Customize”).
- **Deleting a collection:** Settings → TapokHub → “Delete a collection” (choose from the list and confirm). What is watched and the movies added one by one are not affected.
- If the server could not choose the franchise itself (several fit), it offers a choice.

**New releases.** Once a day the server rechecks your collections. A new part or season gets a **NEW** mark for 14 days and a notification in the Lampa bell.

### 5.5. Recommendations

The selection is built from what you have already watched: movies watched to 70% or more, and TV shows with at least three episodes watched, are counted. What you are already watching does not get into the selection.

### 5.6. Launching the chosen torrent

TorrServer and the parser are set up in Lampa itself, as usual. TapokHub adds a memory of what was chosen:

- Once you have chosen a torrent for a movie or TV show, the choice is saved on the server (shared across your devices).
- The **“Torrents”** button then launches it right away through TorrServer, and for a TV show the next episode.
- If the torrent does not respond (no seeders or TorrServer did not get the files within 25 seconds): the regular parser search opens.
- To forget the choices: Settings → TapokHub → Playback → “Forget chosen torrents”.

The switches: [Playback](#62-playback).

### 5.7. Hub autostart when Lampa starts

Settings → TapokHub → **“Start the hub when Lampa starts”** (off by default, applies to this device only). After Lampa starts there is a 5-second countdown, then the hub opens.

![Autostart countdown](../images/autostart-countdown.jpg)

**Any action cancels the launch:** pressing any remote or keyboard key, a touch, a click, the mouse wheel. Ordinary keys work as always, and “Back” is additionally swallowed so that Lampa does not exit the app. The countdown does not start if Lampa was launched by a movie link, if the hub is already open or if you managed to open another section yourself.

## 6. Plugin settings

Settings → TapokHub. The main page is split into groups:

| Group | What is in it |
|---|---|
| **Connection** | the “Server” line (version and how it runs), in the common plugin the server address, **Authorization** |
| **Home screen** | **Animation**, the hub autostart switch |
| **Watching and library** | **Playback**, “Delete a collection” |
| **Notifications** | **Telegram** |
| **Server: for the owner** | **Registration on the server** (open or closed, changed only by the server owner) |
| **About the plugin** | the build version |

The pages inside are split by headings too: for example, Telegram has “Bot token”, “Chat” and “Disconnecting”, and Animation has “Hub screen” and “CRT noise”.

### 6.1. Animation

![Animation](../images/settings-anim.jpg)

Counters, CRT noise and the VCR on the hub screen. A separate item: fine-tuning the noise area to the TV in the picture.

![Noise area](../images/settings-fx.jpg)

The area is adjusted right on the screen: position, corner rounding, trapezoid, bulge. The settings are shared across the user's devices.

### 6.2. Playback

![Playback](../images/settings-play.jpg)

| Setting | Default | What it does |
|---|---|---|
| Launch the previously chosen torrent | yes | “Torrents” launches the saved torrent right away |
| Open the movie straight through a torrent | no | Enter on a card in the hub skips the movie page: the chosen torrent is launched, otherwise the parser search opens |
| Search for others if unavailable | yes | if the torrent is unavailable, the parser search opens |
| Launch the file or episode right away | yes | for a TV show the episode where you stopped or the next one is launched |
| Forget chosen torrents |  | clears what was saved |

### 6.3. Settings synchronization

The animation, noise area and playback settings are stored on the server and shared across all of the user's devices. A change goes to the server in a couple of seconds, other devices pull it when Lampa starts and when you return to the app (no more than once a minute). Not synchronized: hub autostart (each device has its own) and the sign-in token.

## 7. The Telegram bot

The bot works inside the server and lets you add movies to the library from Telegram.

![Telegram settings](../images/settings-telegram.jpg)

### 7.1. Connecting

1. Create a bot with **@BotFather** in Telegram (`/newbot`) and get a token like `123456789:AAE…`.
2. In Lampa: Settings → TapokHub → **Telegram** → **“Paste the token from the clipboard”** (copy the whole message from @BotFather, the token is found in it by itself) or “Enter the token by hand”. The server checks the token and shows the bot name.
3. Open the bot in Telegram and send it `/start`. The chat pairs itself, the bot replies “✅ Chat paired”, and in Lampa “chat paired, the bot is ready” appears.

The token is stored on the server and tied to your account: the bot and its settings are one for all your devices. The token is not saved on the device and the server never gives it back.

**About pairing.** So that a stranger who found the bot cannot pair it first, the pairing window stays open for **5 minutes**: after entering the token or after the **“Pair chat”** button. It works for personal chats only. As soon as a chat is paired, the bot ignores a foreign `/start`. To pair again (another chat): “Pair chat” and `/start` from the new chat. A group is paired by entering its number: write `/id` to the bot in the group, copy the number and paste it with the “Paste the chat number from the clipboard” button or enter it by hand.

### 7.2. What the bot can do

| What to write | What happens |
|---|---|
| a movie or TV show title | a list of what was found; a button opens the card |
| buttons on the card | **⭐ Add to library** / **🗑 Remove from the library**, **🎞 Track the collection** / **⛔ Stop tracking the collection** |
| `/library` | how many movies, TV shows and collections |
| `/regen` | reassemble your collections |
| `/id` | the chat number (it answers in any chat, needed to connect a group) |
| `/start`, `/help` | a greeting and the list of commands |

The bot answers only in the paired chat, and in the language of Telegram of whoever writes to it (Russian, Ukrainian and Belarusian give Russian, every other language gives English). It also shows the library limits (5000 items, 300 collections) in the chat.

### 7.3. Management and problems

- The status in Lampa: the “Status” line (“@bot · chat … · running” / “stopped (reason)”).
- **“Disconnect the bot”** in Lampa: the server forgets the token and the chat. The administrator from the console: `tapokhub telegram list` and `tapokhub telegram clear <number or email>`.
- “Telegram did not accept the token”: the token is wrong or revoked (`/revoke` at @BotFather issues a new one).
- “The bot is connected, but writing to the chat failed”: open the bot and press Start.
- “No connection to Telegram”: the server cannot reach `api.telegram.org` (blocked at the hosting provider); check: `curl -sI https://api.telegram.org`.

## 8. Managing the server

There is one administrator command for everything:

| Installation | How to call it |
|---|---|
| the installer | `tapokhub <command>` |
| by hand (compose) | `docker compose exec tapokhub python -m tapokhub <command>` |

A short help: `tapokhub --help`, more by section: `tapokhub users --help`. The language of the output: `TAPOK_LANG=en tapokhub ...` (by default the system language).

### 8.1. State

```bash
tapokhub stats        # version, TMDB key, cache sizes, hit counters
```

The “Server” indicator on the plugin home screen shows the connection to the server, `/healthz` (without a token) answers `{"ok": true, "version": …}`.

### 8.2. Users and sign-in

```bash
tapokhub users list                       # users, devices, when they were online
tapokhub users add friend@example.com     # allow sign-in (the email of a CUB account is needed)
tapokhub users registration open|closed   # open registration to everyone / close it
tapokhub users email 1 you@example.com    # set an email (for example, the owner's)
tapokhub users token 2 --label "Kitchen"  # issue a device token to enter by hand
tapokhub users revoke 3                   # revoke a device (the number from users list)
tapokhub users disable 2 / enable 2       # disable or restore a user
tapokhub users settings 2                 # what this user's plugin synchronizes
tapokhub users limit 2 --movies 5 --tv 5  # a user's own limits (for the demo; --clear removes them)
tapokhub users merge 5 1                  # merge user 5 into 1 (data and devices go to 1)
tapokhub users domain list|add|remove     # CUB mirrors we trust at sign-in
```

Registration is **closed** on a new installation: only added emails can sign in. With **open** registration (chosen in the plugin settings) any CUB account owner can sign in and get their own data on the server; the limits below reduce the damage but do not replace closing it. A CUB mirror that is not in the list: `tapokhub users domain add cub.example` (https only; `--http` if the mirror opens over http only).

**If you signed in with a new email and the data is with the previous user** (for example, the owner): `tapokhub users merge <new> <previous>`.

### 8.3. Collections and library

```bash
tapokhub library list                     # all users' collections with their status
tapokhub library show 12 [--hidden]       # the composition of a collection
tapokhub library resolve movie 671        # create a collection from a movie and wait for the assembly (or tv)
tapokhub library refresh-all              # recheck all collections now
tapokhub library logos                    # pick the logos again (after a server update)
tapokhub library dedupe --dry             # find identical collections of a user (without --dry, remove them)
tapokhub collections list|add|remove      # home screen collections (cache warm-up)
tapokhub warm                             # warm up the cache by hand
tapokhub refresh-key                      # update the TMDB key from the published Lampa
```

The server itself rechecks collections once a day and warms up the cache every 6 hours.

### 8.4. Telegram

```bash
tapokhub telegram list                    # who has a bot connected (the token is not shown)
tapokhub telegram clear 1                 # disconnect a user's bot (number or email)
```

### 8.5. Log

The log: `cd /opt/tapokhub && docker compose logs -f`. The log level: the variable `TAPOK_LOG=DEBUG`. Tokens are not written to the log.

## 9. Updating, copies, rollback

All commands run in the installation folder (`/opt/tapokhub`); in full: [Installation](INSTALL.md#data-updating-rolling-back-removing).

### 9.1. Updating

Repeat the install command or `docker compose pull && docker compose up -d`. The data is kept. The plugin on devices is pulled by itself when Lampa restarts. After a server update you sometimes need `tapokhub library logos` once.

### 9.2. Backup

The whole volume (stop the container first so the copy is consistent):

```bash
docker compose stop
docker run --rm --volumes-from tapokhub -v "$PWD":/backup alpine tar czf /backup/tapokhub-data.tar.gz -C /data .
docker compose start
```

The copy holds the access token (`token`) and the database: keep it as a secret.

### 9.3. Restoring and rolling back

- **Rolling back to the previous version:** `TAPOK_VERSION=0.9.0-pre.7 docker compose up -d` (or `--version` of the installer). The database does not change on a rollback.
- **Restoring the data from a copy:**

```bash
docker compose stop
docker run --rm --volumes-from tapokhub -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/tapokhub-data.tar.gz -C /data'
docker compose start
```

### 9.4. Removing

```bash
docker compose down                      # stop, the data stays
docker compose down -v                   # stop and DELETE the data
rm -rf /opt/tapokhub /usr/local/bin/tapokhub
```

## 10. Security and limits

- **Tokens.** Device tokens are stored as hashes. The access token stands in the request address (that is how Lampa works): do not write such requests to the access log of your proxy (the nginx example in “Installation → HTTPS” has `access_log off`).
- **Registration.** Keep it closed if the server is reachable from the internet: Settings → TapokHub → “Registration on the server” → “Closed” (changed by the server owner, that is the first user) or `tapokhub users registration closed`.
- **Telegram.** The bot token is stored in the database in plain text: keep database and volume copies as a secret. If it leaks, create a new token at @BotFather.
- **Unencrypted HTTP.** For a home network only.
- **Behind a proxy.** The sign-in attempt limit (12 per 10 minutes from an address) is counted by the address the local proxy reports in `X-Real-IP`. A non-local proxy (a container in a bridge network behind someone else's proxy) sees all requests from one address.
- **Limits per user:** 5000 library items, 300 collections, 2000 chosen torrents, 200 settings. **Cache limits:** TMDB responses 512 MB, images 5 GB: beyond the limit the long-unrequested entries are deleted.

## 11. Diagnostics

| Symptom | What to do |
|---|---|
| Lampa does not load the plugin | the address must open in a browser as text; for Lampa over https you need https with a valid certificate |
| There is no TapokHub item | Lampa is older than 3.0.5 (the plugin does not start by itself) or the plugin is not added; restart Lampa |
| “Registration on the server is closed” | `tapokhub users add your@email`, or the owner opens registration: Settings → TapokHub → “Registration on the server” (or `tapokhub users registration open`) |
| “Not signed in” in the “Server” line | sign in: Settings → TapokHub → Authorization |
| “Not responding or does not accept the token” | the server is unavailable or the token is revoked; `tapokhub stats`, `tapokhub users list` |
| Empty sections after signing in | you signed in with another email than on the other devices; if needed `users merge` |
| A collection is not assembled, the status is “error” | the reason is in `tapokhub library list`; often Wikidata asks not to hurry; repeat later or “Refresh composition” |
| The “Recommendations” section is empty | a viewing history in Lampa is needed (watched to 70%+) |
| The bot is silent | Settings → TapokHub → Telegram: the “Status” line; `tapokhub telegram list`; the log |
| The server does not answer after an update | see the log: `docker compose logs --tail 50`; go back to the previous version (section 9.3) |
| Too many sign-in attempts | wait 10 minutes; with a shared proxy address the limit is shared (see section 10) |

## 12. Reference

### 12.1. Environment variables

| Variable | Default | What it does |
|---|---|---|
| `TAPOK_TOKEN` / `TAPOK_TOKEN_FILE` | the file `/data/token` in the image | the owner's main token (at least 16 characters) |
| `TAPOK_AUTO_TOKEN` | `1` in the image | create the token on the first start (container) |
| `TAPOK_DATA` | `/data` in the image | the folder with the database and the image cache |
| `TAPOK_LISTEN` | `0.0.0.0:8080` in the image | the server address and port inside the container |
| `TAPOK_WEB_DIR` | `/app/web` in the image | the folder with the plugin: the server itself serves `/tapokhub.js`, the images and the hint page |
| `TAPOK_PUBLIC_URL` | from the request `Host` header | the server address baked into the plugin |
| `TAPOK_ADMIN_EMAIL` |  | the administrator email; applied once, on a new database |
| `TAPOK_REGISTRATION` | `closed` in the image | `open` or `closed`; applied once, on a new database; later `tapokhub users registration` |
| `TAPOK_TRUSTED_PROXIES` |  | proxy addresses (comma separated), besides the local one, whose `X-Real-IP` is trusted; Docker Compose sets the Caddy address |
| `TAPOK_LANG` | the system language, otherwise `ru` | `ru` or `en`: the language of the administrator commands, the log, the hint page and the installer scripts, and the default TMDB language until a device reports its own |
| `TAPOK_LIMIT_MOVIES`, `TAPOK_LIMIT_TV`, `TAPOK_LIMIT_FRANCHISES` | no limit | demo server: how many movies, TV shows and collections each user except the owner (the first user) may add |
| `TAPOK_RATE_LIMIT` | `1200` | requests per minute per user (images and API together); `0` for no limit |
| `TAPOK_CUB_DOMAINS` | the built-in list | CUB domains we trust at sign-in |
| `TAPOK_TELEGRAM_API` | `https://api.telegram.org` | the Telegram API address (for tests) |
| `TAPOK_LOG` | `INFO` | the log level |
| `TMDB_API_UPSTREAM`, `TMDB_IMG_UPSTREAM`, `WIKIDATA_API`, `LAMPA_APP_URL` | public addresses | replacing external services (for tests) |
| `WD_MIN_INTERVAL` | `3` | the pause between Wikidata requests, seconds |

### 12.2. Where things are

| Where | What |
|---|---|
| `/opt/tapokhub/compose.yaml`, `.env` | the installation settings (`.env` is readable by root only) |
| the container's volume `/data` | the **database** (`tapokhub.sqlite3`), the image cache and the owner's token (`token`) |
| `/app/web` in the image | the plugin and the images |
| `/usr/local/bin/tapokhub` | the administrator command |

### 12.3. Ports and addresses

| Address | What |
|---|---|
| `/tapokhub.js` | the plugin for Lampa |
| `/healthz` | “alive” and the version (no token, no data) |
| `/tmdb/<token>/…` | the TMDB proxy, `/health`, `/whoami`, `/lib/…` (library, collections, Telegram) |
| `/tmdb/auth/cub` | sign-in through a CUB account |
