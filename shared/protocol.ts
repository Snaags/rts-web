export const MAP_W = 1600;
export const MAP_H = 900;
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;

export type EntityId = number;
export type PlayerId = number;

export interface UnitState {
  id: EntityId;
  owner: PlayerId;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cooldown: number; // seconds until reload finishes (post-shot recovery)
  windup: number; // seconds spent stopped & aiming since last move/shot
  targetX: number | null;
  targetY: number | null;
  attackMove: boolean;
  attackTargetId: EntityId | null; // focused-fire target (overrides nearest)
  // Sparse map of per-unit ability cooldowns in seconds. Missing keys are
  // ready (cooldown 0). Server prunes keys when they tick down to zero.
  abilityCds?: Partial<Record<AbilityKind, number>>;
  // Brief post-blink (or other displacement) lockout in seconds. While > 0
  // the unit ignores its own movement intent, giving the teleport a clean
  // landing instead of letting the prior command resume mid-step. Field is
  // omitted from snapshots when zero.
  moveLockSec?: number;
}

export interface ProjectileState {
  id: EntityId;
  owner: PlayerId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
  dmg: number; // damage locked in at fire-time (so damage upgrades only affect future shots)
}

export interface ServerOptions {
  ballistics: boolean;
}

// ---------- Upgrades ----------
export type UpgradeKind =
  | "range"
  | "ballistics"
  | "moveSpeed"
  | "projectileSpeed"
  | "damage";

export interface UpgradeDef {
  name: string;
  hotkey: string;
  max: number;
  describe: (level: number) => string;
}

// Per-level upgrade magnitudes. Kept here so server and client can compute
// effective stats from the same numbers (no drift between sim and HUD).
export const RANGE_PER_LEVEL = 30; // px

export function effectiveRange(rangeLevel: number): number {
  return UNIT_RANGE + RANGE_PER_LEVEL * rangeLevel;
}

// All purchasable rows are bought with shift+letter. The bare letters are
// reserved for game actions (e.g. plain `a` is still attack-move).
export const UPGRADES: Record<UpgradeKind, UpgradeDef> = {
  range: {
    name: "Range",
    hotkey: "⇧A",
    max: 5,
    describe: (l) => `+${l * RANGE_PER_LEVEL} px`,
  },
  ballistics: {
    name: "Ballistics",
    hotkey: "⇧S",
    max: 1,
    describe: (l) => (l > 0 ? "lead targets" : "off"),
  },
  moveSpeed: {
    name: "Move Speed",
    hotkey: "⇧D",
    max: 5,
    describe: (l) => `+${l * 15}%`,
  },
  projectileSpeed: {
    name: "Projectile Speed",
    hotkey: "⇧F",
    max: 5,
    describe: (l) => `+${l * 30}%`,
  },
  damage: {
    name: "Damage",
    hotkey: "⇧G",
    max: 5,
    describe: (l) => `+${l * 20}%`,
  },
};

export const UPGRADE_ORDER: UpgradeKind[] = [
  "range",
  "ballistics",
  "moveSpeed",
  "projectileSpeed",
  "damage",
];

export type UpgradeLevels = Record<UpgradeKind, number>;

export const KILLS_PER_POINT = 2;

// ---------- Abilities ----------
// Abilities are unlocked the same way upgrades are (1 point), but instead
// of stacking levels they enable a per-unit, cooldown-gated action. Slot
// hotkeys live on the row above upgrades: Shift+Q W E R T.
export type AbilityKind = "blink";

export interface AbilityDef {
  name: string;
  hotkey: string;
  max: number; // always 1 -- abilities are binary unlocked / not
  cooldownSec: number; // per-unit cooldown after each use
  describe: (level: number) => string;
}

// Tunables for individual abilities are kept here so client + server agree.
export const BLINK_MAX_DIST = 200; // px -- max teleport distance per cast
export const BLINK_COOLDOWN = 6; // s -- per-unit reuse cooldown
export const BLINK_MOVE_LOCK_SEC = 0.2; // s -- post-blink "settle" window

export const ABILITIES: Record<AbilityKind, AbilityDef> = {
  blink: {
    // Hotkey shown in the panel is the CAST key (bare letter). Buying is
    // always Shift+key for both abilities and upgrades; the HUD line at
    // the top of the page documents the buy modifier.
    name: "Blink",
    hotkey: "Q",
    max: 1,
    cooldownSec: BLINK_COOLDOWN,
    describe: (l) =>
      l > 0 ? `${BLINK_MAX_DIST}px / ${BLINK_COOLDOWN}s cd` : "locked",
  },
};

export const ABILITY_ORDER: AbilityKind[] = ["blink"];

export type AbilityLevels = Record<AbilityKind, number>;

export function emptyAbilities(): AbilityLevels {
  return { blink: 0 };
}

export interface PlayerStats {
  kills: number;
  points: number; // unspent upgrade points
  upgrades: UpgradeLevels;
  abilities: AbilityLevels;
}

export function emptyUpgrades(): UpgradeLevels {
  return {
    range: 0,
    ballistics: 0,
    moveSpeed: 0,
    projectileSpeed: 0,
    damage: 0,
  };
}

export interface Snapshot {
  t: "snap";
  tick: number;
  serverTime: number; // ms
  you: PlayerId;
  units: UnitState[];
  projectiles: ProjectileState[];
  options: ServerOptions;
  myStats: PlayerStats;
}

export interface WelcomeMsg {
  t: "hello";
  you: PlayerId;
  unitIds: EntityId[];
}

export type ServerMsg = Snapshot | WelcomeMsg;

export interface MoveCmd {
  t: "move";
  ids: EntityId[];
  x: number;
  y: number;
  attackMove: boolean;
}

export interface StopCmd {
  t: "stop";
  ids: EntityId[];
}

export interface OptionCmd {
  t: "option";
  ballistics?: boolean;
}

export interface AttackCmd {
  t: "attack";
  ids: EntityId[];
  targetId: EntityId;
}

export interface BuyUpgradeCmd {
  t: "upgrade";
  kind: UpgradeKind;
}

export interface BuyAbilityCmd {
  t: "buyAbility";
  kind: AbilityKind;
}

export interface UseAbilityCmd {
  t: "useAbility";
  kind: AbilityKind;
  ids: EntityId[];
  x: number;
  y: number;
}

export type ClientMsg =
  | MoveCmd
  | StopCmd
  | OptionCmd
  | AttackCmd
  | BuyUpgradeCmd
  | BuyAbilityCmd
  | UseAbilityCmd;

// Tunables
export const UNIT_RADIUS = 10;
export const UNIT_SPEED = 120; // px/s
export const UNIT_HP = 30;
export const UNIT_RANGE = 260;
export const UNIT_ATTACK_CD = 1.4; // seconds reload after firing
export const UNIT_ATTACK_WINDUP = 0.2; // seconds the unit must stand still aiming before a shot leaves
export const PROJ_SPEED = 350; // px/s -- slow enough to dodge
export const PROJ_RADIUS = 5;
export const PROJ_DMG = 8;
export const PROJ_TTL = 2.5; // seconds
