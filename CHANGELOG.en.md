# Changes

🇷🇺 [Русский](CHANGELOG.md) · 🇬🇧 English

## 0.12.1
- In the "More with" rows, a film's menu (long press) now has "Add to this collection", "Add to library" and "Create collection".

## 0.12.0
- **More with.** The collection screen now has rows with films of the actors who appear in it: the actor's photo and their five best films.
- **AI picks** got tidier: they no longer suggest what you have already seen, refresh only while Lampa is open, and there is a "Refresh AI picks now" button.

## 0.11.0
- **AI picks of the day** (server owner only). Once a day the server asks an AI (OpenAI-compatible API, DeepSeek by default) for 18 movies and TV shows matching your library, checks each one in TMDB (made-up titles are dropped, items you already have and earlier picks are not repeated) and shows them as the first row of "Recommendations". The reason for each pick is in the card description. If the AI is unavailable, the previous picks stay.
- **The AI key is entered in the plugin settings:** Settings → TapokHub → "Server: for the owner" → "AI key for the picks". The key is stored on the server and never sent back to Lampa (only the last four characters are shown); the picks are built right after you enter it. `TAPOK_AI_KEY` still works; the key from the settings takes priority. Address and model: `TAPOK_AI_URL`, `TAPOK_AI_MODEL`. The `tapokhub ai-recs` command builds the picks right away.
- **Card menu in "Recommendations"** (long press): "Add to library" and "Create collection".

## 0.10.0
- **Docker only.** Installation without Docker (the `deploy/*.sh` scripts, nginx, systemd, the release archive) is removed: less code and fewer variants, and it works the same on any Linux. `install.sh` is shorter: it installs Docker (if missing), puts `compose.yaml` and `.env` in `/opt/tapokhub`, starts the container (with `--domain` also Caddy with HTTPS) and installs the `tapokhub` command. Running it again updates. New variables `TAPOK_VERSION` (the image version) and `TAPOK_BIND` (accept connections only from this computer). The installer is available at the short address `https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh`. `INSTALL.md` and `DOCKER.md` are merged into `INSTALL.md`. The “how it runs” flag (`runtime`, `TAPOK_RUNTIME`) is gone: the server is always in Docker.
- **A short plugin address:** the server also serves the plugin at `/t` (for example, `https://tapok.example.com/t`); the installer and the hint page show it first.
- **Security audit.** Registration is **closed** by default until the owner decides otherwise (before, it was open when the database had no entry). A successful sign-in of a known user does not use up the attempt limit. A per-user request rate limit (`TAPOK_RATE_LIMIT`, 1200 per minute by default) and a separate one for heavy actions (recommendations, creating collections: 30 per minute). A cap on simultaneous connections (256, the rest get 503) and a timeout for a silent connection. Security headers on every answer (`nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`), HSTS in Caddy. The token from the address stays out of the log even with `DEBUG`, and the main token is not written to the log. The `wikidata`, `prop` and `ids` fields are validated. Plugin: the CUB account token goes to a server address typed by hand only after the person confirms (a plugin taken from the server itself asks nothing). CI: the token has read-only permissions.


