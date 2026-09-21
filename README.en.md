# TapokHub

🇷🇺 [Русский](README.md) · 🇬🇧 English

**A plugin for [Lampa](https://github.com/yumata/lampa-source) with its own server: franchise collections, a personal library, recommendations, and launching the right torrent with one button. The home screen is styled as a retro room with a TV.**

![The TapokHub home screen in Lampa](docs/images/hub-home.jpg)

> **Status: 0.9 pre-release.** The project works and is in use, but until 1.0 there may be changes and rough edges.
> Report problems in [Issues](../../issues).

The interface language follows the Lampa language setting: Russian, Ukrainian and Belarusian give a Russian interface, every other language gives English. The server messages, the Telegram bot and the installer scripts follow the language of the request, the sender, or the system (see [Language](docs/en/INSTALL.md#language)).

## Try it without installing

There is an open demo server: **https://test.typokhub.ru**. Connect the plugin in Lampa (Settings → Extensions → Add plugin):

```
https://test.typokhub.ru/tapokhub.js
```

Then Settings → TapokHub → Authorization → “Sign in with a CUB account”. Registration on the demo is open, all you need is a CUB account that Lampa is signed in to.

On the demo every user has limits: **30 movies, 5 TV shows and 5 franchise collections**. It is a learning server: its data may be reset, do not keep anything important there. Set up your own server without limits following the [guide](docs/en/GUIDE.md).

## What it does

### Franchise collections

You press “Create collection” on a movie card, and the server assembles the whole franchise: parts, spin-offs, TV shows and
animated series (TMDB and Wikidata data). What is extra can be hidden, what is missing can be added by hand, the collection can be reassembled or deleted.

<p>
  <img src="docs/images/collections.jpg" width="49%" alt="Collections">
  <img src="docs/images/franchise.jpg" width="49%" alt="A franchise collection">
</p>

### Personal library and recommendations

The “Add to library” button on a card gathers individual movies and TV shows in one section split into groups: movies,
TV shows, animated movies, anime, documentaries. Recommendations are built from what you have already watched.

<p>
  <img src="docs/images/library.jpg" width="49%" alt="Library">
  <img src="docs/images/card.jpg" width="49%" alt="A movie card with TapokHub buttons">
</p>

### Launching the chosen torrent

If you have already chosen a torrent for a movie or TV show, the “Torrents” button launches it right away through TorrServer (for a TV show,
the next episode). If the torrent does not respond, the regular parser search opens. The hub can be set to autostart with a countdown:
any action cancels it.

<p>
  <img src="docs/images/autostart-countdown.jpg" width="49%" alt="Autostart countdown">
  <img src="docs/images/settings-play.jpg" width="49%" alt="Playback settings">
</p>

### New releases

Once a day the server rechecks your franchises. A new part or season gets a **NEW** mark for 14 days and a notification in the
Lampa bell. Notifications can also arrive in **Telegram**: the bot is tied to your account with the `/start` command.

### Retro hub and settings

A TV, the section menu inside the “glass”, connection indicators (server, parser, TorrServer) and optional effects: CRT noise,
a VCR, counters. Everything is configured in Settings → TapokHub.

<p>
  <img src="docs/images/settings-main.jpg" width="49%" alt="TapokHub settings">
  <img src="docs/images/settings-fx.jpg" width="49%" alt="Effects settings">
</p>

### And more

- **Works where TMDB is blocked.** The server caches TMDB responses and images and serves the last copy even when TMDB
  is unavailable.
- **Data is shared across all your devices.** You sign in through a CUB account, and every user has their own collections, library,
  chosen torrents and settings. You never type a password into the plugin.
- **Registration** on the server is opened and closed right in the plugin settings (the server owner can do that).

## What you need

- **Lampa 3.0.5 or newer** on a TV, a phone or in a browser.
- **Your own server**: an inexpensive VPS, a home computer, a mini PC or a NAS with Linux. TapokHub runs in **Docker**, and the installer sets Docker up itself.
- To launch torrents: TorrServer and a parser, as usual for Lampa (TapokHub itself does not require them).

## Quick start

1. **Server.** Connect to it over SSH and run this, putting in your own domain and email:

   ```bash
   curl -fsSL https://tapoksys.github.io/TAPOKHUB-Lampa-addon/install.sh | sudo bash -s -- --domain tapok.example.com --email you@example.com
   ```

   The installer installs Docker, sets up HTTPS and starts the server. Without a domain (over http, for a home network) drop `--domain tapok.example.com`.
2. **Plugin.** In Lampa: Settings → Extensions → Add plugin, the address `https://your-domain/tapokhub.js`. Restart Lampa. Or the **common plugin** for any server: `https://tapoksys.github.io/t.js`, then Settings → TapokHub → “Enter the server address by hand”.
3. **Sign in.** Settings → TapokHub → Authorization → “Sign in with a CUB account”.

## Documentation

| Document | What it covers |
|---|---|
| [Guide](docs/en/GUIDE.md) | deployment, all features in order with pictures, the Telegram bot, server management, diagnostics |
| [Installation](docs/en/INSTALL.md) | the installer, settings, HTTPS, updating, rolling back, copies, removing |
| [Changelog](CHANGELOG.en.md) | what is new in each version |

## What the server stores

- For every user: their collections and what is in them, the library, chosen torrents (title, magnet link, tracker),
  plugin settings. All of it is in a database file on your server.
- A shared cache: TMDB and Wikidata responses, images.
- **Not stored:** your CUB account token (the server only asks CUB whose email it is), passwords, viewing history.
