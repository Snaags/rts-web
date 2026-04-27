import {
  HARDPOINT_HARD_CAP_SECONDS,
  HARDPOINT_RADIUS,
  HARDPOINT_WIN_SECONDS,
  MAP_H,
  MAP_W,
  MATCH_END_BANNER_SEC,
  MatchEndedPublicState,
  MatchPublicState,
  ModeId,
  PlayerId,
  UnitState,
  VOTE_COOLDOWN_SEC,
  VOTE_DURATION_SEC,
  VotePublicState,
} from "../shared/protocol.js";

/**
 * Hooks the MatchManager calls back into the main server for things it
 * can't observe directly. Kept narrow so the manager remains independent
 * of `server/index.ts` -- easier to test and refactor later.
 */
export interface MatchHooks {
  /** Despawn all bot units (called when a match starts). */
  removeBots(): void;
  /** Re-create bots up to the configured count (called on match end). */
  spawnBots(): void;
  /** Currently-connected human player ids (drives vote majority math). */
  connectedHumans(): PlayerId[];
}

interface ActiveMatch {
  mode: ModeId;
  startedAt: number;
  endsAt: number;
  hill: { x: number; y: number; radius: number };
  scores: Map<PlayerId, number>;
}

interface ActiveVote {
  proposedBy: PlayerId;
  mode: ModeId;
  expiresAt: number;
  yes: Set<PlayerId>;
  no: Set<PlayerId>;
}

/**
 * Manages the lobby/vote/match/post-match state machine.
 *
 *   lobby ── proposeMatch ──> voting ── majority yes ──> active ──┐
 *     ▲                          │                                 │
 *     │                          └── timeout / impossible ──┐      │
 *     │                                                     ▼      │
 *     └────────────── post-match (5s banner) ◀── win/cap ──────────┘
 *
 * Bots are kept out of `units` for the duration of an active match so the
 * Hardpoint contest scan only ever sees human players.
 */
export class MatchManager {
  private hooks: MatchHooks;
  private active: ActiveMatch | null = null;
  private vote: ActiveVote | null = null;
  private cooldownUntil = 0;
  private endedBanner: MatchEndedPublicState | null = null;

  constructor(hooks: MatchHooks) {
    this.hooks = hooks;
  }

  isInMatch(): boolean {
    return this.active !== null;
  }

  /**
   * Try to open a vote for `mode`. Fails (silently logged via return) if a
   * match is already active, a vote is in flight, or the cooldown after a
   * recent vote hasn't expired.
   */
  proposeMatch(by: PlayerId, mode: ModeId): { ok: boolean; reason?: string } {
    if (this.active) return { ok: false, reason: "match in progress" };
    if (this.vote) return { ok: false, reason: "vote in progress" };
    const now = Date.now();
    if (now < this.cooldownUntil) return { ok: false, reason: "vote cooldown" };
    this.vote = {
      proposedBy: by,
      mode,
      expiresAt: now + VOTE_DURATION_SEC * 1000,
      // Proposer auto-counts as yes -- no need to hit the same key twice.
      yes: new Set([by]),
      no: new Set(),
    };
    return { ok: true };
  }

  /** Record a vote, replacing any prior vote from the same player. */
  castVote(by: PlayerId, choice: "yes" | "no") {
    if (!this.vote) return;
    this.vote.yes.delete(by);
    this.vote.no.delete(by);
    if (choice === "yes") this.vote.yes.add(by);
    else this.vote.no.add(by);
  }

  /**
   * Per-tick update. Resolves the vote (passes/fails), ticks the active
   * match's score, and clears the post-match banner when its timer expires.
   * Reads `units` because the Hardpoint scan needs unit positions.
   */
  tick(units: Map<number, UnitState>, dt: number) {
    const now = Date.now();

    if (this.endedBanner && now >= this.endedBanner.expiresAt) {
      this.endedBanner = null;
    }

    if (this.vote) {
      const humans = this.hooks.connectedHumans();
      // Simple majority = STRICTLY more than half, i.e. floor(n/2)+1.
      // (ceil(n/2) would let 1 of 2 pass at 50% which isn't a majority.)
      const need = Math.max(1, Math.floor(humans.length / 2) + 1);
      const yesCount = this.vote.yes.size;
      const noCount = this.vote.no.size;
      const remaining = humans.length - yesCount - noCount;
      if (yesCount >= need) {
        const mode = this.vote.mode;
        this.vote = null;
        this.startMatch(mode);
      } else if (yesCount + remaining < need || now >= this.vote.expiresAt) {
        // Yes can no longer reach majority, or the window expired.
        this.vote = null;
        this.cooldownUntil = now + VOTE_COOLDOWN_SEC * 1000;
      }
    }

    if (this.active) {
      this.tickHardpoint(units, dt, now);
    }
  }

  private startMatch(mode: ModeId) {
    const now = Date.now();
    this.hooks.removeBots();
    this.active = {
      mode,
      startedAt: now,
      endsAt: now + HARDPOINT_HARD_CAP_SECONDS * 1000,
      hill: { x: MAP_W / 2, y: MAP_H / 2, radius: HARDPOINT_RADIUS },
      scores: new Map(),
    };
    console.log(`[match] ${mode} started`);
  }

  private endMatch(winner: PlayerId | null) {
    if (!this.active) return;
    const now = Date.now();
    const finalScores = [...this.active.scores.entries()]
      .map(([player, points]) => ({ player, points }))
      .sort((a, b) => b.points - a.points || a.player - b.player);
    this.endedBanner = {
      mode: this.active.mode,
      winner,
      finalScores,
      expiresAt: now + MATCH_END_BANNER_SEC * 1000,
    };
    console.log(`[match] ended winner=${winner}`);
    this.active = null;
    this.cooldownUntil = now + VOTE_COOLDOWN_SEC * 1000;
    this.hooks.spawnBots();
  }

  private tickHardpoint(
    units: Map<number, UnitState>,
    dt: number,
    now: number,
  ) {
    const m = this.active!;
    const r2 = m.hill.radius * m.hill.radius;
    // Bots have already been removed when the match started, so any owner
    // showing up here is a human. Belt-and-braces: still ignore non-human
    // ids if the hooks ever change.
    const ownersInHill = new Set<PlayerId>();
    for (const u of units.values()) {
      const dx = u.x - m.hill.x;
      const dy = u.y - m.hill.y;
      if (dx * dx + dy * dy <= r2) ownersInHill.add(u.owner);
    }

    if (ownersInHill.size === 1) {
      const holder = [...ownersInHill][0];
      const cur = m.scores.get(holder) ?? 0;
      const next = cur + dt;
      m.scores.set(holder, next);
      if (next >= HARDPOINT_WIN_SECONDS) {
        this.endMatch(holder);
        return;
      }
    }

    if (now >= m.endsAt) {
      // Hard cap reached: highest score wins; perfect tie -> no winner.
      const sorted = [...m.scores.entries()].sort((a, b) => b[1] - a[1]);
      let winner: PlayerId | null = null;
      if (sorted.length === 1) winner = sorted[0][0];
      else if (sorted.length >= 2 && sorted[0][1] !== sorted[1][1])
        winner = sorted[0][0];
      this.endMatch(winner);
    }
  }

  /**
   * Build the public match state for snapshots. Recomputes holder/contested
   * each call so the rendering tracks unit movement smoothly between score
   * ticks.
   */
  publicMatchState(
    units: Map<number, UnitState>,
  ): MatchPublicState | null {
    if (!this.active) return null;
    const m = this.active;
    const r2 = m.hill.radius * m.hill.radius;
    const ownersInHill = new Set<PlayerId>();
    for (const u of units.values()) {
      const dx = u.x - m.hill.x;
      const dy = u.y - m.hill.y;
      if (dx * dx + dy * dy <= r2) ownersInHill.add(u.owner);
    }
    const contested = ownersInHill.size >= 2;
    const holder = ownersInHill.size === 1 ? [...ownersInHill][0] : null;
    const scores = [...m.scores.entries()]
      .map(([player, points]) => ({ player, points }))
      .sort((a, b) => b.points - a.points || a.player - b.player);
    return {
      mode: m.mode,
      startedAt: m.startedAt,
      endsAt: m.endsAt,
      winTarget: HARDPOINT_WIN_SECONDS,
      hill: m.hill,
      scores,
      holder,
      contested,
    };
  }

  publicVoteState(): VotePublicState | null {
    if (!this.vote) return null;
    const humans = this.hooks.connectedHumans();
    const needYes = Math.max(1, Math.floor(humans.length / 2) + 1);
    return {
      proposedBy: this.vote.proposedBy,
      mode: this.vote.mode,
      expiresAt: this.vote.expiresAt,
      yes: [...this.vote.yes],
      no: [...this.vote.no],
      needYes,
    };
  }

  endedBannerState(): MatchEndedPublicState | null {
    return this.endedBanner;
  }

  /**
   * Strip a disconnected player from any pending vote. Their score in an
   * active match is left intact -- if they reconnect (currently they get
   * a new id, but the design is open) it would still show on the board.
   */
  onPlayerDisconnected(p: PlayerId) {
    if (this.vote) {
      this.vote.yes.delete(p);
      this.vote.no.delete(p);
    }
  }
}
