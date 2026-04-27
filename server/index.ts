import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientMsg,
  KILLS_PER_POINT,
  MAP_H,
  MAP_W,
  PROJ_DMG,
  PROJ_RADIUS,
  PROJ_SPEED,
  PROJ_TTL,
  PlayerId,
  PlayerStats,
  ProjectileState,
  ServerMsg,
  Snapshot,
  TICK_DT,
  TICK_HZ,
  UNIT_ATTACK_CD,
  UNIT_ATTACK_WINDUP,
  UNIT_HP,
  UNIT_RADIUS,
  UNIT_RANGE,
  UNIT_SPEED,
  UPGRADES,
  UnitState,
  UpgradeKind,
  WelcomeMsg,
  effectiveRange,
  emptyUpgrades,
} from "../shared/protocol.js";

interface Client {
  ws: WebSocket;
  player: PlayerId;
  unitIds: number[];
}

let nextEntityId = 1;
let nextPlayerId = 1;
let tick = 0;

// Reserved owner id for bot/dummy enemies (kept out of human player range)
const BOT_PLAYER: PlayerId = 9999;
const BOT_COUNT = parseInt(process.env.BOTS ?? "6", 10);
const BOT_RESPAWN = (process.env.BOT_RESPAWN ?? "1") !== "0";

// Server-wide options (toggleable at runtime by any client)
const options = {
  ballistics: (process.env.BALLISTICS ?? "0") !== "0",
};

const units = new Map<number, UnitState>();
const projectiles = new Map<number, ProjectileState>();
const clients = new Set<Client>();
const botUnitIds = new Set<number>();
const playerStats = new Map<PlayerId, PlayerStats>();

// Per-bot scratch state. Lives server-side only (not in the protocol).
interface BotMem {
  strafeDir: 1 | -1; // sign of perpendicular vector relative to target line
  lastCd: number;    // previous tick's cooldown, used to detect "just fired"
}
const botMemory = new Map<number, BotMem>();

function ensurePlayerStats(p: PlayerId): PlayerStats {
  let s = playerStats.get(p);
  if (!s) {
    s = { kills: 0, points: 0, upgrades: emptyUpgrades() };
    playerStats.set(p, s);
  }
  return s;
}

// Effective stats per-unit (factor in upgrades for human players; bots use base).
interface EffectiveStats {
  range: number;
  speed: number;
  projSpeed: number;
  damage: number;
  ballistics: boolean;
}
function getEffectiveStats(owner: PlayerId): EffectiveStats {
  const s = playerStats.get(owner);
  const u = s?.upgrades;
  if (!u) {
    return {
      range: effectiveRange(0),
      speed: UNIT_SPEED,
      projSpeed: PROJ_SPEED,
      damage: PROJ_DMG,
      ballistics: options.ballistics,
    };
  }
  return {
    range: effectiveRange(u.range),
    speed: UNIT_SPEED * (1 + 0.15 * u.moveSpeed),
    projSpeed: PROJ_SPEED * (1 + 0.3 * u.projectileSpeed),
    damage: PROJ_DMG * (1 + 0.2 * u.damage),
    ballistics: options.ballistics || u.ballistics > 0,
  };
}

function spawnUnitsForPlayer(player: PlayerId): number[] {
  // Spawn 5 archers in a column on alternating sides
  const ids: number[] = [];
  const onLeft = player % 2 === 1;
  const baseX = onLeft ? 200 : MAP_W - 200;
  const baseY = MAP_H / 2 - 100;
  for (let i = 0; i < 5; i++) {
    const id = nextEntityId++;
    units.set(id, {
      id,
      owner: player,
      x: baseX + (Math.random() - 0.5) * 20,
      y: baseY + i * 50,
      hp: UNIT_HP,
      maxHp: UNIT_HP,
      cooldown: 0,
      windup: 0,
      targetX: null,
      targetY: null,
      attackMove: false,
      attackTargetId: null,
    });
    ids.push(id);
  }
  return ids;
}

function spawnBot(): number {
  const id = nextEntityId++;
  // Scatter bots on the right half of the map
  const x = MAP_W * 0.55 + Math.random() * (MAP_W * 0.4);
  const y = 80 + Math.random() * (MAP_H - 160);
  units.set(id, {
    id,
    owner: BOT_PLAYER,
    x,
    y,
    hp: UNIT_HP,
    maxHp: UNIT_HP,
    cooldown: Math.random() * UNIT_ATTACK_CD,
    windup: 0,
    targetX: null,
    targetY: null,
    attackMove: false,
    attackTargetId: null,
  });
  botUnitIds.add(id);
  return id;
}

function ensureBots() {
  // Drop ids whose units died
  for (const id of [...botUnitIds]) {
    if (!units.has(id)) {
      botUnitIds.delete(id);
      botMemory.delete(id);
    }
  }
  if (!BOT_RESPAWN && botUnitIds.size === 0) return;
  while (botUnitIds.size < BOT_COUNT) spawnBot();
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

const COLLISION_ITERS = 2;
const MIN_UNIT_DIST = UNIT_RADIUS * 2;
const MIN_UNIT_DIST2 = MIN_UNIT_DIST * MIN_UNIT_DIST;

function resolveCollisions() {
  // Simple O(n^2) pairwise separation. Fine for io-scale (<= ~150 units);
  // swap in a uniform spatial hash if unit counts grow.
  const arr = [...units.values()];
  for (let iter = 0; iter < COLLISION_ITERS; iter++) {
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 >= MIN_UNIT_DIST2) continue;
        let d: number;
        if (d2 < 1e-6) {
          // Coincident: push along a deterministic axis based on ids so it's stable
          dx = ((a.id - b.id) % 2 === 0 ? 1 : -1);
          dy = 0;
          d = 1;
        } else {
          d = Math.sqrt(d2);
        }
        const overlap = MIN_UNIT_DIST - d;
        const nx = dx / d;
        const ny = dy / d;
        const push = overlap * 0.5;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
    }
  }
  // Clamp to map bounds
  for (const u of arr) {
    if (u.x < UNIT_RADIUS) u.x = UNIT_RADIUS;
    else if (u.x > MAP_W - UNIT_RADIUS) u.x = MAP_W - UNIT_RADIUS;
    if (u.y < UNIT_RADIUS) u.y = UNIT_RADIUS;
    else if (u.y > MAP_H - UNIT_RADIUS) u.y = MAP_H - UNIT_RADIUS;
  }
}

function findNearestEnemy(u: UnitState): UnitState | null {
  let best: UnitState | null = null;
  let bestD = Infinity;
  for (const o of units.values()) {
    if (o.owner === u.owner) continue;
    const d = dist2(u.x, u.y, o.x, o.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function targetVelocity(t: UnitState): { vx: number; vy: number } {
  if (t.targetX === null || t.targetY === null) return { vx: 0, vy: 0 };
  const dx = t.targetX - t.x;
  const dy = t.targetY - t.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.5) return { vx: 0, vy: 0 };
  return { vx: (dx / d) * UNIT_SPEED, vy: (dy / d) * UNIT_SPEED };
}

// Solve t > 0 such that |T0 + V*t - S| = projSpeed * t (intercept time).
// Returns null if no positive real solution (target faster / fleeing).
function interceptTimeAt(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  vx: number,
  vy: number,
  projSpeed: number,
): number | null {
  const dx = tx - sx;
  const dy = ty - sy;
  const a = vx * vx + vy * vy - projSpeed * projSpeed;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-6) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  const candidates = [t1, t2].filter((t) => t > 0).sort((p, q) => p - q);
  return candidates[0] ?? null;
}

function fireAt(u: UnitState, target: UnitState) {
  const eff = getEffectiveStats(u.owner);
  let aimX = target.x;
  let aimY = target.y;
  if (eff.ballistics) {
    const { vx, vy } = targetVelocity(target);
    // intercept uses the shooter's actual projectile speed
    const t = interceptTimeAt(u.x, u.y, target.x, target.y, vx, vy, eff.projSpeed);
    if (t !== null && t < PROJ_TTL) {
      aimX = target.x + vx * t;
      aimY = target.y + vy * t;
    }
  }
  const dx = aimX - u.x;
  const dy = aimY - u.y;
  const d = Math.hypot(dx, dy) || 1;
  const id = nextEntityId++;
  projectiles.set(id, {
    id,
    owner: u.owner,
    x: u.x,
    y: u.y,
    vx: (dx / d) * eff.projSpeed,
    vy: (dy / d) * eff.projSpeed,
    ttl: PROJ_TTL,
    dmg: eff.damage,
  });
  u.cooldown = UNIT_ATTACK_CD;
}

// ---------------------------------------------------------------------------
// Bot AI
// ---------------------------------------------------------------------------
// Each bot picks the nearest enemy (any non-bot, since all bots share owner =
// BOT_PLAYER) and locks onto it via attackTargetId. The shared step() logic
// then chases-and-shoots exactly like a player-issued attack-click.
//
// Cheap enough to run every tick (B bots * N units). When we add more AI
// flavors (skirmisher, defender, etc.) this is the seam to branch on.
function updateBotAI() {
  for (const id of botUnitIds) {
    const bot = units.get(id);
    if (!bot) continue;
    const enemy = findNearestEnemy(bot);
    bot.attackTargetId = enemy ? enemy.id : null;
    // Bots never use waypoint movement -- the lock alone drives chase.
    bot.targetX = null;
    bot.targetY = null;
    bot.attackMove = false;
  }
}

function step(dt: number) {
  // Units
  for (const u of units.values()) {
    if (u.cooldown > 0) u.cooldown = Math.max(0, u.cooldown - dt);

    const eff = getEffectiveStats(u.owner);
    const range2 = eff.range * eff.range;

    // Resolve a "locked" attack target if any. Drops if the target died or is
    // somehow friendly (shouldn't happen but defensive).
    let lockedEnemy: UnitState | null = null;
    if (u.attackTargetId !== null) {
      const t = units.get(u.attackTargetId);
      if (!t || t.owner === u.owner) {
        u.attackTargetId = null;
      } else {
        lockedEnemy = t;
      }
    }

    const hasWaypoint = u.targetX !== null && u.targetY !== null;
    const hasLocked = lockedEnemy !== null;
    const idle = !hasWaypoint && !hasLocked;
    let moveThisTick = hasWaypoint || hasLocked;

    // Firing:
    //   - locked: only fire at the locked target, only if in range
    //   - idle / attack-move: auto-acquire nearest enemy in range
    //   - plain move (waypoint without attackMove and no locked): never fire
    const canEngage =
      u.cooldown === 0 &&
      (hasLocked || idle || (hasWaypoint && u.attackMove));
    let winding = false;
    let inRangeOfLocked = false;
    if (canEngage) {
      let enemy: UnitState | null = null;
      if (hasLocked) {
        const d2 = dist2(u.x, u.y, lockedEnemy!.x, lockedEnemy!.y);
        if (d2 <= range2) {
          enemy = lockedEnemy;
          inRangeOfLocked = true;
        }
      } else {
        const e = findNearestEnemy(u);
        if (e && dist2(u.x, u.y, e.x, e.y) <= range2) {
          enemy = e;
        }
      }
      if (enemy) {
        winding = true;
        moveThisTick = false; // must hold still to wind up / fire
        u.windup = Math.min(UNIT_ATTACK_WINDUP, u.windup + dt);
        if (u.windup >= UNIT_ATTACK_WINDUP) {
          fireAt(u, enemy);
          u.windup = 0;
        }
      }
    }
    if (!winding) u.windup = 0;

    // Locked + in range, not winding (i.e. on cooldown). Default behavior
    // is HOLD; bots instead strafe perpendicular to the target line so they
    // don't sit still while reloading. Direction is picked once per shot
    // (when cooldown rises) with a 70/30 persistence bias so bots tend to
    // circle-strafe one way for a few shots before switching.
    if (hasLocked && !winding) {
      const d2 = dist2(u.x, u.y, lockedEnemy!.x, lockedEnemy!.y);
      const hold = eff.range - 4;
      if (d2 <= hold * hold) {
        if (u.owner === BOT_PLAYER && u.cooldown > 0) {
          let mem = botMemory.get(u.id);
          if (!mem) {
            mem = {
              strafeDir: Math.random() < 0.5 ? -1 : 1,
              lastCd: u.cooldown,
            };
            botMemory.set(u.id, mem);
          } else if (u.cooldown > mem.lastCd) {
            // Cooldown just rose -> we fired last tick. Re-pick with bias.
            if (Math.random() < 0.3) {
              mem.strafeDir = mem.strafeDir === 1 ? -1 : 1;
            }
          }
          mem.lastCd = u.cooldown;
          // Perpendicular: rotate (dx,dy) 90deg, scaled by direction sign.
          const dx = lockedEnemy!.x - u.x;
          const dy = lockedEnemy!.y - u.y;
          const d = Math.hypot(dx, dy) || 1;
          const px = (-dy / d) * mem.strafeDir;
          const py = (dx / d) * mem.strafeDir;
          u.x += px * eff.speed * dt;
          u.y += py * eff.speed * dt;
          moveThisTick = false; // skip the default chase/hold path
        } else {
          moveThisTick = false; // player units / winding bots: just hold
        }
      }
    }

    // Movement
    if (moveThisTick) {
      if (hasLocked && !inRangeOfLocked) {
        // Chase the locked target. Don't store this in u.targetX/Y; the
        // intent is "follow this unit", not "go to that point".
        const dx = lockedEnemy!.x - u.x;
        const dy = lockedEnemy!.y - u.y;
        const d = Math.hypot(dx, dy) || 1;
        const step = Math.min(d, eff.speed * dt);
        u.x += (dx / d) * step;
        u.y += (dy / d) * step;
      } else if (u.targetX !== null && u.targetY !== null) {
        // Waypoint move. Arrival threshold > unit diameter so a group
        // commanded to a single point settles into a cluster instead of
        // oscillating around a single contested pixel.
        const dx = u.targetX - u.x;
        const dy = u.targetY - u.y;
        const d = Math.hypot(dx, dy);
        if (d < UNIT_RADIUS + 2) {
          u.targetX = null;
          u.targetY = null;
        } else {
          const step = Math.min(d, eff.speed * dt);
          u.x += (dx / d) * step;
          u.y += (dy / d) * step;
        }
      }
    }
  }

  // Unit-vs-unit collision (soft separation, 2 iterations is plenty for io-scale)
  resolveCollisions();

  // Projectiles
  for (const p of projectiles.values()) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.ttl -= dt;
    if (
      p.ttl <= 0 ||
      p.x < -50 ||
      p.x > MAP_W + 50 ||
      p.y < -50 ||
      p.y > MAP_H + 50
    ) {
      projectiles.delete(p.id);
      continue;
    }
    // Hit detection vs enemy units
    const r = PROJ_RADIUS + UNIT_RADIUS;
    const r2 = r * r;
    for (const u of units.values()) {
      if (u.owner === p.owner) continue;
      if (dist2(p.x, p.y, u.x, u.y) <= r2) {
        u.hp -= p.dmg;
        projectiles.delete(p.id);
        if (u.hp <= 0) {
          units.delete(u.id);
          // Credit the kill to the projectile owner (humans only; bots are
          // owner=BOT_PLAYER and don't accumulate stats).
          const killer = playerStats.get(p.owner);
          if (killer) {
            killer.kills++;
            if (killer.kills % KILLS_PER_POINT === 0) killer.points++;
          }
        }
        break;
      }
    }
  }
}

function buildSnapshot(forPlayer: PlayerId): Snapshot {
  const s = ensurePlayerStats(forPlayer);
  return {
    t: "snap",
    tick,
    serverTime: Date.now(),
    you: forPlayer,
    units: [...units.values()],
    projectiles: [...projectiles.values()],
    options: { ...options },
    myStats: {
      kills: s.kills,
      points: s.points,
      upgrades: { ...s.upgrades },
    },
  };
}

function broadcast() {
  for (const c of clients) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    const snap = buildSnapshot(c.player);
    c.ws.send(JSON.stringify(snap));
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket on a single port. In production the built client lives in
// dist/ and is served from this same server; in dev Vite serves the client on
// 5173 and proxies /ws here, so dist/ may not exist (we degrade gracefully).
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, "..", "dist");
const distExists = fs.existsSync(DIST_DIR);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!distExists) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "client not built.\n" +
        "for dev: open http://localhost:5173 (vite dev server proxies /ws here)\n" +
        "for prod: run `npm run build` then restart this server.\n",
    );
    return;
  }
  let urlPath = (req.url ?? "/").split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const safePath = path.normalize(path.join(DIST_DIR, urlPath));
  if (!safePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(safePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-style fallback to index.html for unknown paths
      const fallback = path.join(DIST_DIR, "index.html");
      fs.readFile(fallback, (e2, data) => {
        if (e2) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    // Hashed asset filenames from Vite are safe to cache aggressively.
    const cache =
      safePath.includes(`${path.sep}assets${path.sep}`) &&
      ext !== ".html"
        ? "public, max-age=31536000, immutable"
        : "no-cache";
    res.writeHead(200, { "content-type": type, "cache-control": cache });
    fs.createReadStream(safePath).pipe(res);
  });
}

const httpServer = http.createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  if (url === "/ws" || url.startsWith("/ws?")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(
    `[server] http://${HOST}:${PORT}  ws on /ws  tick=${TICK_HZ}Hz  bots=${BOT_COUNT}${BOT_RESPAWN ? "(respawn)" : ""}  ballistics=${options.ballistics}  dist=${distExists ? "yes" : "no (dev mode)"}`,
  );
});
ensureBots();

wss.on("connection", (ws) => {
  const player = nextPlayerId++;
  const ids = spawnUnitsForPlayer(player);
  ensurePlayerStats(player);
  const client: Client = { ws, player, unitIds: ids };
  clients.add(client);
  const hello: WelcomeMsg = { t: "hello", you: player, unitIds: ids };
  ws.send(JSON.stringify(hello));
  console.log(`[server] player ${player} connected (${ids.length} units)`);

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === "move") {
      const owned = new Set(client.unitIds);
      for (const id of msg.ids) {
        if (!owned.has(id)) continue;
        const u = units.get(id);
        if (!u) continue;
        u.targetX = Math.max(0, Math.min(MAP_W, msg.x));
        u.targetY = Math.max(0, Math.min(MAP_H, msg.y));
        u.attackMove = !!msg.attackMove;
        u.attackTargetId = null; // any move command drops the lock
      }
    } else if (msg.t === "stop") {
      const owned = new Set(client.unitIds);
      for (const id of msg.ids) {
        if (!owned.has(id)) continue;
        const u = units.get(id);
        if (!u) continue;
        u.targetX = null;
        u.targetY = null;
        u.attackMove = false;
        u.attackTargetId = null;
        // cooldown untouched -> auto-fire continues normally
      }
    } else if (msg.t === "attack") {
      const owned = new Set(client.unitIds);
      const target = units.get(msg.targetId);
      if (!target) return;
      for (const id of msg.ids) {
        if (!owned.has(id)) continue;
        const u = units.get(id);
        if (!u) continue;
        if (target.owner === u.owner) continue; // can't attack own units
        u.attackTargetId = msg.targetId;
        u.targetX = null;
        u.targetY = null;
        u.attackMove = false;
      }
    } else if (msg.t === "option") {
      if (typeof msg.ballistics === "boolean") {
        options.ballistics = msg.ballistics;
        console.log(`[server] ballistics = ${options.ballistics}`);
      }
    } else if (msg.t === "upgrade") {
      const def = UPGRADES[msg.kind as UpgradeKind];
      if (!def) return;
      const ps = ensurePlayerStats(player);
      const cur = ps.upgrades[msg.kind as UpgradeKind] ?? 0;
      if (ps.points <= 0) return;
      if (cur >= def.max) return;
      ps.points -= 1;
      ps.upgrades[msg.kind as UpgradeKind] = cur + 1;
      console.log(
        `[server] player ${player} bought ${msg.kind} -> level ${cur + 1}`,
      );
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    for (const id of client.unitIds) units.delete(id);
    playerStats.delete(player);
    console.log(`[server] player ${player} disconnected`);
  });
});

// Game loop
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  tick++;
  updateBotAI();
  step(dt);
  ensureBots();
  broadcast();
}, 1000 / TICK_HZ);
