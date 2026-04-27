# rts-web

A small browser RTS in the spirit of an io game, focused on combat micro:
group movement, dodgeable projectiles, AoE2-style stutter-step archer play,
focused-fire and chase, control groups, kill-based upgrades, and bots that
chase, lock-on, and circle-strafe between shots.

Server-authoritative simulation over WebSocket; PixiJS renderer in the
browser; one Node process serves the whole thing.

## Quick start

```bash
npm install

# development -- hot-reloading client on :5173, server on :8080,
# Vite proxies /ws so the client connects to the local server
npm run dev
# open http://localhost:5173

# production -- one Node process serves the built static client +
# the WebSocket on the same port
npm run build
npm start
# open http://localhost:8080
```

Open the URL in two browser windows (or send the URL to a friend behind a
public reverse proxy / tunnel) and each connection becomes a new player
with five archers spawned on alternating sides of the map. Six bots also
spawn by default.

## Controls

| Action                          | Key                                 |
|---------------------------------|-------------------------------------|
| Box select                      | Left-click drag                     |
| Single select                   | Left-click on a unit                |
| Move                            | Right-click empty space             |
| Attack a clicked enemy          | Right-click an enemy                |
| Attack-move                     | `A` then left-click                 |
| Stop (cancel move / lock)       | `S`                                 |
| Toggle ballistics (global)      | `B`                                 |
| Select all owned units          | `Tab`                               |
| Cancel attack-move / selection  | `Esc`                               |
| Bind selection to control group | `Ctrl + 0–9`                        |
| Select control group            | `0–9`                               |
| Add control group to selection  | `Shift + 0–9`                       |
| Buy upgrade                     | `Q W E R T` (Range / Ball / Spd / PrjSpd / Dmg) |

A unit can belong to **at most one** control group. Re-binding it to a new
group silently removes it from the old one; groups that hit zero auto-clear.

## Project layout

```
rts-web/
├── index.html            # Vite entry; HUD overlay + script tag
├── package.json
├── vite.config.ts        # client build config (see "Pixi v8 alias" below)
├── tsconfig.json
├── shared/
│   └── protocol.ts       # message types + tunable constants -- single
│                         # source of truth for client AND server
├── server/
│   └── index.ts          # http + ws on one port, 30 Hz simulation loop
├── src/
│   └── main.ts           # PixiJS renderer, input, interpolation, status UI
└── dist/                 # built client (created by `npm run build`)
```

There are no other source files. Plain TypeScript; no framework, no asset
pipeline.

## Architecture

### Server-authoritative

The server runs the simulation at 30 Hz and is the source of truth for
every unit position, projectile, HP value, kill count, and upgrade level.
Clients only ever send commands and receive snapshots; they never simulate
locally (apart from a one-frame optimistic update on upgrade purchases,
which the next snapshot overwrites).

Every tick (~33 ms) the server:

1. Increments tick, runs `updateBotAI()` to re-lock bot targets.
2. Calls `step(dt)`:
   - Decrements cooldowns and windup timers.
   - Decides movement and firing for every unit (see [Combat](#combat)).
   - Runs the bot strafe-during-cooldown rule.
   - Steps projectiles, deletes expired ones, applies damage on hit, and
     credits kills to the projectile owner's player stats.
   - Runs an O(n²) soft-body unit-vs-unit collision pass.
3. Refills bot population if `BOT_RESPAWN` is on.
4. Sends a JSON snapshot (with the recipient's `myStats`) to every client.

Snapshots contain the full visible world state, not deltas. At the io-game
scale (~150 entities, single-digit player count), the bandwidth is well
under 3 KB/s/client and not worth optimising.

### Client interpolation

Snapshots arrive every ~33 ms with some jitter. To keep visuals smooth, the
client renders 100 ms behind the latest snapshot and linearly interpolates
between the two snapshots that straddle that "render time". This trades
100 ms of perceived latency for smooth motion regardless of network
hiccups — the standard online-action trick. See `getInterpolated()` in
`src/main.ts`.

The interpolator handles `windup` smartly: it lerps when the value is
increasing but snaps to the new value when it decreases, so the visual
"charging" pip pops cleanly off the moment a shot fires.

### Single port HTTP + WebSocket

In production `server/index.ts` creates one `http.Server` that:

- Serves `dist/` statically (with hashed-asset immutable caching for
  `/assets/*` and `no-cache` for `index.html`).
- Hands `/ws` upgrades to a `WebSocketServer({ noServer: true })`.
- Refuses upgrades on any other path.

A deploy is one process and one port. Behind a tunnel or reverse proxy you
point everything at `localhost:8080`.

In development the Node server still runs on 8080, but the page itself is
served by Vite on 5173 (with HMR). Vite's dev server proxies `/ws` to 8080
so the client URL construction stays the same in both modes:

```ts
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
```

## Combat

Archer behaviour mirrors the AoE2 stutter-step model with three phases.

### 1. Reload cooldown (`UNIT_ATTACK_CD`, default 1.4 s)

Begins immediately after firing. The unit can move freely during reload;
no new windup or shot can begin until the cooldown expires.

### 2. Windup (`UNIT_ATTACK_WINDUP`, default 0.2 s)

After cooldown, if a unit is **stopped** with an enemy in range, the windup
timer accumulates per tick. The unit must stay still for the full windup
duration for the shot to actually leave the bow. Moving during windup
resets it to zero — the shot is wasted. This is the "skill window":
stutter-step micro is the act of waiting just long enough to fire before
yanking the unit back.

The windup pip is rendered as a small bright-yellow circle that grows from
inside the unit and snaps off the moment of release.

### 3. Projectile

Travels at the shooter's effective `PROJ_SPEED` (default 350 px/s, modified
by the projectile-speed upgrade) toward the aim point, dies after
`PROJ_TTL` (default 2.5 s) or on contact with an enemy unit. Projectiles
are entities, not hitscan — they're physically dodgeable by moving
perpendicular to their path.

### Firing rules

| Unit state                            | Will it fire?                                          |
|---------------------------------------|--------------------------------------------------------|
| Idle (no command)                     | Yes, if enemy in range and CD ready                    |
| Plain right-click move                | **No** — pure travel command, ignores enemies          |
| Attack-moving with target             | Stutter-step: stops to fire, walks during reload       |
| Locked via right-click on enemy       | Yes — chases until in range, focused fire on that one  |
| On cooldown                           | No (cooldown blocks windup)                            |

### Focused fire

Right-clicking (or `A` + clicking) directly on an enemy issues an
`AttackCmd` that sets `attackTargetId` on every selected unit. Locked units:

- Chase the target if out of range.
- Stop and hold position once in range (one unit's range; group balling is
  handled by collision separation).
- Fire only at the locked target; ignore other enemies until the lock dies
  or you issue a new command.

Selection rendering reflects this: the locked target shows a small red
ring and a faint red line back to the shooter.

### Range indicator

Selecting a unit draws a light-grey ring at the player's current effective
range (`UNIT_RANGE + 30 px × range-upgrade level`). It updates the same
frame an upgrade is purchased.

### Ballistics (toggle with `B`, or buy as upgrade `W`)

When ballistics is **off** (default), shots aim at the target's current
position. Targets that move perpendicular cleanly dodge.

When ballistics is **on**, the server solves the standard quadratic
intercept equation for the shooter's actual projectile speed:

```
|T0 + V*t - S|² = (projSpeed * t)²
```

…and aims where the target will be by impact. If the target is faster than
the projectile (no real solution) or running directly away, we fall back
to direct aim.

`B` toggles a global server-wide flag (every unit gets ballistics). The
**Ballistics** upgrade enables it for one player only. A unit fires with
leading aim if **either** is set.

## Upgrades

Each player tracks `kills`, `points`, and per-upgrade `level`. Every
`KILLS_PER_POINT = 2` kills awards one upgrade point. Spend a point with
`Q W E R T` or by clicking a row in the top-right panel.

| Hotkey | Upgrade           | Per-level effect | Max levels |
|--------|-------------------|------------------|------------|
| `Q`    | Range             | +30 px           | 5          |
| `W`    | Ballistics        | leading shots on | 1          |
| `E`    | Move Speed        | +15%             | 5          |
| `R`    | Projectile Speed  | +30%             | 5          |
| `T`    | Damage            | +20%             | 5          |

Damage is locked into each projectile at fire time, so future damage
upgrades never retro-buff arrows already in flight. Move speed and range
take effect for all of the player's units on the very next tick. Bots use
base stats — they don't earn or apply upgrades.

## Control groups

| Input              | Effect                                        |
|--------------------|-----------------------------------------------|
| `Ctrl + N`         | Bind current selection to group N (replace)   |
| `Ctrl + N` (empty) | Clear group N                                 |
| `N`                | Replace selection with group N's living units |
| `Shift + N`        | Add group N's living units to selection       |
| Click a group cell | Same as pressing N                            |

Each unit belongs to at most one group: re-binding pulls it out of any
prior group, and groups that hit zero auto-clear. Selected units that
belong to a group show a small numeric badge above the HP bar.

## Bot AI

`BOTS=N` (default 6) bot archers spawn on the right half of the map and
respawn unless `BOT_RESPAWN=0`. Per-tick AI:

1. Each bot's `attackTargetId` is set to the nearest non-bot unit
   (`updateBotAI`).
2. The shared `step()` pipeline then chases, winds up, fires.

### Optional capabilities

Each bot has a `BotCaps` record set at spawn time. The only capability
right now is `canStrafe`:

- **`canStrafe = false`** (default): bot holds position during cooldown,
  exactly like player units.
- **`canStrafe = true`**: bot circle-strafes perpendicular to the target
  line at full speed during cooldown. Direction is picked once per
  cooldown with a 70/30 persistence bias, producing visible circling for
  several shots before flipping.

Toggle the global default with `BOT_STRAFE=1`. Per-bot overrides go
through `spawnBot({ canStrafe: true })` — that's the hook for "after
wave N, spawn strafing bots."

## Tunables

All gameplay constants live in [`shared/protocol.ts`](shared/protocol.ts)
so the client and server can never disagree about them:

```ts
MAP_W              = 1600
MAP_H              = 900
TICK_HZ            = 30

UNIT_RADIUS        = 10
UNIT_SPEED         = 120  // px/s
UNIT_HP            = 30
UNIT_RANGE         = 260  // px
UNIT_ATTACK_CD     = 1.4  // s post-shot reload
UNIT_ATTACK_WINDUP = 0.2  // s aim time before shot leaves

PROJ_SPEED         = 350  // px/s -- ~3x unit speed (still dodgeable)
PROJ_RADIUS        = 5
PROJ_DMG           = 8
PROJ_TTL           = 2.5  // s

RANGE_PER_LEVEL    = 30   // px added per range-upgrade level
KILLS_PER_POINT    = 2
```

Bumping `UNIT_ATTACK_WINDUP` makes stutter-step harder; lowering
`PROJ_SPEED` makes dodging easier.

## Server environment variables

| Variable      | Default   | Effect                                          |
|---------------|-----------|-------------------------------------------------|
| `PORT`        | `8080`    | HTTP/WS listen port                             |
| `HOST`        | `0.0.0.0` | Listen interface                                |
| `BOTS`        | `6`       | Number of bot archers                           |
| `BOT_RESPAWN` | `1`       | If `0`, bots are not replaced when killed       |
| `BALLISTICS`  | `0`       | If `1`, server starts with global ballistics on |
| `BOT_STRAFE`  | `0`       | If `1`, all bots get `canStrafe` by default     |

Example:
```bash
BOTS=10 BALLISTICS=1 npm start
```

## Networking protocol

JSON over a single WebSocket on `/ws`. All message types are defined in
[`shared/protocol.ts`](shared/protocol.ts).

### Server → client

```ts
WelcomeMsg = { t: "hello", you: PlayerId, unitIds: EntityId[] }
Snapshot   = {
  t: "snap", tick: number, serverTime: number, you: PlayerId,
  units: UnitState[], projectiles: ProjectileState[],
  options: { ballistics: boolean },
  myStats: { kills, points, upgrades: { range, ballistics, moveSpeed,
                                        projectileSpeed, damage } },
}
```

### Client → server

```ts
MoveCmd       = { t: "move",    ids: EntityId[], x, y, attackMove }
StopCmd       = { t: "stop",    ids: EntityId[] }
AttackCmd     = { t: "attack",  ids: EntityId[], targetId: EntityId }
OptionCmd     = { t: "option",  ballistics?: boolean }
BuyUpgradeCmd = { t: "upgrade", kind: UpgradeKind }
```

The server only acts on commands for units the issuing client owns.

## Status indicator

The bottom-left of the page shows a live debug line:

```
boot=pixi-ok (webgl1)  ws=streaming P1  lastSnap=33ms ago
```

`boot=` covers Pixi initialisation states (`starting`, `pixi-init webgl1`,
`pixi-ok`, `pixi-failed: …`, `webgl-context-lost`, `webgl-restored`).

`ws=` covers connection lifecycle (`idle`, `connecting (...)`, `open`,
`hello P1`, `streaming P1`, `closed code=1006`, `error`).

If anything ever stops working, this line tells you whether the failure is
in the renderer, the network, or the server before you have to dig into
devtools.

## Deployment

### Quick demo with Cloudflare Tunnel (no account needed)

Run the unified server on your local box, then expose it through a
trycloudflare tunnel:

```bash
# terminal 1
npm run build
npm start

# terminal 2
cloudflared tunnel --url http://localhost:8080
```

Cloudflared prints a URL like `https://something-something.trycloudflare.com`.
Send it to your friend; the URL stops working when you stop `cloudflared`.
TLS, WebSocket pass-through, and HTTP/2 are all handled automatically.

### Persistent VPS deploy (Caddy + systemd)

Anywhere you can run Node + a reverse proxy. Minimal setup:

1. Provision any 1 GB Linux box; install `nodejs npm caddy git`.
2. `git clone` the repo to e.g. `/opt/rts`, then `npm ci && npm run build`.
3. Drop a systemd unit at `/etc/systemd/system/rts.service`:
   ```ini
   [Unit]
   Description=rts game server
   After=network.target

   [Service]
   WorkingDirectory=/opt/rts
   Environment=PORT=8080
   ExecStart=/usr/bin/npx tsx server/index.ts
   Restart=always
   User=rts

   [Install]
   WantedBy=multi-user.target
   ```
   Then `sudo systemctl enable --now rts`.
4. Caddyfile (`/etc/caddy/Caddyfile`):
   ```caddyfile
   rts.yourdomain.com {
       reverse_proxy localhost:8080
   }
   ```
   `sudo systemctl reload caddy`. Caddy provisions Let's Encrypt certs
   automatically and forwards both HTTP and the WebSocket upgrade.
5. Point an `A` record `rts.yourdomain.com` → your box's public IP.

Updates are then `git pull && npm ci && npm run build && sudo systemctl restart rts`.

## Pixi v8 + Vite gotcha

`vite.config.ts` aliases `pixi.js` to its pre-bundled single-file ESM:

```ts
resolve: {
  alias: [
    { find: /^pixi\.js$/, replacement: "<absolute>/node_modules/pixi.js/dist/pixi.mjs" },
  ],
},
```

This is **load-bearing**. Pixi v8's normal entry (`lib/index.mjs`) has
internal circular dependencies and dynamic imports between renderer
modules (`browserAll`, `WebGLRenderer`, `RenderTargetSystem`,
`WebGPURenderer`, …). The Vite dev server happens to evaluate them in an
order that works, but Rollup's production code-splitting picks a different
order and the result is a temporal-dead-zone reference to `browserAll` at
runtime. The user-visible symptom is `WebGL context was lost` followed by
a Pixi init that hangs forever.

`pixi.js/dist/pixi.mjs` is the pre-built single-file ESM that Pixi itself
ships and tests. By aliasing the package name to that file we use the
exact same code path in dev and prod, and Rollup never sees Pixi's
internal module graph. If you upgrade Pixi and start seeing weird "context
lost" errors only in prod, double-check this alias still resolves to a
real file.

## TypeScript / type checking

```bash
npm run typecheck     # tsc --noEmit
```

`tsconfig.json` is strict mode. `shared/protocol.ts` is imported from both
client and server with no transformation; if you change a message type,
both ends are typechecked against it on the same pass.

## License

Up to you.
