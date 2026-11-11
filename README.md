# Gallium Backend

A local, version-adaptive Fortnite backend. One shared core (accounts, OAuth, MCP profiles,
XMPP, parties, matchmaking, item shop, progression) with **version adapters** that isolate
what differs between builds, from Season 1 (`Cert` / 1.x) through Chapter 5+ (32.00, 37.20).

- Runs on `http://127.0.0.1:1523` by default; everything stays on your PC.
- **Zero npm dependencies**: Node's built-in `http`, `crypto` and `node:sqlite` only.
- Data lives in one SQLite file (`data/gallium.db`); no MongoDB or other services.

## Requirements

- Windows (also runs on Linux/macOS)
- [Node.js](https://nodejs.org) **22.13 or newer** (24.x recommended)

## Quick start

```bash
npm start
```

`start.bat` does the same with a double-click. On first start Gallium writes
`gallium.config.json` with every option at its default. Stop it with **Ctrl+C**; it closes
connections and the database cleanly.

Optional, once: download the cosmetics list so full lockers and the auto-rotating Item Shop
have items (about 17k entries, stored in `data/cosmetics.json`; the backend itself stays offline):

```bash
npm run sync-cosmetics
```

Check it is up: <http://127.0.0.1:1523/gallium/api/health>

## Connecting a Fortnite client

Gallium speaks plain HTTP. Your launcher / redirect DLL must send the client's Epic requests
to `http://127.0.0.1:1523` (the same thing you did for your previous backend on 3551 / 5595).
If a client tries HTTPS, Gallium logs a warning about the TLS handshake.

XMPP (friends, presence, party notifications) is accepted in every form the builds use:

| Builds (from real client logs) | XMPP transport | Point it at |
|---|---|---|
| 3.x – 4.x | raw TCP | `127.0.0.1:1523` (sniffed on the HTTP port) or `127.0.0.1:5222` |
| 5.x – 21.x | `ws://` with `<stream:stream>` | `ws://127.0.0.1:5222` |
| 32.00+ | WebSocket, RFC 7395 framing | `ws://127.0.0.1:1523` |

Logins: `-AUTH_TYPE=epic -AUTH_LOGIN=<name>@anything -AUTH_PASSWORD=<password>`. With
`accounts.autoRegister` (on by default) the first login creates the account with that
password, and the display name is the part before `@`. Exchange codes
(`-AUTH_TYPE=exchangecode`), refresh tokens, device auth and client credentials also work.

## Admin CLI

Works directly on the database, including while the server is running.

```bash
npm run cli -- help
```

```bash
npm run cli -- create Bandit mypassword
```

```bash
npm run cli -- grant Bandit all
```

```bash
npm run cli -- vbucks Bandit +5000
```

```bash
npm run cli -- exchange Bandit
```

Other commands: `accounts`, `info`, `password`, `ban`/`unban`, `delete`, `revoke`, `xp`,
`battlepass`. Add `--build 4.5` to `grant` / `xp` / `battlepass` to target a specific season.

## Configuration

`gallium.config.json` (created on first run). Command-line flags override it: `--host`,
`--port`, `--xmpp-port`, `--db`, `--log-level`, `--build`, `--config`. So do the environment
variables `GALLIUM_HOST`, `GALLIUM_PORT`, `GALLIUM_DB`, `GALLIUM_LOG_LEVEL`.

| Key | Default | Meaning |
|---|---|---|
| `server.host` / `server.port` | `127.0.0.1` / `1523` | HTTP + WebSocket listener |
| `server.sniffXmppOnHttpPort` | `true` | accept raw-TCP XMPP on the HTTP port |
| `xmpp.enabled` / `xmpp.port` | `true` / `5222` | extra XMPP listener (raw TCP + ws) |
| `accounts.autoRegister` | `true` | create accounts on first password login |
| `accounts.startingVbucks` | `1000` | V-Bucks for new accounts |
| `accounts.grantAllCosmetics` | `false` | new accounts own every cosmetic in `data/cosmetics.json` |
| `versions.fallbackBuild` | `10.40` | build assumed when a request has no Fortnite User-Agent |
| `versions.forceBuild` | `null` | treat every request as this build |
| `matchmaking.fallbackServer` | `null` | `{ "address", "port" }` used when no game server registered |
| `matchmaking.serviceUrl` | auto | WebSocket URL put in matchmaking tickets |
| `gameServers.apiKey` / `admin.apiKey` | `null` | Bearer keys; when `null` only loopback callers are allowed |
| `logging.level` / `logging.file` | `info` / `logs/gallium.log` | unknown routes are logged as warnings with the client's build |

## Data files (`data/`)

All optional, and re-read when changed (no restart needed, except `cosmetics.json`).

| File | Purpose |
|---|---|
| `cosmetics.json` | item list from `npm run sync-cosmetics` (id, type, introduction season, rarity, variants) |
| `shop.json` | Item Shop: manual `featured` / `daily` offers plus daily auto-rotation |
| `battlepass/season<N>.json` | battle pass offer ids and per-tier rewards for season N |
| `quests/season<N>.json`, `quests/default.json` | daily / weekly quest pools |
| `cloudstorage/*.ini`, `cloudstorage/season<N>/*.ini` | hotfix files served to clients |
| `keychain.json`, `keychain/season<N>.json` | `["<pakGuid>:<base64 key>:<item>", ...]` keys for encrypted cosmetic paks. Without it a harmless placeholder key is sent (some builds, e.g. 5.41, fail login on an empty keychain) |
| `content/fortnite-game.json` | keys merged over the generated `/content/api/pages/fortnite-game` |

Battle pass offer ids, tier rewards and quest template ids are game data that differs per
season. Gallium ships the engines for them but no invented data. Fill these files from your
build's game files (formats are documented at the top of `src/services/progression.js` and
`src/services/quests.js`).

## Game servers and matchmaking

A game server (or the tool that hosts it) registers itself, sends heartbeats, and reports results:

| Endpoint | Body / purpose |
|---|---|
| `POST /gallium/api/gameservers` | `{ address, port, region, playlists: [...], maxPlayers, customKey? }` |
| `POST /gallium/api/gameservers/:id/heartbeat` | `{ state: "open" \| "started" \| "closed" }`; servers missing heartbeats for 90 s are removed |
| `POST /gallium/api/gameservers/:id/reset` | new match session on the same server |
| `POST /gallium/api/gameservers/:id/results` | `{ players: [{ accountId, placement, kills, score, minutesPlayed, xp, playlist, questProgress: { objective: count } }] }` → stats, XP, battle pass, wins, quests |
| `DELETE /gallium/api/gameservers/:id` | unregister |

Clients follow the normal flow: ticket → `mms-player` WebSocket (`Connecting` → `Waiting` →
`Queued` → `SessionAssignment` → `Play`) → session lookup → join. Players wait in the queue
until a server with a matching playlist, custom key and free slots is available. The session's
`buildUniqueId` echoes the client's net CL.

Admin HTTP API: `/gallium/api/admin/accounts[/:account[/items|vbucks|xp|exchange|ban]]`
(same operations as the CLI).

## Version adapters

`src/versions/buildInfo.js` parses the User-Agent (`++Fortnite+Release-14.60-CL-14786821`,
including `Cert` builds) into major/minor/CL/season/chapter. The first adapter in
`src/versions/index.js` whose `matches(build)` is true handles the request:

| Adapter | Builds | Differences it isolates (seen in real client traffic) |
|---|---|---|
| `season1-3` | 1.x – 3.4 | V-Bucks in `profile0` (mirrored from `common_core`), STW login commands, no CosmeticLocker, 70/100 tiers, battle stars |
| `chapter1` | 3.5 – 10.x | `EquipBattleRoyaleCustomization` + Bulk, CosmeticLocker from 7.0, battle stars |
| `chapter2-4` | 11 – 27 | `SetCosmeticLockerSlot`, tiers follow level, dynamic lobby backgrounds, shop section meta |
| `chapter5plus` | 28+ | Locker Service (`/api/locker/v4`), `dataOmissionGroup=Locker`, `rvn` = command revision |

**Adding a version:** create `src/versions/adapters/myRange.js` with
`defineAdapter({ id, matches(build), ...overrides })` and add it to `ADAPTERS`. Anything you
leave out is inherited from `adapters/base.js`. You can override features, progression rules,
default athena stats, timeline, content pages, catalog entries, MCP commands
(`mcpCommands: { Name: handler }`) and add HTTP routes (`registerRoutes(router, services)`).

Per-season state is kept apart: when one account plays builds from different seasons, each
season keeps its own level, XP and battle pass (earlier ones show up in `past_seasons`). Items
newer than the client's season are hidden from that client.

## Testing

```bash
npm test
```

Each test file starts its own Gallium on random ports with a throwaway database. The suite covers:

- **Lobby flow:** the full login-to-lobby request sequence observed in real client logs, replayed
  for 1.x, 3.1, 4.5, 5.41, 14.60, 21.50, 32.00 and 37.20, over each build's own XMPP transport.
- **Startup:** the server starts, listens on its port, and reports a port already in use.
- **Auth:** every grant type, sessions, exchange codes, device auth, bans.
- **Errors:** Epic-style error bodies and status codes, invalid input and permission checks.
- **MCP profiles:** revision handling, all locker styles, season filtering and switching, rollback
  of failed commands, cache consistency with outside writes.
- **Shop:** purchase, refund, gifting and battle pass offers.
- **Persistence:** accounts, tokens, profiles, lockers, purchases, cloud files, friends and stats
  survive a restart.
- **Social:** XMPP over all transports, friends, presence, whispers, party lifecycle, MUC chat.
- **Matchmaking:** queueing, assignment, capacity, sessions, fallback server.
- **Progression:** XP, battle stars, quests, match results, admin API.

## Project layout

```
src/
  index.js            entry point: config, startup errors, graceful shutdown
  app.js              wires services + routes (shared by server, CLI, tests)
  server.js           listeners, protocol sniffing, WebSocket routing
  core/               config, logger, errors, router, HTTP context, WebSocket, XML
  db/                 SQLite wrapper, migrations, repositories
  versions/           build parsing + version adapters
  services/           accounts, auth, profiles (MCP engine), mcp/commands, catalog,
                      progression, quests, friends, party, matchmaking, game servers,
                      cloud storage, content, stats, locker (Chapter 5+), admin
  xmpp/               XMPP server
  routes/             HTTP endpoints grouped by Epic service
scripts/              admin CLI, cosmetics sync
test/                 node:test suites
```

## Not implemented (yet)

- **Save the World.** STW profiles exist (empty), and the STW commands old builds send at login
  answer without changes.
- **Real-money purchases, Creative islands / Discovery surfaces, tournaments.**
- **Endpoints 32.00 / 37.20 call whose response formats are not known here.** These include KWS
  epic-settings, content-controls, PRM dialogue (MOTD / interstitials), hotconfigs,
  global-profile-service, tag-management and Reboot Rally. They get Epic-style 404s and are logged.
  Your previous backend also returned 404 for some of them and the client still reached the lobby.
  If a build stalls at a login step, the warning log names the missing route.
- **XP curve.** Every era uses 80,000 XP per level. Chapter 1 clients draw their XP bar from their
  own tables, so the bar can differ from Gallium's level math (adjust `progression` in the adapter).
