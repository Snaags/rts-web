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
  ABILITIES,
  AbilityKind,
  BLINK_MAX_DIST,
  BLINK_MOVE_LOCK_SEC,
  BOT_PLAYER,
  LeaderboardEntry,
  effectiveRange,
  emptyAbilities,
  emptyUpgrades,
} from "../shared/protocol.js";
import { MatchManager } from "./match.js";

interface Client {
  ws: WebSocket;
  player: PlayerId;
  unitIds: number[];
}

let nextEntityId = 1;
let nextPlayerId = 1;
let tick = 0;

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

// Default capability flags for newly spawned bots. Per-bot overrides can
// be passed to spawnBot(). Currently only one capability:
//   canStrafe -- if true, the bot circle-strafes around its target during
//   reload cooldown. Off by default so bot AI matches the original
//   "stand and shoot" behavior; future per-wave logic can flip this on.
interface BotCaps {
  canStrafe: boolean;
}
const DEFAULT_BOT_CAPS: BotCaps = {
  canStrafe: (process.env.BOT_STRAFE ?? "0") !== "0",
};

// Per-bot server-side state. NOT part of the protocol -- the client doesn't
// see this. Created at spawn time so the strafe gate is decided up front;
// the `strafe` sub-state is filled in lazily on first cooldown.
interface BotState {
  caps: BotCaps;
  strafe: { dir: 1 | -1; lastCd: number } | null;
}
const botState = new Map<number, BotState>();

function ensurePlayerStats(p: PlayerId): PlayerStats {
  let s = playerStats.get(p);
  if (!s) {
    s = {
      kills: 0,
      points: 0,
      upgrades: emptyUpgrades(),
      abilities: emptyAbilities(),
    };
    playerStats.set(p, s);
  }
  return s;
}

interface EffectiveStats {
  range: number;
  speed: number;
  projSpeed: number;
  damage: number;
  ballistics: boolean;
}
/**
 * Compute a unit's effective combat stats by folding the owning player's
 * purchased upgrades into the base tunables. Bots (or any owner without a
 * playerStats entry) use the bare base values.
 *
 * Damage is locked into each projectile at fire time via {@link fireAt},
 * so future damage upgrades don't retroactively buff arrows already in
 * the air.
 *
 * Ballistics is the union of the server-wide debug toggle and the
 * per-player upgrade — either one being on enables target-leading.
 */
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

/**
 * Spawn one bot archer at a random spot on the right half of the map.
 *
 * `caps` lets callers override the bot's per-instance capabilities (e.g.
 * a future "wave N spawns strafing bots" rule can pass `canStrafe: true`).
 * Anything not specified falls back to {@link DEFAULT_BOT_CAPS}.
 */
function spawnBot(caps: Partial<BotCaps> = {}): number {
  const id = nextEntityId++;
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
  botState.set(id, {
    caps: { ...DEFAULT_BOT_CAPS, ...caps },
    strafe: null,
  });
  return id;
}

function ensureBots() {
  // Drop ids whose units died
  for (const id of [...botUnitIds]) {
    if (!units.has(id)) {
      botUnitIds.delete(id);
      botState.delete(id);
    }
  }
  // Skip respawning entirely while a match is in progress -- modes like
  // Hardpoint remove bots at start and want them to stay gone until the
  // match ends.
  if (matchManager.isInMatch()) return;
  if (!BOT_RESPAWN && botUnitIds.size === 0) return;
  while (botUnitIds.size < BOT_COUNT) spawnBot();
}

/** Despawn every bot. Called by the match manager when a match starts. */
function removeAllBots() {
  for (const id of botUnitIds) units.delete(id);
  botUnitIds.clear();
  botState.clear();
}

/** One-shot bot spawn up to BOT_COUNT (used at match end regardless of BOT_RESPAWN). */
function spawnBotsToCount() {
  while (botUnitIds.size < BOT_COUNT) spawnBot();
}

const matchManager = new MatchManager({
  removeBots: removeAllBots,
  spawnBots: spawnBotsToCount,
  connectedHumans: () => [...clients].map((c) => c.player),
});

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

const COLLISION_ITERS = 2;
const MIN_UNIT_DIST = UNIT_RADIUS * 2;
const MIN_UNIT_DIST2 = MIN_UNIT_DIST * MIN_UNIT_DIST;

/**
 * Soft-body unit-vs-unit collision pass.
 *
 * Runs an O(n²) pairwise check (cheap enough at io scale, <= ~150 units;
 * swap in a uniform spatial hash if the cap rises). Each overlapping pair
 * is pushed apart along their separation normal by half the overlap each;
 * we run the pass {@link COLLISION_ITERS} times to relax three-body jams.
 *
 * Two units that land exactly on top of each other (zero distance) are
 * separated along a deterministic axis derived from their ids so the
 * outcome is stable rather than dependent on iteration order.
 *
 * Finally, every unit is clamped inside the map bounds.
 */
function resolveCollisions() {
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

/**
 * Solve for the time `t > 0` at which a projectile fired from `(sx, sy)`
 * at speed `projSpeed` would meet a target currently at `(tx, ty)` moving
 * with velocity `(vx, vy)`. This is the standard linear-intercept
 * quadratic:
 *
 *   |(T₀ + V·t) - S| = projSpeed · t
 *   ⇒ (V² - projSpeed²)·t² + 2·(D·V)·t + |D|² = 0
 *
 * where D = T₀ - S. Returns the smallest positive root, or `null` if
 * the target is faster than the projectile and running away (no real
 * solution). Used by {@link fireAt} when ballistics is on.
 */
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

/**
 * Spawn a projectile from `u` toward `target`. With ballistics enabled,
 * we lead the target via {@link interceptTimeAt} using the shooter's
 * actual (upgraded) projectile speed; otherwise we aim at the target's
 * current position.
 *
 * The spawned projectile bakes in `dmg` and `vx/vy` from the shooter's
 * effective stats at fire time, so subsequent damage / projectile-speed
 * upgrades don't retroactively change in-flight arrows.
 *
 * Side effect: sets `u.cooldown = UNIT_ATTACK_CD` (post-shot reload).
 */
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

/**
 * Apply an ability cast. Validates ownership, unlock state, and per-unit
 * cooldown for each id, then dispatches to the per-ability effect.
 *
 * Effects are intentionally instantaneous server-side — the client sees
 * the result via the next snapshot. For more complex casts (channeling,
 * AoE damage) this is the seam to extend.
 */
function castAbility(
  player: PlayerId,
  client: Client,
  kind: AbilityKind,
  ids: number[],
  x: number,
  y: number,
) {
  const def = ABILITIES[kind];
  if (!def) return;
  const ps = ensurePlayerStats(player);
  if ((ps.abilities[kind] ?? 0) <= 0) return; // not unlocked
  const owned = new Set(client.unitIds);
  for (const id of ids) {
    if (!owned.has(id)) continue;
    const u = units.get(id);
    if (!u) continue;
    const cd = u.abilityCds?.[kind] ?? 0;
    if (cd > 0) continue;
    if (kind === "blink") {
      // Teleport toward (x,y), capped at BLINK_MAX_DIST. Then clamp to map.
      const dx = x - u.x;
      const dy = y - u.y;
      const d = Math.hypot(dx, dy);
      const step = Math.min(d, BLINK_MAX_DIST);
      if (d > 0) {
        u.x += (dx / d) * step;
        u.y += (dy / d) * step;
      }
      if (u.x < UNIT_RADIUS) u.x = UNIT_RADIUS;
      else if (u.x > MAP_W - UNIT_RADIUS) u.x = MAP_W - UNIT_RADIUS;
      if (u.y < UNIT_RADIUS) u.y = UNIT_RADIUS;
      else if (u.y > MAP_H - UNIT_RADIUS) u.y = MAP_H - UNIT_RADIUS;
      // Drop ALL prior movement intent so the unit doesn't immediately
      // resume walking toward an old waypoint or chasing an old target.
      u.targetX = null;
      u.targetY = null;
      u.attackMove = false;
      u.attackTargetId = null;
      // Cancel any in-progress aim so the teleport doesn't release a shot
      // from the wrong origin on the next tick.
      u.windup = 0;
      // Brief post-blink lockout so movement commands don't take effect
      // for a fraction of a second after landing -- gives the teleport a
      // clean visual settle.
      u.moveLockSec = BLINK_MOVE_LOCK_SEC;
    }
    if (!u.abilityCds) u.abilityCds = {};
    u.abilityCds[kind] = def.cooldownSec;
  }
}

/**
 * Per-tick bot AI update.
 *
 * Each bot locks `attackTargetId` to the nearest non-bot unit. The shared
 * {@link step} pipeline then chases, winds up, fires, and (during cooldown)
 * strafes around the target — identical to a human-issued attack-click
 * plus the bot-only strafe rule in `step()`.
 *
 * Cheap enough to run every tick (`B * N` distance checks). When other AI
 * flavors (skirmisher, defender, …) are added, branch in here.
 */
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

/**
 * Advance the simulation by `dt` seconds. This is the heart of the server.
 *
 * For every unit, in order:
 *
 *   1. Decrement `cooldown`.
 *   2. Resolve a focused-fire `attackTargetId` lock (drop if dead/friendly).
 *   3. Decide whether to engage this tick:
 *        - locked + in range: yes (forces a stop, accumulates windup).
 *        - idle (no command): yes if any enemy is in range.
 *        - attack-move with waypoint: yes if any enemy is in range
 *          (stutter-step: stop, wind up, fire, then resume moving).
 *        - plain right-click move: never; the unit ignores enemies.
 *      When engaging, accumulate `windup`; once it crosses the threshold,
 *      call {@link fireAt} and reset windup. Movement is forced off this
 *      tick so the shot has a stable origin.
 *   4. If locked + in range and not winding (i.e. on cooldown):
 *        - bots strafe perpendicular to the target line at full effective
 *          speed (direction picked once per cooldown via {@link botMemory},
 *          with a 70/30 persistence bias across cooldowns to produce visible
 *          circle-strafing rather than per-tick jitter).
 *        - player units simply hold position.
 *   5. Otherwise apply movement: chase the locked target if out of range,
 *      else step toward `targetX/Y` (clearing the waypoint on arrival).
 *
 * After the per-unit pass we run {@link resolveCollisions} (soft-body
 * separation) and integrate projectiles, applying damage and crediting
 * kills to the projectile owner's playerStats (humans only).
 */
function step(dt: number) {
  // Units
  for (const u of units.values()) {
    if (u.cooldown > 0) u.cooldown = Math.max(0, u.cooldown - dt);

    // Tick down per-ability cooldowns; sparse-prune ready abilities so the
    // protocol stays compact (snapshot omits keys that are at zero).
    if (u.abilityCds) {
      for (const k in u.abilityCds) {
        const kk = k as AbilityKind;
        const v = u.abilityCds[kk]!;
        const next = v - dt;
        if (next <= 0) delete u.abilityCds[kk];
        else u.abilityCds[kk] = next;
      }
    }
    // Tick down the post-displacement movement lock and clear when done.
    if (u.moveLockSec !== undefined) {
      const next = u.moveLockSec - dt;
      if (next <= 0) delete u.moveLockSec;
      else u.moveLockSec = next;
    }

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

    // Targeting:
    //   - locked: only consider the locked target, only if in range
    //   - idle / attack-move: auto-acquire nearest enemy in range
    //   - plain move (waypoint without attackMove and no locked): never fire
    // We resolve the in-range enemy regardless of cooldown so we can stop
    // an attack-moving unit from walking past its firing position while
    // its weapon is still on cooldown -- a unit that "could" shoot if its
    // cooldown were ready should stand still, not stutter forward.
    const shouldAutoTarget =
      hasLocked || idle || (hasWaypoint && u.attackMove);
    let enemyInRange: UnitState | null = null;
    let inRangeOfLocked = false;
    if (shouldAutoTarget) {
      if (hasLocked) {
        const d2 = dist2(u.x, u.y, lockedEnemy!.x, lockedEnemy!.y);
        if (d2 <= range2) {
          enemyInRange = lockedEnemy;
          inRangeOfLocked = true;
        }
      } else {
        const e = findNearestEnemy(u);
        if (e && dist2(u.x, u.y, e.x, e.y) <= range2) {
          enemyInRange = e;
        }
      }
    }

    // Attack-move "stand and shoot": once a target is in range, hold
    // position even during cooldown. The locked-target case is handled
    // further down (strafe-or-hold block) so we leave hasLocked to it.
    if (enemyInRange && hasWaypoint && u.attackMove && !hasLocked) {
      moveThisTick = false;
    }

    let winding = false;
    if (enemyInRange && u.cooldown === 0) {
      winding = true;
      moveThisTick = false; // must hold still to wind up / fire
      u.windup = Math.min(UNIT_ATTACK_WINDUP, u.windup + dt);
      if (u.windup >= UNIT_ATTACK_WINDUP) {
        fireAt(u, enemyInRange);
        u.windup = 0;
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
        const bs = u.owner === BOT_PLAYER ? botState.get(u.id) : null;
        if (bs?.caps.canStrafe && u.cooldown > 0) {
          let st = bs.strafe;
          if (!st) {
            st = {
              dir: Math.random() < 0.5 ? -1 : 1,
              lastCd: u.cooldown,
            };
            bs.strafe = st;
          } else if (u.cooldown > st.lastCd) {
            // Cooldown just rose -> we fired last tick. Re-pick with bias.
            if (Math.random() < 0.3) {
              st.dir = st.dir === 1 ? -1 : 1;
            }
          }
          st.lastCd = u.cooldown;
          // Perpendicular: rotate (dx,dy) 90deg, scaled by direction sign.
          const dx = lockedEnemy!.x - u.x;
          const dy = lockedEnemy!.y - u.y;
          const d = Math.hypot(dx, dy) || 1;
          const px = (-dy / d) * st.dir;
          const py = (dx / d) * st.dir;
          u.x += px * eff.speed * dt;
          u.y += py * eff.speed * dt;
          moveThisTick = false; // skip the default chase/hold path
        } else {
          moveThisTick = false; // hold (player units, non-strafe bots)
        }
      }
    }

    // Movement -- skipped entirely while the post-blink settle lock is
    // active so a freshly-teleported unit doesn't slide off toward a
    // stale or freshly-issued waypoint within the same tick.
    if (moveThisTick && !u.moveLockSec) {
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
  // Set of currently-connected player ids, used to mark leaderboard rows
  // as online/offline. Built fresh per snapshot -- O(clients) is trivial.
  const connectedPlayers = new Set<PlayerId>();
  for (const c of clients) connectedPlayers.add(c.player);
  const leaderboard: LeaderboardEntry[] = [];
  for (const [pid, ps] of playerStats) {
    leaderboard.push({
      player: pid,
      kills: ps.kills,
      connected: connectedPlayers.has(pid),
    });
  }
  // Stable sort: kills desc, then player id asc as a deterministic tiebreaker.
  leaderboard.sort((a, b) => b.kills - a.kills || a.player - b.player);
  const match = matchManager.publicMatchState(units) ?? undefined;
  const vote = matchManager.publicVoteState() ?? undefined;
  const matchEnded = matchManager.endedBannerState() ?? undefined;
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
      abilities: { ...s.abilities },
    },
    leaderboard,
    match,
    vote,
    matchEnded,
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

/**
 * Static-file handler for the production single-port deployment.
 *
 * Resolves request paths under `dist/`, blocks any path-traversal that
 * escapes the dist root, falls back to `index.html` for unknown paths
 * (SPA-style), and tags hashed `assets/*` files with long-lived
 * immutable caching while keeping `index.html` non-cached.
 *
 * If `dist/` doesn't exist (i.e. the developer hasn't run `npm run build`),
 * we return a helpful 503 explaining how to run dev or build for prod.
 */
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
    } else if (msg.t === "buyAbility") {
      const def = ABILITIES[msg.kind as AbilityKind];
      if (!def) return;
      const ps = ensurePlayerStats(player);
      const cur = ps.abilities[msg.kind as AbilityKind] ?? 0;
      if (ps.points <= 0) return;
      if (cur >= def.max) return;
      ps.points -= 1;
      ps.abilities[msg.kind as AbilityKind] = cur + 1;
      console.log(
        `[server] player ${player} unlocked ${msg.kind}`,
      );
    } else if (msg.t === "useAbility") {
      castAbility(player, client, msg.kind, msg.ids, msg.x, msg.y);
    } else if (msg.t === "proposeMatch") {
      matchManager.proposeMatch(player, msg.mode);
    } else if (msg.t === "vote") {
      matchManager.castVote(player, msg.choice);
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    for (const id of client.unitIds) units.delete(id);
    matchManager.onPlayerDisconnected(player);
    // Keep playerStats around after disconnect so the leaderboard still
    // shows the player's score (with `connected: false`). They're cheap
    // to retain and re-attaching by player id isn't currently supported.
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
  // Match logic AFTER physics so the hardpoint scan reads post-step
  // positions. Match may end and trigger spawnBots on its way out, which
  // is fine -- next ensureBots() call below will be a no-op in that tick
  // (already at count) and the cycle resumes normally next tick.
  matchManager.tick(units, dt);
  ensureBots();
  broadcast();
}, 1000 / TICK_HZ);
