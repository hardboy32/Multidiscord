# Multi-bot setup (Railway)

This project can run multiple Discord bot accounts in one Railway service. The supervisor starts **one** YouTube Cipher service and **one** Lavalink server, then starts one isolated Node.js worker per bot. Each worker owns its Discord client, Shoukaku connection/session, music queue, and per-bot data files.

## Configure multiple bots

In Railway Variables, add `DISCORD_BOTS` with a JSON array. Keep each token private:

```json
[
  {
    "id": "hard",
    "token": "DISCORD_BOT_TOKEN_1",
    "clientId": "DISCORD_APPLICATION_ID_1"
  },
  {
    "id": "music",
    "token": "DISCORD_BOT_TOKEN_2",
    "clientId": "DISCORD_APPLICATION_ID_2"
  }
]
```

Optional per-bot fields:
- `guildId`: register slash commands in one test server instead of globally.
- `ownerId`: owner account used by owner-only features.

The first bot in the array is the **primary bot**. It owns the existing web dashboard and birthday scheduler. Other bots run the same commands and modules but do not start another copy of the web server. The dashboard's Discord OAuth application credentials must belong to the primary bot application.

When `DISCORD_BOTS` is present, it takes precedence over `DISCORD_TOKEN`. Remove `DISCORD_BOTS` to return to the original single-bot configuration using `DISCORD_TOKEN`.

## Shared and isolated resources

- Shared: one Lavalink process, one YouTube Cipher process, dashboard settings, and the existing dashboard port.
- Isolated per bot: Discord client, Shoukaku session, player/queue state, warnings, community data, music panel state, and request-cleanup state.
- Lavalink v4 stores players under a session ID. A separate Shoukaku connection per bot therefore allows two bot accounts to play in different voice channels of the same Discord server without sharing a player.

## Important

Invite every bot account to the same Discord server and grant the permissions/intents its features need. Each bot application needs its own token and application ID.

Every extra bot adds memory and gateway activity. The current Railway service starts one Lavalink instance, but it still runs one Node.js worker per Discord bot. Start with two bots on a 1 GB service and watch Railway memory usage before adding more. Do not create separate Lavalink services for each bot.

The existing single-bot environment variables and deployment remain supported.
