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

export const UPGRADES: Record<UpgradeKind, UpgradeDef> = {
  range: {
    name: "Range",
    hotkey: "Q",
    max: 5,
    describe: (l) => `+${l * RANGE_PER_LEVEL} px`,
  },
  ballistics: {
    name: "Ballistics",
    hotkey: "W",
    max: 1,
    describe: (l) => (l > 0 ? "lead targets" : "off"),
  },
  moveSpeed: {
    name: "Move Speed",
    hotkey: "E",
    max: 5,
    describe: (l) => `+${l * 15}%`,
  },
  projectileSpeed: {
    name: "Projectile Speed",
    hotkey: "R",
    max: 5,
    describe: (l) => `+${l * 30}%`,
  },
  damage: {
    name: "Damage",
    hotkey: "T",
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

export interface PlayerStats {
  kills: number;
  points: number; // unspent upgrade points
  upgrades: UpgradeLevels;
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

export type ClientMsg =
  | MoveCmd
  | StopCmd
  | OptionCmd
  | AttackCmd
  | BuyUpgradeCmd;

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
