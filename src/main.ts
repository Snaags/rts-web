import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import {
  ABILITIES,
  ABILITY_ORDER,
  AbilityKind,
  ClientMsg,
  EntityId,
  LeaderboardEntry,
  MAP_H,
  MAP_W,
  PROJ_RADIUS,
  PlayerStats,
  ProjectileState,
  ServerMsg,
  Snapshot,
  UNIT_ATTACK_WINDUP,
  UNIT_RADIUS,
  UPGRADES,
  UPGRADE_ORDER,
  UnitState,
  UpgradeKind,
  effectiveRange,
  emptyAbilities,
  emptyUpgrades,
} from "../shared/protocol";

const INTERP_DELAY_MS = 100;

let zoomLevel = 1.0;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;

let panX = 0;
let panY = 0;
const EDGE_THRESHOLD = 50;
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;

interface Buffered {
  recvTime: number;
  serverTime: number;
  units: Map<EntityId, UnitState>;
  projectiles: Map<EntityId, ProjectileState>;
}

const snapshots: Buffered[] = [];
let myPlayer = 0;
let myUnitIds = new Set<EntityId>();
let selected = new Set<EntityId>();
let attackModePending = false;
let serverTimeOffset = 0; // serverTime - clientTime at recv
let serverOptions = { ballistics: false };
let myStats: PlayerStats = {
  kills: 0,
  points: 0,
  upgrades: emptyUpgrades(),
  abilities: emptyAbilities(),
};
// Last known cursor position in WORLD coordinates. Updated on every
// mousemove so abilities like Blink can fire instantly toward where the
// player is currently pointing without a separate targeting step.
let lastMouseWorld: { x: number; y: number } = { x: 0, y: 0 };
// Control groups 0-9. Each holds a stable set of unit ids; dead units are
// pruned each snapshot so a group of 5 archers becomes a group of 4 etc.
const controlGroups = new Map<number, Set<EntityId>>();

const statsEl = document.getElementById("stats")!;
const upgradesEl = document.getElementById("upgrades")!;
const groupsEl = document.getElementById("groups")!;
const leaderboardEl = document.getElementById("leaderboard")!;
let leaderboard: LeaderboardEntry[] = [];

// Visible boot/connection status. Renders even if Pixi or the WS dies, so
// failures over Cloudflare/Caddy/etc. are diagnosable without devtools.
const statusEl = document.createElement("div");
statusEl.id = "status";
statusEl.style.cssText =
  "position:absolute;bottom:8px;left:8px;font-size:12px;font-family:ui-monospace,monospace;opacity:0.85;color:#ddd;pointer-events:none;";
document.body.appendChild(statusEl);
let bootStage = "starting";
let wsStage = "idle";
let lastSnapAt = 0;
function renderStatus(extra = "") {
  const since = lastSnapAt ? `${Math.round(performance.now() - lastSnapAt)}ms ago` : "never";
  statusEl.textContent = `boot=${bootStage}  ws=${wsStage}  lastSnap=${since}${extra ? "  " + extra : ""}`;
}
renderStatus();
window.addEventListener("error", (e) => {
  bootStage = `error: ${e.message}`;
  renderStatus();
});
window.addEventListener("unhandledrejection", (e) => {
  bootStage = `rejected: ${(e.reason && e.reason.message) || e.reason}`;
  renderStatus();
});

// Kick off the WebSocket connection NOW, before awaiting Pixi, so the
// status line works even if rendering hangs. (See the WS handler block below
// for the actual onmessage logic.)
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
wsStage = `connecting (${wsUrl})`;
renderStatus();
const ws = new WebSocket(wsUrl);

// Renderer config:
//   - prefer WebGL (WebGPU is patchy in some browsers)
//   - preferWebGLVersion: 1  -- WebGL2 has known driver crashes on some
//     Intel iGPUs / software-rendering paths that manifest as immediate
//     context loss. WebGL1 has the broadest support and Pixi v8 still works
//     correctly on it.
//   - antialias off (cheaper, fewer driver paths)
//   - allow software rendering (don't bail on perf caveats)
//   - low-power preference (uses iGPU on hybrid laptops, more stable)
const app = new Application();
const PIXI_INIT_TIMEOUT_MS = 15000;
async function tryInit(opts: Parameters<typeof app.init>[0]): Promise<void> {
  await Promise.race([
    app.init(opts),
    new Promise((_, rej) =>
      setTimeout(
        () => rej(new Error(`pixi init timed out after ${PIXI_INIT_TIMEOUT_MS}ms`)),
        PIXI_INIT_TIMEOUT_MS,
      ),
    ),
  ]);
}

try {
  bootStage = "pixi-init webgl1";
  renderStatus();
  await tryInit({
    resizeTo: window,
    background: 0x0b0d10,
    antialias: false,
    preference: "webgl",
    preferWebGLVersion: 1,
    powerPreference: "low-power",
    failIfMajorPerformanceCaveat: false,
  } as Parameters<typeof app.init>[0]);
  bootStage = "pixi-ok (webgl1)";
  renderStatus();
} catch (err1) {
  // Fallback: try WebGL2 in case WebGL1 isn't available on this browser
  console.warn("[client] webgl1 init failed, retrying webgl2", err1);
  bootStage = "pixi-init webgl2 (fallback)";
  renderStatus();
  try {
    await tryInit({
      resizeTo: window,
      background: 0x0b0d10,
      antialias: false,
      preference: "webgl",
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: false,
    } as Parameters<typeof app.init>[0]);
    bootStage = "pixi-ok (webgl2)";
    renderStatus();
  } catch (err2) {
    bootStage = `pixi-failed: ${(err2 as Error).message}`;
    renderStatus();
    throw err2;
  }
}
document.getElementById("app")!.appendChild(app.canvas);
// Surface WebGL context loss/restoration as it happens.
app.canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  bootStage = "webgl-context-lost";
  renderStatus();
});
app.canvas.addEventListener("webglcontextrestored", () => {
  bootStage = "webgl-restored";
  renderStatus();
});

// World container, centered + scaled to fit
const world = new Container();
app.stage.addChild(world);

/**
 * Apply the current zoom + pan to the world container.
 *
 * The world is always centered in the viewport at zero pan; `panX`/`panY`
 * are additive offsets driven by edge-pan, middle-mouse drag, and the
 * cursor-anchored zoom math in the wheel handler. We only CLAMP pan in
 * here -- never reset it -- because resetting would silently undo the
 * cursor-anchor adjustment the wheel handler just computed.
 *
 * Pan is allowed to push the map a `PAN_MARGIN` fraction off either edge
 * so the player can peek slightly past the boundary; beyond that the
 * clamp keeps the map roughly on-screen.
 */
function fitWorld() {
  const sx = window.innerWidth / MAP_W;
  const sy = window.innerHeight / MAP_H;
  const baseScale = Math.min(sx, sy);
  const s = baseScale * zoomLevel;
  const scaledW = MAP_W * s;
  const scaledH = MAP_H * s;
  const PAN_MARGIN = 0.33;

  // Center the map by default; pan offsets layer on top.
  const cx = (window.innerWidth - scaledW) / 2;
  const cy = (window.innerHeight - scaledH) / 2;

  // Allowed pan range: enough to fully expose any side that's off-screen,
  // plus PAN_MARGIN of the scaled map size as overshoot slack.
  const slackX =
    Math.max(0, scaledW - window.innerWidth) + scaledW * PAN_MARGIN;
  const slackY =
    Math.max(0, scaledH - window.innerHeight) + scaledH * PAN_MARGIN;
  panX = Math.max(-slackX, Math.min(slackX, panX));
  panY = Math.max(-slackY, Math.min(slackY, panY));

  world.scale.set(s);
  world.position.set(cx + panX, cy + panY);
}
fitWorld();
window.addEventListener("resize", fitWorld);

// Mouse-wheel zoom, anchored at the cursor: the world point under the
// cursor before the zoom should remain under the cursor after the zoom.
// We compute the post-zoom screen position of that world point, and push
// `panX`/`panY` by the gap so it lands back on the cursor.
app.canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel * delta));
    if (newZoom === zoomLevel) return;

    const rect = app.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // World point currently under the cursor.
    const worldX = (mx - world.position.x) / world.scale.x;
    const worldY = (my - world.position.y) / world.scale.y;

    zoomLevel = newZoom;
    fitWorld();

    // Push pan by however far that world point drifted from the cursor.
    panX += mx - (worldX * world.scale.x + world.position.x);
    panY += my - (worldY * world.scale.y + world.position.y);
    fitWorld();
  },
  { passive: false },
);

let isPanning = false;
let lastPanMouseX = 0;
let lastPanMouseY = 0;

app.canvas.addEventListener("mousedown", (e) => {
  if (e.button === 1) {
    e.preventDefault();
    isPanning = true;
    lastPanMouseX = e.clientX;
    lastPanMouseY = e.clientY;
    app.canvas.style.cursor = "grabbing";
  }
});

window.addEventListener("mouseup", (e) => {
  if (e.button === 1 && isPanning) {
    isPanning = false;
    app.canvas.style.cursor = "default";
  }
});

window.addEventListener("mousemove", (e) => {
  if (isPanning) {
    const dx = e.clientX - lastPanMouseX;
    const dy = e.clientY - lastPanMouseY;
    panX += dx;
    panY += dy;
    lastPanMouseX = e.clientX;
    lastPanMouseY = e.clientY;
    fitWorld();
  }
  const rect = app.canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
});

// Background
const bg = new Graphics()
  .rect(0, 0, MAP_W, MAP_H)
  .fill(0x14181d)
  .stroke({ width: 2, color: 0x2a313a });
world.addChild(bg);

// Grid
const grid = new Graphics();
for (let x = 0; x <= MAP_W; x += 100) {
  grid.moveTo(x, 0).lineTo(x, MAP_H);
}
for (let y = 0; y <= MAP_H; y += 100) {
  grid.moveTo(0, y).lineTo(MAP_W, y);
}
grid.stroke({ width: 1, color: 0x1d242c });
world.addChild(grid);

const unitsLayer = new Container();
world.addChild(unitsLayer);
const projLayer = new Container();
world.addChild(projLayer);
const overlayLayer = new Container();
world.addChild(overlayLayer);

const unitGfx = new Map<EntityId, Graphics>();
const groupLabelGfx = new Map<EntityId, Text>();
const projGfx = new Map<EntityId, Graphics>();
const selectionRing = new Graphics();
overlayLayer.addChild(selectionRing);
const dragBox = new Graphics();
overlayLayer.addChild(dragBox);
const moveMarker = new Graphics();
overlayLayer.addChild(moveMarker);
let moveMarkerAt = 0;

// Networking - the `ws` object was created above (before Pixi init); we just
// attach the message/lifecycle handlers here.
ws.onopen = () => {
  wsStage = "open";
  renderStatus();
  console.log("[client] connected");
};
ws.onclose = (e) => {
  wsStage = `closed code=${e.code}${e.reason ? " " + e.reason : ""}`;
  renderStatus();
  console.log("[client] disconnected", e.code, e.reason);
};
ws.onerror = () => {
  wsStage = "error";
  renderStatus();
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data) as ServerMsg;
  if (msg.t === "hello") {
    myPlayer = msg.you;
    myUnitIds = new Set(msg.unitIds);
    wsStage = `hello P${myPlayer}`;
    renderStatus();
    return;
  }
  if (msg.t === "snap") {
    const now = Date.now();
    serverTimeOffset = msg.serverTime - now;
    if (msg.options) serverOptions = msg.options;
    if (msg.myStats) {
      myStats = msg.myStats;
    }
    if (msg.leaderboard) {
      leaderboard = msg.leaderboard;
      renderLeaderboard();
    }
    // Re-render the panel each snap so ability cooldown counters tick
    // visibly even when myStats itself didn't change.
    renderUpgradePanel();
    lastSnapAt = performance.now();
    wsStage = `streaming P${myPlayer}`;
    renderStatus();
    const buf: Buffered = {
      recvTime: now,
      serverTime: msg.serverTime,
      units: new Map(msg.units.map((u) => [u.id, u])),
      projectiles: new Map(msg.projectiles.map((p) => [p.id, p])),
    };
    snapshots.push(buf);
    // Cull old
    while (snapshots.length > 60) snapshots.shift();
    // Drop stale selection
    for (const id of [...selected]) {
      if (!buf.units.has(id)) selected.delete(id);
    }
    // Prune dead units from control groups; auto-clear groups that hit zero.
    let groupsChanged = false;
    for (const [n, ids] of controlGroups) {
      const before = ids.size;
      for (const id of [...ids]) if (!buf.units.has(id)) ids.delete(id);
      if (ids.size === 0) {
        controlGroups.delete(n);
        groupsChanged = true;
      } else if (ids.size !== before) {
        groupsChanged = true;
      }
    }
    if (groupsChanged) renderGroupsPanel();
    if (myUnitIds.size === 0) {
      myUnitIds = new Set(
        msg.units.filter((u) => u.owner === myPlayer).map((u) => u.id),
      );
    }
  }
};

function send(msg: ClientMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Input
const screenToWorld = (sx: number, sy: number) => {
  return {
    x: (sx - world.position.x) / world.scale.x,
    y: (sy - world.position.y) / world.scale.y,
  };
};

let dragStart: { x: number; y: number } | null = null;
let dragNow: { x: number; y: number } | null = null;

app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

/**
 * Hit-test for an enemy unit at world coordinates `(wx, wy)`.
 *
 * Iterates the latest snapshot, returns the id of the closest enemy
 * within `UNIT_RADIUS + 4` px (a small forgiving margin so clicks don't
 * have to be pixel-perfect), or `null` if none. Used by both right-click
 * and `A`+click to decide between "issue attack lock" and "issue move".
 */
function pickEnemyAt(wx: number, wy: number): EntityId | null {
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return null;
  let bestId: EntityId | null = null;
  let bestD = (UNIT_RADIUS + 4) ** 2;
  for (const u of latest.units.values()) {
    if (u.owner === myPlayer) continue;
    const d = (u.x - wx) ** 2 + (u.y - wy) ** 2;
    if (d < bestD) {
      bestD = d;
      bestId = u.id;
    }
  }
  return bestId;
}

window.addEventListener("mousedown", (e) => {
  const w = screenToWorld(e.clientX, e.clientY);
  if (e.button === 0) {
    if (attackModePending) {
      const enemyId = pickEnemyAt(w.x, w.y);
      if (enemyId !== null && selected.size > 0) {
        issueAttack(enemyId);
      } else {
        issueMove(w.x, w.y, true);
      }
      attackModePending = false;
      document.body.style.cursor = "default";
      return;
    }
    dragStart = w;
    dragNow = w;
  } else if (e.button === 2) {
    const enemyId = pickEnemyAt(w.x, w.y);
    if (enemyId !== null && selected.size > 0) {
      issueAttack(enemyId);
    } else {
      issueMove(w.x, w.y, false);
    }
  }
});

window.addEventListener("mousemove", (e) => {
  const w = screenToWorld(e.clientX, e.clientY);
  lastMouseWorld = w;
  if (dragStart) dragNow = w;
});

window.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !dragStart || !dragNow) return;
  const x0 = Math.min(dragStart.x, dragNow.x);
  const y0 = Math.min(dragStart.y, dragNow.y);
  const x1 = Math.max(dragStart.x, dragNow.x);
  const y1 = Math.max(dragStart.y, dragNow.y);
  const isClick = x1 - x0 < 4 && y1 - y0 < 4;
  const latest = snapshots[snapshots.length - 1];
  if (latest) {
    if (isClick) {
      // Pick single unit nearest to click
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      let bestId: EntityId | null = null;
      let bestD = (UNIT_RADIUS + 6) ** 2;
      for (const u of latest.units.values()) {
        if (u.owner !== myPlayer) continue;
        const d = (u.x - cx) ** 2 + (u.y - cy) ** 2;
        if (d < bestD) {
          bestD = d;
          bestId = u.id;
        }
      }
      selected.clear();
      if (bestId !== null) selected.add(bestId);
    } else {
      selected.clear();
      for (const u of latest.units.values()) {
        if (u.owner !== myPlayer) continue;
        if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) selected.add(u.id);
      }
    }
  }
  dragStart = null;
  dragNow = null;
});

window.addEventListener("keydown", (e) => {
  // Hotkey scheme:
  //   Shift+QWERT -> BUY the corresponding ability slot
  //   plain QWERT -> USE the corresponding ability (if unlocked) on the
  //                  current selection, toward the cursor
  //   Shift+ASDFG -> BUY the corresponding upgrade slot
  //   plain  ASDFG -> existing game actions (a=attack-move, s=stop, ...)
  // We check this block before anything else so it always wins.
  if (/^[a-zA-Z]$/.test(e.key)) {
    const k = e.key.toLowerCase();
    const abilityIdx = "qwert".indexOf(k);
    if (abilityIdx !== -1) {
      const kind = ABILITY_ORDER[abilityIdx];
      if (kind) {
        e.preventDefault();
        if (e.shiftKey) buyAbility(kind);
        else useAbility(kind);
        return;
      }
    }
    if (e.shiftKey) {
      const upgradeIdx = "asdfg".indexOf(k);
      if (upgradeIdx !== -1) {
        const kind = UPGRADE_ORDER[upgradeIdx];
        if (kind) {
          e.preventDefault();
          buyUpgrade(kind);
          return;
        }
      }
    }
  }
  if ((e.key === "a" || e.key === "A") && !e.shiftKey) {
    if (selected.size > 0) {
      attackModePending = true;
      document.body.style.cursor = "crosshair";
    }
  } else if ((e.key === "s" || e.key === "S") && !e.shiftKey) {
    if (selected.size > 0) {
      send({ t: "stop", ids: [...selected] });
    }
  } else if ((e.key === "b" || e.key === "B") && !e.shiftKey) {
    send({ t: "option", ballistics: !serverOptions.ballistics });
  } else if (e.key === "Escape") {
    attackModePending = false;
    document.body.style.cursor = "default";
    selected.clear();
  } else if (e.key === "Tab") {
    e.preventDefault();
    // Select all owned units
    const latest = snapshots[snapshots.length - 1];
    if (latest) {
      selected.clear();
      for (const u of latest.units.values())
        if (u.owner === myPlayer) selected.add(u.id);
    }
  } else if (/^[0-9]$/.test(e.key)) {
    // Control groups (RTS standard):
    //   Ctrl+N        -> bind currently selected units to group N (replace).
    //                    With nothing selected, this clears group N.
    //   Shift+N       -> add group N's units to current selection.
    //   N             -> replace selection with group N's living units.
    e.preventDefault();
    const n = parseInt(e.key, 10);
    if (e.ctrlKey || e.metaKey) {
      if (selected.size === 0) {
        controlGroups.delete(n);
      } else {
        // Snapshot the selection at bind time. Filter to owned + alive.
        const latest = snapshots[snapshots.length - 1];
        const bound = new Set<EntityId>();
        for (const id of selected) {
          const u = latest?.units.get(id);
          if (u && u.owner === myPlayer) bound.add(id);
        }
        if (bound.size === 0) {
          controlGroups.delete(n);
        } else {
          // Each unit belongs to AT MOST one group: strip these ids from
          // any other group, deleting groups that go empty.
          const toDelete: number[] = [];
          for (const [otherN, otherIds] of controlGroups) {
            if (otherN === n) continue;
            for (const id of bound) otherIds.delete(id);
            if (otherIds.size === 0) toDelete.push(otherN);
          }
          for (const k of toDelete) controlGroups.delete(k);
          controlGroups.set(n, bound);
        }
      }
      renderGroupsPanel();
    } else {
      const group = controlGroups.get(n);
      if (!group || group.size === 0) return;
      const latest = snapshots[snapshots.length - 1];
      if (!latest) return;
      // Filter to alive + still-owned. The snapshot pass below also prunes
      // dead ids from the group itself, but be defensive here too.
      const alive: EntityId[] = [];
      for (const id of group)
        if (latest.units.get(id)?.owner === myPlayer) alive.push(id);
      if (alive.length === 0) {
        controlGroups.delete(n);
        renderGroupsPanel();
        return;
      }
      if (e.shiftKey) {
        for (const id of alive) selected.add(id);
      } else {
        selected = new Set(alive);
      }
    }
  }
});

/**
 * Send a {@link BuyUpgradeCmd} to the server and optimistically reflect
 * the change in the local UI.
 *
 * The server is authoritative — it validates points/level cap and the
 * next snapshot will overwrite `myStats`. We mutate locally first so
 * the panel responds within the same frame instead of after one tick of
 * round-trip lag, which matters at io-game cadence.
 */
function buyUpgrade(kind: UpgradeKind) {
  const def = UPGRADES[kind];
  const cur = myStats.upgrades[kind] ?? 0;
  if (cur >= def.max) return;
  if (myStats.points <= 0) return;
  send({ t: "upgrade", kind });
  myStats = {
    ...myStats,
    points: myStats.points - 1,
    upgrades: { ...myStats.upgrades, [kind]: cur + 1 },
  };
  renderUpgradePanel();
}

/**
 * Spend one upgrade point to unlock an ability slot. No-op if already
 * unlocked or the player has no points.
 *
 * Same optimistic-update pattern as {@link buyUpgrade}: we mutate myStats
 * locally and re-render so the panel responds within the same frame; the
 * next snapshot from the server is authoritative.
 */
function buyAbility(kind: AbilityKind) {
  const def = ABILITIES[kind];
  const cur = myStats.abilities[kind] ?? 0;
  if (cur >= def.max) return;
  if (myStats.points <= 0) return;
  send({ t: "buyAbility", kind });
  myStats = {
    ...myStats,
    points: myStats.points - 1,
    abilities: { ...myStats.abilities, [kind]: cur + 1 },
  };
  renderUpgradePanel();
}

/**
 * Cast an ability on the current selection, targeted at the last known
 * mouse position in world space. No-op if the ability isn't unlocked or
 * nothing is selected. Per-unit cooldowns are enforced server-side, so
 * we don't pre-filter the id list here.
 */
function useAbility(kind: AbilityKind) {
  const cur = myStats.abilities[kind] ?? 0;
  if (cur <= 0) return;
  if (selected.size === 0) return;
  send({
    t: "useAbility",
    kind,
    ids: [...selected],
    x: lastMouseWorld.x,
    y: lastMouseWorld.y,
  });
}

/**
 * Render the right-side panel: a header with kills/points, then an
 * Abilities section (one row per `ABILITY_ORDER` entry) and an Upgrades
 * section (one row per `UPGRADE_ORDER` entry).
 *
 * Abilities show "locked" / "ready" / "X.Xs" (the smallest cooldown across
 * the player's units that have started one). Upgrades show level/max +
 * the next-level effect, or "MAX" when capped.
 *
 * Each row carries its kind in a `data-kind` attribute and its slot type
 * in `data-slot` ("ability" or "upgrade") so the click handler can route
 * back to the right buy/use function.
 */
function renderUpgradePanel() {
  const head = `<div class="head">Kills: ${myStats.kills} &nbsp;·&nbsp; Points: ${myStats.points}</div>`;

  // Compute the smallest active cooldown across MY units, per ability.
  const minCdByKind: Partial<Record<AbilityKind, number>> = {};
  const latest = snapshots[snapshots.length - 1];
  if (latest) {
    for (const u of latest.units.values()) {
      if (u.owner !== myPlayer) continue;
      if (!u.abilityCds) continue;
      for (const kind of ABILITY_ORDER) {
        const cd = u.abilityCds[kind];
        if (cd === undefined) continue;
        const cur = minCdByKind[kind];
        if (cur === undefined || cd < cur) minCdByKind[kind] = cd;
      }
    }
  }

  const abilityRows = ABILITY_ORDER.map((kind) => {
    const def = ABILITIES[kind];
    const lvl = myStats.abilities[kind] ?? 0;
    const unlocked = lvl >= def.max;
    let cls: string;
    let desc: string;
    if (!unlocked) {
      const affordable = myStats.points > 0;
      cls = affordable ? "row" : "row disabled";
      desc = "BUY";
    } else {
      const cd = minCdByKind[kind];
      if (cd !== undefined && cd > 0) {
        cls = "row maxed"; // "owned but on cooldown"
        desc = `${cd.toFixed(1)}s`;
      } else {
        cls = "row maxed";
        desc = "READY";
      }
    }
    return `<div class="${cls}" data-slot="ability" data-kind="${kind}"><span class="key">${def.hotkey}</span><span class="name">${def.name}</span><span class="lvl">${lvl}/${def.max}</span><span class="desc">${desc}</span></div>`;
  }).join("");

  const upgradeRows = UPGRADE_ORDER.map((kind) => {
    const def = UPGRADES[kind];
    const lvl = myStats.upgrades[kind] ?? 0;
    const maxed = lvl >= def.max;
    const affordable = !maxed && myStats.points > 0;
    const cls = maxed ? "row maxed" : affordable ? "row" : "row disabled";
    const desc = maxed ? "MAX" : def.describe(lvl + 1);
    return `<div class="${cls}" data-slot="upgrade" data-kind="${kind}"><span class="key">${def.hotkey}</span><span class="name">${def.name}</span><span class="lvl">${lvl}/${def.max}</span><span class="desc">${desc}</span></div>`;
  }).join("");

  upgradesEl.innerHTML =
    head +
    `<div class="section">Abilities</div>` +
    abilityRows +
    `<div class="section">Upgrades</div>` +
    upgradeRows;
}

// Clicking a panel row only BUYS (whether ability or upgrade). Casting
// abilities is keyboard-only because a panel click has no target position.
upgradesEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest(".row") as HTMLElement | null;
  if (!row) return;
  const slot = row.getAttribute("data-slot");
  const kind = row.getAttribute("data-kind");
  if (!kind) return;
  if (slot === "ability") buyAbility(kind as AbilityKind);
  else buyUpgrade(kind as UpgradeKind);
});

function renderGroupsPanel() {
  if (controlGroups.size === 0) {
    groupsEl.innerHTML = "";
    return;
  }
  // Show populated groups in numeric order.
  const keys = [...controlGroups.keys()].sort((a, b) => a - b);
  const cells = keys
    .map((n) => {
      const count = controlGroups.get(n)?.size ?? 0;
      return `<span class="grp"><span class="grpkey">${n}</span><span class="grpcount">${count}</span></span>`;
    })
    .join("");
  groupsEl.innerHTML = cells;
}

// Click on a group cell selects that group (mouse equivalent of pressing N).
groupsEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const grp = target.closest(".grp") as HTMLElement | null;
  if (!grp) return;
  const keyEl = grp.querySelector(".grpkey");
  if (!keyEl) return;
  const n = parseInt(keyEl.textContent ?? "", 10);
  if (Number.isNaN(n)) return;
  const group = controlGroups.get(n);
  const latest = snapshots[snapshots.length - 1];
  if (!group || !latest) return;
  const alive: EntityId[] = [];
  for (const id of group)
    if (latest.units.get(id)?.owner === myPlayer) alive.push(id);
  if (alive.length > 0) selected = new Set(alive);
});

/**
 * Render the kill leaderboard.
 *
 * Server sends entries pre-sorted by kills desc, so we just walk the list.
 * The current player's row gets a subtle highlight; disconnected players
 * are dimmed but still listed so their score is preserved across drops.
 */
function renderLeaderboard() {
  if (leaderboard.length === 0) {
    leaderboardEl.innerHTML =
      `<div class="head">Leaderboard</div>` +
      `<div style="color:#5a6168;font-style:italic">no players yet</div>`;
    return;
  }
  const rows = leaderboard
    .map((e, i) => {
      const cls = [
        "row",
        e.player === myPlayer ? "me" : "",
        e.connected ? "" : "offline",
      ]
        .filter(Boolean)
        .join(" ");
      const tag = e.connected ? "" : " (offline)";
      return `<div class="${cls}"><span class="rank">#${i + 1}</span><span class="who">P${e.player}${tag}</span><span class="kills">${e.kills}</span></div>`;
    })
    .join("");
  leaderboardEl.innerHTML = `<div class="head">Leaderboard</div>` + rows;
}

// Initial render so the panels show even before the first snapshot arrives.
renderUpgradePanel();
renderGroupsPanel();
renderLeaderboard();

function issueMove(x: number, y: number, attackMove: boolean) {
  if (selected.size === 0) return;
  send({ t: "move", ids: [...selected], x, y, attackMove });
  moveMarkerAt = performance.now();
  moveMarker.clear();
  moveMarker
    .circle(x, y, 10)
    .stroke({ width: 2, color: attackMove ? 0xff5050 : 0x50ff80 });
}

function issueAttack(targetId: EntityId) {
  if (selected.size === 0) return;
  send({ t: "attack", ids: [...selected], targetId });
  // Marker drawn at the target's current position; the renderer then
  // lerps it along with everything else for the brief fade-out.
  const latest = snapshots[snapshots.length - 1];
  const t = latest?.units.get(targetId);
  if (t) {
    moveMarkerAt = performance.now();
    moveMarker.clear();
    moveMarker
      .circle(t.x, t.y, UNIT_RADIUS + 6)
      .stroke({ width: 2, color: 0xff3030 });
  }
}

/**
 * Build a fully-interpolated world state for the current frame.
 *
 * The client renders at "render time" = `now - INTERP_DELAY_MS` (100 ms
 * behind the latest server snapshot). We find the two buffered snapshots
 * that straddle that timestamp and linearly interpolate every entity's
 * position between them. Trading 100 ms of perceived input latency for
 * smooth motion regardless of network jitter is the standard online-action
 * trick.
 *
 * `windup` is interpolated only when increasing — when it drops (a shot
 * fired, or the unit moved) we snap to the new value so the visual
 * "charging" pip pops cleanly off, instead of fading.
 *
 * Returns `null` until the first snapshot arrives.
 */
function getInterpolated(): {
  units: Map<EntityId, UnitState>;
  projectiles: Map<EntityId, ProjectileState>;
} | null {
  if (snapshots.length === 0) return null;
  const renderServerTime = Date.now() + serverTimeOffset - INTERP_DELAY_MS;
  // Find two snapshots straddling renderServerTime
  let a: Buffered | null = null;
  let b: Buffered | null = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].serverTime <= renderServerTime) {
      a = snapshots[i];
      b = snapshots[i + 1] ?? null;
      break;
    }
  }
  if (!a) a = snapshots[0];
  if (!b) {
    return { units: a.units, projectiles: a.projectiles };
  }
  const span = b.serverTime - a.serverTime;
  const t = span > 0 ? (renderServerTime - a.serverTime) / span : 0;
  const tt = Math.max(0, Math.min(1, t));

  const units = new Map<EntityId, UnitState>();
  for (const [id, ua] of a.units) {
    const ub = b.units.get(id);
    if (!ub) {
      units.set(id, ua);
    } else {
      units.set(id, {
        ...ub,
        x: ua.x + (ub.x - ua.x) * tt,
        y: ua.y + (ub.y - ua.y) * tt,
        // Only smooth windup if both samples agree it's increasing; resets to 0
        // are instantaneous so the visual snaps off cleanly when the unit moves.
        windup: ub.windup < ua.windup ? ub.windup : ua.windup + (ub.windup - ua.windup) * tt,
      });
    }
  }
  const projectiles = new Map<EntityId, ProjectileState>();
  for (const [id, pa] of a.projectiles) {
    const pb = b.projectiles.get(id);
    if (!pb) {
      projectiles.set(id, pa);
    } else {
      projectiles.set(id, {
        ...pb,
        x: pa.x + (pb.x - pa.x) * tt,
        y: pa.y + (pb.y - pa.y) * tt,
      });
    }
  }
  return { units, projectiles };
}

function colorForOwner(owner: number, mine: boolean) {
  if (mine) return 0x4fa3ff;
  // Cycle through some hostile colors
  const palette = [0xff5050, 0xffaa3a, 0xc066ff, 0x66ff99];
  return palette[(owner - 1) % palette.length];
}

app.ticker.add(() => {
  const state = getInterpolated();
  // Drag box
  dragBox.clear();
  if (dragStart && dragNow) {
    const x0 = Math.min(dragStart.x, dragNow.x);
    const y0 = Math.min(dragStart.y, dragNow.y);
    const w = Math.abs(dragNow.x - dragStart.x);
    const h = Math.abs(dragNow.y - dragStart.y);
    dragBox
      .rect(x0, y0, w, h)
      .fill({ color: 0x4fa3ff, alpha: 0.08 })
      .stroke({ width: 1, color: 0x4fa3ff });
  }

  // Move marker fade
  const age = performance.now() - moveMarkerAt;
  moveMarker.alpha = Math.max(0, 1 - age / 600);

  // Edge panning - only when map exceeds viewport
  const scaledW = MAP_W * world.scale.x;
  const scaledH = MAP_H * world.scale.y;
  const mapExceedsViewport = scaledW > window.innerWidth || scaledH > window.innerHeight;
  
  if (mapExceedsViewport) {
    let panDeltaX = 0;
    let panDeltaY = 0;
    if (mouseX < EDGE_THRESHOLD) panDeltaX = EDGE_THRESHOLD - mouseX;
    else if (mouseX > window.innerWidth - EDGE_THRESHOLD) panDeltaX = (window.innerWidth - EDGE_THRESHOLD) - mouseX;
    if (mouseY < EDGE_THRESHOLD) panDeltaY = EDGE_THRESHOLD - mouseY;
    else if (mouseY > window.innerHeight - EDGE_THRESHOLD) panDeltaY = (window.innerHeight - EDGE_THRESHOLD) - mouseY;
    
    if (panDeltaX !== 0 || panDeltaY !== 0) {
      panX += panDeltaX;
      panY += panDeltaY;
      fitWorld();
    }
  }

  if (!state) return;

  // Units
  const seenU = new Set<EntityId>();
  for (const u of state.units.values()) {
    seenU.add(u.id);
    let g = unitGfx.get(u.id);
    if (!g) {
      g = new Graphics();
      unitsLayer.addChild(g);
      unitGfx.set(u.id, g);
    }
    g.clear();
    const mine = u.owner === myPlayer;
    const col = colorForOwner(u.owner, mine);
    g.circle(0, 0, UNIT_RADIUS).fill(col).stroke({ width: 1, color: 0x000000 });
    // Windup indicator: bright inner pip that grows from 0 to ~UNIT_RADIUS-2
    // as windup progresses; pops off the moment the shot fires or unit moves.
    const wfrac = Math.max(0, Math.min(1, u.windup / UNIT_ATTACK_WINDUP));
    if (wfrac > 0) {
      const r = 1.5 + wfrac * (UNIT_RADIUS - 3);
      g.circle(0, 0, r).fill({ color: 0xfff0a0, alpha: 0.55 + 0.4 * wfrac });
    }
    // HP bar
    const w = 22;
    const frac = Math.max(0, u.hp / u.maxHp);
    g.rect(-w / 2, -UNIT_RADIUS - 8, w, 3).fill(0x222831);
    g.rect(-w / 2, -UNIT_RADIUS - 8, w * frac, 3).fill(
      frac > 0.5 ? 0x66dd66 : frac > 0.25 ? 0xddaa44 : 0xdd4444,
    );
    g.position.set(u.x, u.y);
  }
  for (const [id, g] of unitGfx) {
    if (!seenU.has(id)) {
      g.destroy();
      unitGfx.delete(id);
    }
  }

  // Selection rings + range indicator
  selectionRing.clear();
  // Selection is owned-units-only, so myStats.upgrades.range applies to all
  // of them. Recomputed each frame so it tracks newly-bought upgrades.
  const myRange = effectiveRange(myStats.upgrades.range);
  for (const id of selected) {
    const u = state.units.get(id);
    if (!u) continue;
    // Light grey range circle so the player can see firing reach.
    selectionRing
      .circle(u.x, u.y, myRange)
      .stroke({ width: 1, color: 0xaaaaaa, alpha: 0.25 });
    // Tight green selection ring on top.
    selectionRing
      .circle(u.x, u.y, UNIT_RADIUS + 4)
      .stroke({ width: 2, color: 0x6cf07a });
    // If this unit has a focused-fire target, draw a faint red line + small
    // ring around the target so the player can see who's locked.
    if (u.attackTargetId !== null) {
      const t = state.units.get(u.attackTargetId);
      if (t) {
        selectionRing
          .moveTo(u.x, u.y)
          .lineTo(t.x, t.y)
          .stroke({ width: 1, color: 0xff5555, alpha: 0.35 });
        selectionRing
          .circle(t.x, t.y, UNIT_RADIUS + 5)
          .stroke({ width: 1.5, color: 0xff5050, alpha: 0.7 });
      }
    }
  }

  // Control-group badges: tiny number above selected units that belong to
  // a group. Each unit belongs to at most one group (enforced at bind time).
  const groupOf = new Map<EntityId, number>();
  for (const [n, ids] of controlGroups) {
    for (const id of ids) groupOf.set(id, n);
  }
  const seenLabels = new Set<EntityId>();
  for (const id of selected) {
    const u = state.units.get(id);
    if (!u) continue;
    const grp = groupOf.get(id);
    if (grp === undefined) continue;
    let lbl = groupLabelGfx.get(id);
    if (!lbl) {
      lbl = new Text({
        text: String(grp),
        style: {
          fontFamily: "system-ui, sans-serif",
          fontSize: 10,
          fontWeight: "600",
          fill: 0x0b0d10,
          stroke: { color: 0xcfd6dd, width: 3, join: "round" },
        },
      });
      lbl.anchor.set(0.5, 0.5);
      overlayLayer.addChild(lbl);
      groupLabelGfx.set(id, lbl);
    }
    const txt = String(grp);
    if (lbl.text !== txt) lbl.text = txt;
    // Top-right of the unit, just above the HP bar.
    lbl.position.set(u.x + UNIT_RADIUS + 2, u.y - UNIT_RADIUS - 6);
    seenLabels.add(id);
  }
  for (const [id, lbl] of groupLabelGfx) {
    if (!seenLabels.has(id)) {
      lbl.destroy();
      groupLabelGfx.delete(id);
    }
  }

  // Projectiles. The player's own shots render as a short arrow / tracer
  // streak oriented along the velocity vector -- easier to read at a
  // glance ("there go MY arrows") than the generic dot. Enemy projectiles
  // keep the legacy circle so incoming danger looks distinct from your
  // own outgoing fire.
  const seenP = new Set<EntityId>();
  for (const p of state.projectiles.values()) {
    seenP.add(p.id);
    let g = projGfx.get(p.id);
    if (!g) {
      g = new Graphics();
      projLayer.addChild(g);
      projGfx.set(p.id, g);
    }
    g.clear();
    const mine = p.owner === myPlayer;
    if (mine) {
      // Arrow: a short tail + bright head, rotated along velocity. The tip
      // sits at local (0,0) so the visual position matches the server's
      // simulated point exactly (no offset between sprite and hit-test).
      const tail = 12;
      g.rotation = Math.atan2(p.vy, p.vx);
      g.moveTo(-tail, 0)
        .lineTo(0, 0)
        .stroke({ width: 2, color: 0xb6e3ff, alpha: 0.9 });
      g.circle(0, 0, 2).fill(0xeaf6ff);
    } else {
      g.rotation = 0;
      g.circle(0, 0, PROJ_RADIUS).fill(0xffd070);
    }
    g.position.set(p.x, p.y);
  }
  for (const [id, g] of projGfx) {
    if (!seenP.has(id)) {
      g.destroy();
      projGfx.delete(id);
    }
  }

  // Stats
  const latest = snapshots[snapshots.length - 1];
  const myAlive = latest
    ? [...latest.units.values()].filter((u) => u.owner === myPlayer).length
    : 0;
  const enemies = latest
    ? [...latest.units.values()].filter((u) => u.owner !== myPlayer).length
    : 0;
  statsEl.textContent = `you=P${myPlayer} units=${myAlive} enemies=${enemies} sel=${selected.size} ballistics=${serverOptions.ballistics ? "ON" : "off"}`;
});

// Prevent text selection on drag
document.body.addEventListener("selectstart", (e) => e.preventDefault());

// Hint pixi about hit area
app.stage.eventMode = "static";
app.stage.hitArea = new Rectangle(0, 0, 99999, 99999);
