# TapokHub: a caching TMDB proxy and server

🇷🇺 [Русский](README.md) · 🇬🇧 English

Why: TMDB is blocked in some countries. The service stores TMDB responses in SQLite and images on disk, and
serves the last copy if TMDB is unavailable. It takes the TMDB key from Lampa itself.

## What is where
- `server/tapokhub/`: the service package (the Python standard library only). Layers: `core/` (the core: settings, storage, network), `libraries/` (Wikidata, TMDB logos), `modules/` (proxy, users, franchise library, HTTP layer), `cli.py`. It runs in a Docker container (`Dockerfile`, `compose.yaml`, installation: [docs/en/INSTALL.md](../docs/en/INSTALL.md))
- `/data/tapokhub.sqlite3` in the container: API responses, image index, collections for warm-up
- `/data/img/<size>/<file>`: the image cache (limit 5 GB, the excess is deleted by request age)
- `/data/token`: the owner's secret token (without a token in the address the service answers 404)

## Commands
    R=tapokhub                                 # the installer's command; without it: docker compose exec tapokhub python -m tapokhub
    $R stats                                   # state: key, cache, counters
    $R collections list                        # the collections the service warms up
    $R collections add pred "Predator" 399     # add a TMDB collection (--extra movie:384018 for spin-offs)
    $R collections remove pred
    $R warm                                    # warm up the cache now (the service does it itself every 6 hours)
    $R refresh-key                             # take the key from the published Lampa
    docker compose logs -f                     # the log (in the installation folder)

## Library and franchise collections
It is stored in the same SQLite (shared by all devices). The API lives under the same token: `/tmdb/<token>/lib/…`
(JSON, POST with a JSON body, CORS is open). Responses are not cached. Messages in the responses follow the `Accept-Language` header
(see [Language](../docs/en/INSTALL.md#language)).

| Request | What it does |
|---|---|
| `GET status?kind=movie&id=11` | whether the item is in the library and which franchise it belongs to |
| `POST items/add` `{kind,id}` / `items/remove` | a single item (“Add to library”) |
| `GET items` | single items with cards |
| `POST franchises` `{kind,id}` | “Create collection”: the assembly runs in the background, the `pending` status is returned |
| `GET franchises` / `GET franchises/<id>[?hidden=1]` | the list / the composition by groups (`hidden=1` is the customize mode) |
| `POST franchises/<id>/hide` `{kind,id,hidden}` | hide or restore an item |
| `POST franchises/<id>/add` `{kind,id}` / `item-remove` | add by hand / remove what was added by hand |
| `POST franchises/<id>/refresh` / `choose` `{wikidata,prop}` / `delete` | reassemble / choose a franchise from the offered ones / delete |
| `GET search?query=` | a TMDB search for manual adding |
| `GET events` / `POST events/seen` | what is new (for the Lampa bell) |

Franchise statuses: `pending` → `resolving` → `ready`; also `needs_choice` (the item has several franchises in Wikidata:
`choices` is in the response), `error`, `merged` (it matched an existing one, `merged_into` is in the response).

**Where the composition comes from.** A TMDB collection + Wikidata (franchise P8345 or series P179 by TMDB identifiers): spin-offs, TV shows,
animated series. Groups: the parts of trusted TMDB collections (by collection name), “Other movies”, “Coming soon”, “TV shows”,
“Animated series”, “Other” (hidden). The order inside a group is by release date: TMDB has no order of parts of its own.
The thresholds are at the top of `library.py`: a movie shorter than 60 minutes or with fewer than 50 votes, a TV show with fewer than 100 votes go to “Other”.
The item the collection was created from, and everything added by hand, is never hidden by the automation.

**Tracking.** Once a day (after the warm-up) the franchises are reassembled: a new item gets a NEW mark for 14 days and the
`new_item` event, a new season of a TV show gets `new_season`. What was hidden and what was added by hand is kept on reassembly.
Wikidata asks not to hurry: requests go with a 3 s pause and a retry on 429, responses are cached for 14 days.

    $R library resolve movie 11      # assemble the franchise from an item and show the composition
    $R library list | show <id> [--hidden] | refresh-all | logos

## How the cache behaves
- API responses: a collection, a movie, logos 24 h; search and selections 10 min; the rest 1 h. A stale copy
  is served for up to 30 days if TMDB is unavailable.
- Images do not change: they are kept until the space is needed.
- The `api_key` key is not part of the cache key: clients have different keys, the data is the same.

## Updating, rolling back, token
Updating, rolling back and copies: [docs/en/INSTALL.md](../docs/en/INSTALL.md). To change the owner's token: `docker compose exec tapokhub rm /data/token`, then `docker compose restart tapokhub` (a new one is created; the plugin on devices needs the new token).

## Known limitations
- The token is baked into `tapokhub.js`, which is served publicly, so it protects against accidental use, not against
  deliberate use. The proxy passes only requests to api.themoviedb.org and
  image.tmdb.org, arbitrary addresses are not proxied.
- Only the requests that belong to our collections go through the proxy (see `TH.proxy` in `src/core/proxy.js`).
  All other Lampa traffic uses its stock mirrors.


## Users and sign-in

Every user has their own library (collections, individual movies and TV shows, events). Every device has its own token;
its hash is in the database (`users`, `devices`), and the token from `/data/token` works as the owner's token (user 1).
The public plugin does not contain a token: it is obtained at sign-in.

```
R=tapokhub
$R users list                       # users and their devices
$R users add email@example.com      # create a user in advance (needed only when registration is closed)
$R users registration open|closed   # registration of new users on CUB sign-in (open by default)
$R users merge <from> <to>          # merge a user into another (devices and data)
$R users domain add name [--http]   # a trusted CUB mirror (--http: opens over http only)
$R users email 1 email@example.com  # set the owner's (1) email
$R users token <number|email>       # issue a token for manual entry (Settings -> TapokHub)
$R users revoke <device number>     # revoke a device token
$R users disable|enable <number|email>
$R users limit <number|email> --movies N --tv N --franchises N   # a user's own limits (--clear removes them)
```

CUB sign-in: `POST /tmdb/auth/cub` with `{domain, token, profile, device}`. The server asks `https://<domain>/api/users/get`
(the domain only from the `TAPOK_CUB_DOMAINS` list, by default cub.best, cub.black, durex.monster, cubnotrip.top, bylampa.online)
and issues a device token; a new email is registered as a new user (unless registration is closed). The account token is not stored. No more than 12 attempts per
10 minutes from one address. `GET /tmdb/<token>/whoami` shows whose token it is.
