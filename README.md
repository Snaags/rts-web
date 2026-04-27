# rts-web

A small browser RTS in the spirit of an io game, focused on combat micro:
group movement, dodgeable projectiles, and AoE2-style stutter-step archer
play. Server-authoritative simulation over WebSocket; PixiJS renderer
in the browser; one Node process serves the whole thing.

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

Open the URL in two browser windows (or send the URL to a friend behind
some kind of public reverse proxy / tunnel) and each connection becomes a
new player with five archers spawned on alternating sides of the map.

## Controls

| Action                  | Key                              |
|-------------------------|----------------------------------|
| Box select              | Left-click drag                  |
| Single select           | Left-click on a unit             |
| Move                    | Right-click                      |
| Attack-move             | `A` then left-click              |
| Stop (cancel move)      | `S`                              |
| Toggle ballistics       | `B`                              |
| Select all owned units  | `Tab`                            |
| Cancel attack-move/sel. | `Esc`                            |

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

There are no other source files. Everything is plain TypeScript; no
framework, no asset pipeline.

## Architecture

### Server-authoritative

The server runs the simulation at 30 Hz and is the source of truth for every
unit position, projectile, and HP value. Clients only ever send commands
(move, stop, option) and receive snapshots; they never simulate locally.

Every tick (~33 ms) the server:

1. Decrements cooldowns and windup timers.
2. Decides movement and firing for every unit (see [Combat](#combat)).
3. Steps projectiles, deletes expired ones, applies damage on hit.
4. Runs a soft-body unit-vs-unit collision pass (O(n²) pairwise).
5. Refills bot population if `BOT_RESPAWN` is on.
6. Sends a JSON snapshot to every connected client.

Snapshots contain the full world state, not deltas. At the io-game scale
(~150 entities, single-digit player count), the bandwidth is well under
3 KB/s/client and not worth optimising.

### Client interpolation

Snapshots arrive every ~33 ms with some jitter. To keep visuals smooth, the
client renders 100 ms behind the latest snapshot and linearly interpolates
between the two snapshots that straddle that "render time". This trades
100 ms of perceived latency for smooth motion regardless of network
hiccups, which is the standard trick for online action games.

The interpolation also handles `windup` smartly: it lerps when the value
is increasing but snaps to the new value when it decreases, so the visual
"charging" pip pops cleanly off the moment a shot fires.

### Single port HTTP + WebSocket

In production `server/index.ts` creates one `http.Server` that:

- Serves `dist/` statically (with hashed-asset immutable caching for
  `/assets/*` and `no-cache` for `index.html`).
- Hands `/ws` upgrades to a `WebSocketServer({ noServer: true })`.
- Refuses upgrades on any other path.

That means a deploy is one process and one port. Behind a tunnel or
reverse proxy you point everything at `localhost:8080`.

In development the Node server still runs on 8080, but the page itself
is served by Vite on 5173 (with HMR). Vite's dev server proxies `/ws` to
8080 so the client URL construction stays the same in both modes:

```ts
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
```

## Combat

Archer behaviour mirrors the AoE2 stutter-step model with three phases.

### 1. Reload cooldown (`UNIT_ATTACK_CD`, default 1.4 s)

Begins immediately after firing. The unit can move freely during reload;
no new windup or shot can begin until the cooldown expires.

### 2. Windup (`UNIT_ATTACK_WINDUP`, default 0.4 s)

After cooldown, if a unit is **stopped** with an enemy in range, the
windup timer accumulates per tick. The unit must stay still for the
full windup duration for the shot to actually leave the bow. Moving
during windup resets it to zero — the shot is wasted. This is the
"skill window": stutter-step micro is the act of waiting just long
enough to fire before yanking the unit back.

The windup pip is rendered as a small bright-yellow circle that grows
from inside the unit and snaps off the moment of release.

### 3. Projectile

Travels at `PROJ_SPEED` (default 280 px/s) toward the aim point, dies
after `PROJ_TTL` (default 2.5 s) or on contact with an enemy unit.
Projectiles are entities, not hitscan — they are physically dodgeable
by moving perpendicular to their path.

### Firing rules

| Unit state                   | Will it fire?                                           |
|------------------------------|---------------------------------------------------------|
| Idle (no command)            | Yes, if enemy in range and CD ready                     |
| Right-click moving           | **No** — pure travel command, ignores enemies           |
| Attack-moving with target    | Stutter-step: stops to fire, walks during reload        |
| On cooldown                  | No (cooldown blocks windup)                             |

### Ballistics (toggle with `B`)

When ballistics is **off** (default), shots aim at the target's current
position. Targets that move perpendicular cleanly dodge.

When ballistics is **on**, the server solves the standard quadratic
intercept equation:

```
|T0 + V*t - S|² = (PROJ_SPEED * t)²
```

…and aims where the target will be by impact. If the target is moving
faster than the projectile (no real solution) or running directly away,
the server falls back to direct aim.

This is a global server option. Any client can toggle it; the server is
the source of truth and broadcasts the current value in every snapshot.

## Tunables

All gameplay constants live in [`shared/protocol.ts`](shared/protocol.ts)
so the client and server can never disagree about them:

```ts
MAP_W           = 1600
MAP_H           = 900
TICK_HZ         = 30

UNIT_RADIUS     = 10
UNIT_SPEED      = 120  // px/s
UNIT_HP         = 30
UNIT_RANGE      = 260  // px
UNIT_ATTACK_CD  = 1.4  // s post-shot reload
UNIT_ATTACK_WINDUP = 0.4 // s aim time before shot leaves

PROJ_SPEED      = 280  // px/s -- ~2.3x unit speed (dodgeable)
PROJ_RADIUS     = 5
PROJ_DMG        = 8
PROJ_TTL        = 2.5  // s
```

Bumping `UNIT_ATTACK_WINDUP` makes stutter-step harder; lowering
`PROJ_SPEED` makes dodging easier.

## Server environment variables

| Variable      | Default | Effect                                                |
|---------------|---------|-------------------------------------------------------|
| `PORT`        | `8080`  | HTTP/WS listen port                                   |
| `HOST`        | `0.0.0.0` | Listen interface                                    |
| `BOTS`        | `6`     | Number of stationary bot archers                      |
| `BOT_RESPAWN` | `1`     | If `0`, bots are not replaced when killed             |
| `BALLISTICS`  | `0`     | If `1`, server starts with ballistics on              |

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
  options: { ballistics: boolean }
}
```

### Client → server

```ts
MoveCmd   = { t: "move", ids: EntityId[], x: number, y: number, attackMove: boolean }
StopCmd   = { t: "stop", ids: EntityId[] }
OptionCmd = { t: "option", ballistics?: boolean }
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

If anything ever stops working, this line tells you whether the failure
is in the renderer, the network, or the server before you have to dig
into devtools.

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

Anywhere you can run Node + a reverse proxy. The minimal setup:

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
order that works, but Rollup's production code-splitting picks a
different order and the result is a temporal-dead-zone reference to
`browserAll` at runtime. The user-visible symptom is `WebGL context was
lost` followed by a Pixi init that hangs forever.

`pixi.js/dist/pixi.mjs` is the pre-built single-file ESM that Pixi itself
ships and tests. By aliasing the package name to that file we use the
exact same code path in dev and prod, and Rollup never sees Pixi's
internal module graph. If you upgrade Pixi and start seeing weird
"context lost" errors only in prod, double-check this alias still
resolves to a real file.

## TypeScript / type checking

```bash
npm run typecheck     # tsc --noEmit
```

`tsconfig.json` is strict mode. `shared/protocol.ts` is imported from
both client and server with no transformation; if you change a message
type, both ends are typechecked against it on the same pass.

## License

Up to you.
