# PanelDataLogger

[العربية](README.md) | **English**

A small Spigot/Paper companion plugin for **MC Panel**. It does two things:

## 1) Internal HTTP server: live data for online players

This is the **most important** part. Instead of waiting for Minecraft to save a
player file to disk (which only happens on `/save-all` or when the player
leaves), or parsing a console command reply (slow and fragile), the plugin runs
a tiny HTTP server on `127.0.0.1` only. The panel (`server.js`) reads it with a
plain HTTP request:

```
GET http://127.0.0.1:28281/player/<name>
```

It returns the player's main inventory, armor, offhand, ender chest, position,
health, hunger, XP, game mode and full statistics (via `Player#getStatistic`)
**straight from the live in-memory player object when they are online**, with
no delay and no guessing. If the player is offline, the panel automatically
falls back to reading the last saved file from disk.

**Nothing else has to be installed on the panel side.** Just make sure
`PANEL_HTTP_PORT` in the panel's `.env` matches `port` in this plugin's
`config.yml` (both default to `28281`).

## 2) Logging death and teleport locations to the console

This part is still needed separately, because Minecraft never writes
coordinates in death or teleport messages, neither in the console nor through
the HTTP server above (which only exposes the **current** state, not history).
The plugin listens to the death and teleport events and prints a fixed-format
line that the panel parses into a permanent per-player history:

```
[PanelData] DEATH|<player>|<world>|<x>|<y>|<z>|<cause>
[PanelData] TELEPORT|<player>|<cause>|<fromWorld>|<fx>|<fy>|<fz>|<toWorld>|<tx>|<ty>|<tz>
```

## Without this plugin

The panel still works, but:
- Inventory/location/health of an online player come only from the last saved file (may lag behind)
- Full statistics (deaths, kills, distances) always work, they are read from the standard stats file
- Historical death and teleport locations will not appear at all

## Building

Requires JDK 8 or newer and Maven. The resulting jar is Java 8 bytecode built against the Bukkit 1.13 API, and it runs on **every version from 1.13 up to the latest (26.x and beyond)** with no changes or rebuilds. Anything that differs between versions (statistic names, armor trims, max health...) is read through reflection with safe fallbacks.

```bash
cd PanelDataLogger
mvn package
```

Output: `target/PanelDataLogger.jar`

> The plugin is deliberately built against `spigot-api 1.13.2-R0.1-SNAPSHOT` so it is not tied to one version. If the download
> fails, change `<spigot.api.version>` in `pom.xml` to match the jar you built
> with BuildTools (it is usually already in your local `~/.m2`).

## Installing

1. Copy `PanelDataLogger.jar` to `/opt/minecraft/plugins/`
2. Restart the server
3. Check that the startup log shows the plugin enabled messages
4. Verify from the machine itself (not from your browser) that the server responds:
   ```bash
   curl http://127.0.0.1:28281/health
   # Expected: {"status":"ok"}
   ```
   If this fails, the problem is in the plugin itself (not installed, or the
   port is taken by another plugin). Change the port in
   `plugins/PanelDataLogger/config.yml` if needed and update `PANEL_HTTP_PORT`
   in the panel's `.env` to match.

No new permissions and no new in-game commands. The only setting is the port.
