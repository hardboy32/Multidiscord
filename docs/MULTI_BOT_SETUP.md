# Multi-bot setup (Railway)

No JSON is needed. Add these as separate Railway Variables:

| Variable | What to enter |
|---|---|
| `BOT_1_TOKEN` | Token of the first Discord bot |
| `BOT_1_CLIENT_ID` | Application ID of the first bot |
| `BOT_2_TOKEN` | Token of the second Discord bot |
| `BOT_2_CLIENT_ID` | Application ID of the second bot |

The first bot is the primary bot and owns the dashboard. The second bot runs independently with its own music queue and Lavalink session. To add a third bot, use `BOT_3_TOKEN` and `BOT_3_CLIENT_ID`.

Optional variables per bot:
- `BOT_1_GUILD_ID`, `BOT_2_GUILD_ID`, `BOT_3_GUILD_ID`: test guild IDs for slash-command registration.
- `BOT_1_OWNER_ID`, `BOT_2_OWNER_ID`, `BOT_3_OWNER_ID`: owner user IDs.

Keep each token private. Invite each bot application to your Discord server and grant the permissions/intents its features need.

For compatibility, the old single-bot variables `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, and `BOT_OWNER_ID` still work. When `BOT_1_TOKEN` is set, it takes priority for the first bot. Do not use the old `DISCORD_BOTS` JSON variable.

## Shared and isolated resources

- Shared: one Lavalink process, one YouTube Cipher process, dashboard settings, and the existing dashboard port.
- Isolated per bot: Discord client, Shoukaku session, player/queue state, warnings, community data, music panel state, and request-cleanup state.
- If a worker exits, only that worker is restarted; other bots keep running.

Each additional bot consumes memory and gateway resources. Start with two bots and monitor Railway memory before adding more.