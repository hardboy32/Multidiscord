# HARD BOT Multi-Bot Architecture

## Product decisions

- One Railway deployment and one central dashboard manage multiple Discord bot applications.
- All bot applications may be invited to the same Discord guild.
- Each bot has an independent music player, queue, voice connection, and playback state.
- Existing commands and modules remain available to every bot instance.
- Stopping or losing one bot must not stop the other bot instances.

## Current-code assessment (2026-11-26)

The current application is single-instance, not safe to scale by simply creating more Discord.js clients:

- `index.js` owns one module-level `Client`, one `Shoukaku` instance, and one global `queues` map.
- Lavalink identifies players by guild ID. Two bot accounts in the same guild therefore cannot safely share one Lavalink player namespace; independent music requires an isolated Lavalink node/instance per bot (or a proven namespaced player architecture).
- `dashboard.js` owns one HTTP server, one settings object, one birthday scheduler, and one configured OAuth application.
- `modules.js` and `community.js` contain process-wide state and use shared default data-file paths. Community state is not currently namespaced by bot.
- `start.js` supervises exactly one Lavalink process and one bot process.

For these reasons, adding a second Discord.js client to the existing process would create cross-bot state leaks, conflicting Lavalink players in a shared guild, and dashboard/server conflicts. Do not deploy that shortcut.

## Target architecture

```text
Railway service
  |
  +-- Central supervisor
  |     +-- encrypted bot registry (bot IDs, display names, enabled state, encrypted tokens)
  |     +-- worker lifecycle / health / restart policy
  |     +-- one central HTTP dashboard + OAuth session
  |
  +-- Shared YouTube cipher service (only if the cipher implementation is confirmed stateless)
  |
  +-- Bot worker A
  |     +-- Discord.js client A
  |     +-- Lavalink A (dedicated port, player namespace, config)
  |     +-- data/bot-A/{dashboard,community,warnings,music-panels,...}
  |
  +-- Bot worker B
        +-- Discord.js client B
        +-- Lavalink B (dedicated port, player namespace, config)
        +-- data/bot-B/{dashboard,community,warnings,music-panels,...}
```

The central dashboard is the only process that binds Railway's public `PORT`. Workers expose no public HTTP listeners. The dashboard selects a bot context before showing server settings or actions.

## Data and security boundaries

- Assign every configured bot a stable internal UUID. Never use a token or a Discord guild ID as a filesystem path.
- Encrypt bot tokens at rest with authenticated encryption (AES-256-GCM) using a Railway secret such as `BOT_TOKEN_ENCRYPTION_KEY`. Never return token ciphertext or plaintext to browser JavaScript or API responses. Show only a masked token fingerprint/last four characters.
- Validate a token with Discord REST before saving it; derive the bot application/user ID from the authenticated response rather than trusting a user-supplied ID.
- Keep each worker's dashboard settings, community data, warnings, music panels, and other mutable files in its own directory.
- Preserve the existing single-bot installation as the first registry entry during migration. Do not delete or overwrite existing user data.
- Store OAuth application credentials and the dashboard session secret only in Railway Variables. Do not duplicate them into the bot registry.
- Require an authenticated dashboard session and an explicit owner allowlist for add/remove/start/stop operations. Never expose token-management endpoints to ordinary guild members.

## Runtime and music isolation

- A worker owns exactly one Discord.js client and exactly one Shoukaku connection.
- Each worker receives a unique Lavalink port and its own Lavalink process/config. Its local queue map and all player state remain inside that worker.
- A worker crash is restarted with bounded backoff and does not terminate sibling workers. A supervisor shutdown stops all children cleanly.
- The YouTube cipher service may be shared only after verifying concurrent requests and authentication are safe; otherwise run one isolated cipher process per worker too.
- Register slash commands separately for every bot application. Each bot must be invited and granted the required intents/permissions independently.
- Use bounded worker counts and expose per-worker memory/CPU/health metrics. A one-gigabyte Railway container cannot be assumed to support several full Lavalink instances; capacity must be measured before enabling additional workers.

## Dashboard UX

- Add a **Bots** page with Add Bot, start/stop, status, guild count, latency, and remove actions.
- Selecting a bot scopes every existing dashboard page/API operation to that bot's settings and Discord client.
- Show the bot identity clearly in the header to prevent editing the wrong instance.
- Keep existing settings pages and controls; do not duplicate the dashboard UI per bot.
- Add a warning before starting a music-enabled worker when the configured resource budget is exceeded.

## Safe migration plan

1. **Inventory and regression baseline** — record current main commit, inspect every process-wide singleton, list every data file and timer, and preserve current single-bot behavior.
2. **Extract worker runtime** — convert the current bot startup into a factory that receives an immutable instance context (bot ID, token, data directory, Lavalink endpoint). Replace module-level singleton state with per-instance closures or explicit context.
3. **Isolate modules and persistence** — pass the instance context through dashboard, core modules, community modules, schedulers, warning storage, and all file paths. Verify two workers cannot read or write each other's files.
4. **Supervisor and node isolation** — launch one Discord worker and one Lavalink process per configured bot; add health checks, restart backoff, shutdown handling, and hard concurrency/resource limits.
5. **Central dashboard** — move HTTP/OAuth to the supervisor; add authenticated bot registry APIs and bot selector; scope all dashboard actions to the selected worker.
6. **Migration and tests** — import the current `DISCORD_TOKEN` installation as the default bot without losing settings; test two bot accounts in the same guild, simultaneous music in different voice channels, duplicate guild playback isolation, worker restart, dashboard auth, and data separation.
7. **Enable gradually** — keep one bot as the default and make additional workers opt-in. Do not claim multi-bot support until all isolation tests pass.

## Acceptance criteria

- Two bot accounts can be online in the same guild simultaneously.
- Both can execute the existing slash commands independently.
- Both can play different tracks at the same time in the same guild without replacing or controlling the other's Lavalink player.
- Stopping/restarting one worker leaves the other worker and dashboard available.
- Dashboard settings and persisted data never cross between bot instances.
- A bad token or worker crash does not stop healthy workers.
- Existing single-bot data and functionality survive migration.
- Resource caps prevent Railway memory exhaustion; actual supported bot count is reported from measurements, not guessed.


## Implemented runtime model

The runtime uses one shared Lavalink process and one Discord worker process per configured bot. Each worker creates its own Shoukaku instance and therefore receives its own Lavalink session. Lavalink's REST player endpoints are scoped by `/v4/sessions/{sessionId}/players/{guildId}`, so identical guild IDs in different sessions refer to separate players. See the [Lavalink REST API](https://lavalink.dev/api/rest).

Configuration and Railway setup are documented in [MULTI_BOT_SETUP.md](./MULTI_BOT_SETUP.md). The first configured bot owns the single dashboard server; secondary workers use the shared dashboard settings file and reload it when settings are requested.
