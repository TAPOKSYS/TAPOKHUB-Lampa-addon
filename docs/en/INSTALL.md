# Installing TapokHub

🇷🇺 [Русский](../INSTALL.md) · 🇬🇧 English

TapokHub runs in Docker: one container with the server, which serves the Lampa plugin, the images and the API itself. Images for `amd64`
and `arm64` (ordinary servers, mini PCs, NAS, Raspberry Pi). The short version with one command is in the [README](../../README.en.md#quick-start).

## What you need beforehand

| What | Details |
|---|---|
| Server | Linux with root access (`sudo`), 1 GB of memory and 5 GB of disk are enough to start. **You do not need to install Docker beforehand**: the installer does it |
| Domain | for HTTPS: for example `tapok.example.com`, with a DNS **A record** to the server IP. Lampa opened over https loads the plugin only over https. **Without a domain** it works over http |
| Ports | with a domain ports 80 and 443 free and open; without a domain one port (8080 by default) |
| Email | yours: you sign in to the plugin with it through a CUB account as the administrator |
| Lampa | version 3.0.5 or newer |

## Install with one command

With a domain and HTTPS (a Let's Encrypt certificate, renewed by itself):

```bash
curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --domain tapok.example.com --email you@example.com
```

Without a domain, over http (for a home network):

```bash
curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --email you@example.com
```

| Option | What it means |
|---|---|
| `--domain` | the server domain: switches HTTPS on |
| `--email` | the administrator email |
| `--port` | the port without a domain (8080 by default) |
| `--version 0.10.0` | a specific image version instead of the newest |
| `--dir` | where to put the settings (`/opt/tapokhub` by default) |

**What the installer does** (`install.sh` in the repository root, you can read it before running):
1. Installs Docker if it is missing (with the official get.docker.com script).
2. Puts `compose.yaml` and `.env` in `/opt/tapokhub`. The settings live in `.env` (readable by root only).
3. Pulls the image and starts the `tapokhub` container (with a domain also Caddy for HTTPS), waits for `/healthz` to answer.
4. Installs the administrator command `tapokhub` and records your email.
5. Prints the plugin address.

Registration on a new server is **closed**: you and the people you add can sign in. Running the same command again updates TapokHub to the
newest version; the data and settings are kept.

## Without the installer

```bash
mkdir -p /opt/tapokhub && cd /opt/tapokhub
curl -fsSLO https://raw.githubusercontent.com/TAPOKSYS/TAPOKHUB-Lampa-addon/main/compose.yaml
docker compose up -d
```

Then open `http://server-address:8080/`: the page shows the plugin address. It has a short form for typing with a remote: `http://server-address:8080/t` (the same as `/tapokhub.js`; Lampa needs the address together with `http://` or `https://`). The settings go in the `.env` file next to `compose.yaml`.
Without compose, as a single container:

```bash
docker run -d --name tapokhub --restart unless-stopped -p 8080:8080 -v tapokhub-data:/data ghcr.io/tapoksys/tapokhub-lampa-addon:latest
```

The administrator command without the installer: `docker compose exec tapokhub python -m tapokhub ...` instead of `tapokhub ...`.

## Sign in to the plugin

In Lampa: Settings → Extensions → Add plugin → the plugin address → restart Lampa. Then Settings → TapokHub → Authorization:

1. **Through a CUB account.** “Sign in with a CUB account”: the email you gave at install time (`--email`) is needed.
2. **With an access token.** The token is created on the first start: `docker compose exec tapokhub cat /data/token`, paste it into “Enter the token by hand”.

Add other people with `tapokhub users add email@example.com`, or open registration: `tapokhub users registration open`.

## Settings

The `.env` file next to `compose.yaml`, every variable is optional. After a change: `docker compose up -d`.

| Variable | What it does |
|---|---|
| `TAPOK_PORT` | the port on the server (8080 by default) |
| `TAPOK_BIND` | `127.0.0.1`: accept connections only from this computer (with HTTPS through Caddy; the installer sets it with a domain) |
| `TAPOK_VERSION` | the image version, for example `0.10.0` (the newest by default) |
| `TAPOK_PUBLIC_URL` | the address Lampa uses to reach the server. Without it the address from the request is used; set it if the server is behind your own proxy or domain |
| `TAPOK_LANG` | the language of server messages, the log and commands: `ru` or `en` (without it the system language, otherwise Russian) |
| `TAPOK_DOMAIN`, `COMPOSE_PROFILES=https` | switch on Caddy with a certificate for the domain |
| `TAPOK_HTTP_PORT`, `TAPOK_HTTPS_PORT` | the Caddy ports (80 and 443 by default) |
| `TAPOK_TRUSTED_PROXIES` | proxy addresses (comma separated) whose `X-Real-IP` is trusted; `compose.yaml` sets the Caddy address |
| `TAPOK_ADMIN_EMAIL` | the administrator email; applied once, on the first start |
| `TAPOK_REGISTRATION` | `closed` (default) or `open`; applied once, on the first start, later `tapokhub users registration` |
| `TAPOK_RATE_LIMIT` | requests per minute per user (1200 by default; 0 for no limit) |
| `TAPOK_LIMIT_MOVIES`, `TAPOK_LIMIT_TV`, `TAPOK_LIMIT_FRANCHISES` | demo server: how many movies, series and collections each user except the owner may add |
| `TAPOK_LOG` | the log level: `INFO` (default) or `DEBUG` |

## HTTPS

**Caddy from compose** (what `--domain` switches on): it obtains and renews the certificate itself. By hand: in `.env` the lines
`TAPOK_DOMAIN=tapok.example.com`, `COMPOSE_PROFILES=https`, `TAPOK_BIND=127.0.0.1`, then `docker compose up -d`. To switch it off: remove
`COMPOSE_PROFILES=https` and `docker compose rm -sf caddy`. Caddy passes the visitor address in `X-Real-IP`, and the server trusts it only from
Caddy (`TAPOK_TRUSTED_PROXIES`), so the sign-in attempt limit is counted per real address.

**Behind your own nginx** (if it is already there and serves the certificates itself). Let the container listen only on this computer and trust nginx: in `.env`
`TAPOK_BIND=127.0.0.1`, `TAPOK_PORT=8890`, `TAPOK_TRUSTED_PROXIES=172.29.0.250,172.29.0.1` (nginx reaches the container from the compose network
gateway address, `172.29.0.1`), then `docker compose up -d`. Add to `server { }`:

```nginx
location / {
    proxy_pass http://127.0.0.1:8890;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_http_version 1.1;
    access_log off;                       # the request address holds the token: keep it out of the log
    add_header Strict-Transport-Security "max-age=31536000" always;
}
```

A Lampa page opened over `https://` will not load the plugin from an http address. The Lampa app on a TV or phone also works over http
in a home network. Without your own proxy or Caddy the sign-in attempt limit is counted per proxy address, not per visitor.

## Data, updating, rolling back, removing

Everything that matters lives in the container's `/data` volume: the database (collections, library, users), the image cache and the token.

```bash
cd /opt/tapokhub
docker compose pull && docker compose up -d         # update (or repeat the install command)
TAPOK_VERSION=0.9.0-pre.7 docker compose up -d      # roll back to another version (or --version of the installer)
docker compose logs -f                              # the log
docker compose down                                 # stop, the data stays
docker compose down -v                              # stop and DELETE the data
```

A copy of the data (worth making before an update):

```bash
docker compose stop
docker run --rm --volumes-from tapokhub -v "$PWD":/backup alpine tar czf /backup/tapokhub-data.tar.gz -C /data .
docker compose start
```

To restore from the copy: `docker compose stop`, then
`docker run --rm --volumes-from tapokhub -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/tapokhub-data.tar.gz -C /data'`, then `docker compose start`.

To remove TapokHub completely: `docker compose down -v`, `rm -rf /opt/tapokhub /usr/local/bin/tapokhub`.

A folder can be mounted instead of the volume: `-v /srv/tapokhub:/data`, but it must belong to the user with number `10001`
(`chown 10001:10001 /srv/tapokhub`): the container does not run as root.

## Users

```bash
tapokhub users list                     # who is there, which devices
tapokhub users add friend@example.com   # allow sign-in (the email of their CUB account is needed)
tapokhub users registration open        # allow everyone (closed by default); also: Settings → TapokHub → “Registration on the server”
tapokhub users revoke 3                 # revoke a device
tapokhub users token 2                  # issue a token to enter by hand (Settings → TapokHub → Authorization)
tapokhub users disable 2                # disable a user
```

The full list of administrator commands: [server/README.en.md](../../server/README.en.md).

## Language

- **The plugin** takes its language from the Lampa setting: Russian, Ukrainian and Belarusian give a Russian interface, every other language gives English.
- **The server answers to the plugin** follow the `Accept-Language` header, which the plugin fills with the Lampa language. **The Telegram bot** answers in the Telegram language of the person writing to it.
- **The administrator commands, the log, the hint page and the installer** use the default language: the `TAPOK_LANG` variable (`ru` or `en`), otherwise the system language (`LC_ALL`, `LC_MESSAGES`, `LANG`), and if nothing is set, Russian. For example: `TAPOK_LANG=en` in `.env`.
- **Descriptions and titles of movies** come from TMDB in the language Lampa asks TMDB for (the Lampa “TMDB language” setting).
- The Russian version of this guide: [docs/INSTALL.md](../INSTALL.md).

## Troubleshooting

| Symptom | Cause and what to do |
|---|---|
| The server does not answer | `cd /opt/tapokhub && docker compose ps`, `docker compose logs --tail 50`, `tapokhub stats` |
| No certificate with a domain | the domain does not point to the server or ports 80/443 are closed. Fix it and run the installation again |
| Lampa does not load the plugin | the address must be `https://…/tapokhub.js` and open in a browser as text; check the certificate |
| “Registration on the server is closed” | `tapokhub users add your@email` |
| Docker answers `denied` when pulling the image | the image of this version is not published yet: give `--version` with an existing version or build the image from the repository (`docker compose up -d --build`) |
| The port is busy | another `--port`, or free the port |
| Check the image on your own Docker | `scripts/docker-test.sh` (CI checks it the same way) |
