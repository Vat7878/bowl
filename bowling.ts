// Bowling, without a screen: how a swing becomes a throw, how a ball and ten pins behave on a lane, and how a game is
// scored. Nothing here touches the engine or the DOM, so `npm run check` can drive all of it with synthetic movement.
// Units: the lane is 4 wide (x, 0 = the middle) and runs down -z from the foul line (z = 0). Hands are in
// shoulder-widths and shoulder-widths per second, y up — exactly what `players[p].rig` holds.

// ---- 1. The swing ------------------------------------------------------------------------------------------------
// What a front-facing camera can see of a bowling swing is the hand rising: it hangs low at your side, you wind up a
// little, then swing it up fast to chest height — and that is the moment you let go. So:
//   ready  : the hand has been low and still for a moment (the ball is "in your hand")
//   aim    : while ready, where the hand sits sideways of its resting place turns the arrow (frozen once you move)
//   throw  : the hand crosses `releaseY` going up, fast. How fast it was = how hard the ball is bowled.
//   hook   : how much the path bulged to one side on the way up = how much the ball curves that way.
export const SWING = {
  armY: -0.7, // a hand lower than this (shoulder-widths, 0 = shoulder line) is "holding the ball"
  holdFor: 0.3, // seconds low and still before the ball counts as ready
  calm: 1.6, // below this speed (sw/s) a hand is "still"
  startSpeed: 2.2, // above this, going up, a swing has begun
  releaseY: -0.55, // the hand crossing this on the way up lets go
  minSpeed: 2.6, // …but only if it is at least this fast; slower is a "swing faster" and the ball stays in hand
  fullSpeed: 9, // swing speed that bowls at full power
  maxSwing: 1.1, // seconds from start to release before the swing is given up on
  restX: 0.85, // where a hanging hand sits sideways of the body's middle (toward its own side)
  aimRange: 1.0, // sideways travel (sw) of the hand from its rest that turns the arrow fully
  aimDead: 0.12, // …ignoring the first bit of it, so natural sway does not move the arrow
  maxAim: 0.13, // the steepest the arrow goes, radians (about 7.5°: from one gutter edge to the other over the lane)
  hookRange: 0.35, // path bulge (sw) that gives full hook
  hookDead: 0.06,
};

export type Sample = { t: number; x: number; y: number; vx: number; vy: number };
export type Throw = { power: number; aim: number; hook: number; speed: number; held: number };
export type SwingPhase = 'away' | 'idle' | 'ready' | 'swing';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const dead = (v: number, d: number) => (Math.abs(v) <= d ? 0 : v - Math.sign(v) * d);

// The arrow's angle for a hand at sideways position `x` (sw). `side` is -1 for the screen-left hand, +1 for the right.
export const aimOf = (x: number, side: number) => {
  const u = dead((x - side * SWING.restX) / SWING.aimRange, SWING.aimDead) / (1 - SWING.aimDead);
  const c = clamp(u, -1, 1);
  return Math.sign(c) * Math.abs(c) ** 1.4 * SWING.maxAim; // gentle around straight, steeper at the edges
};

// One of these per hand. Feed it a sample every frame (null when the hand is not seen); it returns a Throw once.
export class Thrower {
  phase: SwingPhase = 'away';
  aim = 0; // the arrow, radians, positive = toward screen-right
  heldX = 0; // where the hand is, for drawing the ball with it
  heldY = -1.4;
  rising = 0; // 0..1 how far up toward release the hand is (for the ball in hand)
  private still = 0; // seconds the hand has been low and calm
  private calm = 0; // the same, counted during a swing
  private last = 0;
  private path: Sample[] = [];
  private startT = 0;
  private frozen = 0;
  side: number;
  constructor(side: number) { this.side = side; }

  reset() { this.phase = 'away'; this.still = 0; this.calm = 0; this.last = 0; this.path.length = 0; }

  update(s: Sample | null): Throw | null {
    if (!s) { this.reset(); return null; }
    const dt = this.last ? clamp(s.t - this.last, 0, 0.1) : 0; // from the sample clock, so it holds at any frame rate
    this.last = s.t;
    const speed = Math.hypot(s.vx, s.vy);
    this.heldX = s.x; this.heldY = s.y;
    this.rising = clamp((s.y - SWING.armY) / (SWING.releaseY - SWING.armY), 0, 1);

    if (this.phase === 'swing') {
      this.path.push(s);
      if (s.y >= SWING.releaseY && s.vy > 0) {
        const thrown = this.finish(s);
        this.phase = 'away'; this.still = 0; this.path.length = 0; // the hand must come back down to bowl again
        return thrown;
      }
      // A wind-up is part of the swing: the hand goes back (up, to a camera that faces you), comes down, and drives up
      // again without stopping. Given up on only when it takes too long, or the hand settles low and calm again.
      this.calm = s.y < SWING.armY && speed < SWING.calm ? this.calm + dt : 0;
      if (s.t - this.startT > SWING.maxSwing || this.calm > 0.25) {
        this.phase = s.y < SWING.armY ? 'idle' : 'away'; this.still = 0; this.calm = 0; this.path.length = 0;
      }
      return null;
    }

    if (s.y >= SWING.armY) { this.phase = 'away'; this.still = 0; return null; } // not holding the ball
    if (this.phase === 'away') this.phase = 'idle';
    if (speed < SWING.calm) this.still += dt; else this.still = 0;
    if (this.phase === 'idle' && this.still >= SWING.holdFor) this.phase = 'ready';
    if (this.phase === 'ready') {
      // The arrow follows the hand while it is held still, and is frozen the moment it starts to move.
      if (speed < SWING.calm) this.frozen = this.aim += (aimOf(s.x, this.side) - this.aim) * Math.min(1, dt * 9);
      else this.aim = this.frozen;
      if (speed > SWING.startSpeed && s.vy > 0.45 * speed) { this.phase = 'swing'; this.startT = s.t; this.path = [s]; this.calm = 0; }
    }
    return null;
  }

  private finish(end: Sample): Throw | null {
    const p = this.path;
    // Speed: the fastest the hand was going in the last fifth of a second, not just this instant.
    let fast = 0;
    for (const q of p) if (end.t - q.t <= 0.2) fast = Math.max(fast, Math.hypot(q.vx, q.vy));
    if (fast < SWING.minSpeed) return null;
    // Hook: how far the middle of the final rise (from the bottom of the swing) bulges sideways of the straight line
    // from where it began to where it let go.
    let low = 0;
    for (let k = 0; k < p.length; k++) if (p[k].y <= p[low].y) low = k;
    const rise = p.slice(low), a = rise[0], mid = rise[Math.floor(rise.length / 2)];
    const bulge = mid.x - (a.x + end.x) / 2;
    const hook = clamp(dead(bulge, SWING.hookDead) / SWING.hookRange, -1, 1);
    const power = clamp((fast - SWING.minSpeed) / (SWING.fullSpeed - SWING.minSpeed), 0, 1);
    return { power, aim: this.frozen, hook, speed: fast, held: this.still };
  }
}

// ---- 2. The lane ------------------------------------------------------------------------------------------------
export const LANE = {
  half: 2, // half the lane's width
  gutter: 0.9, // each gutter's width
  ballR: 0.41,
  pinR: 0.23, // a pin's belly
  spacing: 1.157, // pin to pin (12 in on a 41.5 in lane)
  headZ: -34, // the head pin
  pitZ: -40.2, // past this a pin has gone into the pit
  pinH: 1.45,
  oilEnd: -12, // the lane is oiled from the foul line to here: the ball skids, then bites and hooks
  minSpeed: 11, maxSpeed: 25, // ball speed, lane units per second, for the weakest and strongest throw
};
export const PIN_SPOTS: [number, number][] = [
  [0, 0], [-0.5, 1], [0.5, 1], [-1, 2], [0, 2], [1, 2], [-1.5, 3], [-0.5, 3], [0.5, 3], [1.5, 3],
].map(([c, r]) => [c * LANE.spacing, LANE.headZ - r * LANE.spacing * 0.866]);

export type Pin = { id: number; x: number; z: number; vx: number; vz: number; up: boolean; spin: number; tilt: number; fx: number; fz: number; gone: boolean; sweep: number };
export type Ball = { x: number; z: number; heading: number; speed: number; hook: number; gutter: number; rolling: boolean; roll: number; hit: boolean };

export const rack = (standing: boolean[] = Array(10).fill(true)): Pin[] =>
  PIN_SPOTS.map(([x, z], id) => ({ id, x, z, vx: 0, vz: 0, up: standing[id], spin: 0, tilt: standing[id] ? 0 : 1, fx: 0, fz: -1, gone: !standing[id], sweep: 0 }));

// A throw becomes a ball at the foul line. `x0` is where on the line the player stands, `bumpers` keeps it out of the gutter.
export function release(t: Throw, x0: number, hookGain = 1): Ball {
  const speed = LANE.minSpeed + (LANE.maxSpeed - LANE.minSpeed) * t.power ** 0.8;
  return { x: x0, z: 0, heading: t.aim, speed, hook: t.hook * hookGain, gutter: 0, rolling: true, roll: 0, hit: false };
}

// Pin action. These are the knobs: how lively the pins are decides how often a good ball strikes.
export const PHYS = { ballMass: 5.2, pinMass: 1, ballPin: 0.78, boost: 1.3, pinPin: 0.85, slide: 1.1, standDrag: 2.5, topple: 0.9, lie: 0.55, ballKeeps: 0.6 };
const HOOK = 0.0062; // radians of turn per unit of lane, at full hook, once the ball bites (about 7° by the pins)

export type Hit = { pin: number; with: 'ball' | 'pin'; speed: number; x: number; z: number };

// Advance the lane by dt. Returns the knocks that happened this step (for sound and sparks).
export function step(ball: Ball | null, pins: Pin[], dt: number, o: { bumpers?: boolean; hookGain?: number } = {}): Hit[] {
  const hits: Hit[] = [];
  const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / sub;
  for (let s = 0; s < sub; s++) {
    if (ball?.rolling) moveBall(ball, h, o);
    // The ball against the pins.
    if (ball?.rolling && !ball.gutter) for (const p of pins) if (!p.gone) {
      const dx = p.x - ball.x, dz = p.z - ball.z, rr = LANE.ballR + (p.up ? LANE.pinR : LANE.pinR * PHYS.lie), d = Math.hypot(dx, dz);
      if (d >= rr || d === 0) continue;
      const nx = dx / d, nz = dz / d, bvx = Math.sin(ball.heading) * ball.speed, bvz = -Math.cos(ball.heading) * ball.speed;
      const rel = (bvx - p.vx) * nx + (bvz - p.vz) * nz;
      if (rel <= 0) continue; // already moving apart
      ball.hit = true;
      // Pins are light: a hit sends them off faster than a plain elastic bounce would, which is what a bowling alley is for.
      const k = (1 + PHYS.ballPin) * rel * (PHYS.ballMass / (PHYS.ballMass + PHYS.pinMass));
      p.vx += nx * k * PHYS.boost; p.vz += nz * k * PHYS.boost;
      p.x = ball.x + nx * rr; p.z = ball.z + nz * rr;
      // The ball loses a little speed and is nudged off line, as a heavy ball would be.
      const lose = (PHYS.pinMass / (PHYS.ballMass + PHYS.pinMass)) * PHYS.ballKeeps * (1 + PHYS.ballPin) * 0.5;
      const nb = ball.speed * (1 - lose * Math.min(1, rel / ball.speed));
      const dvx = bvx - nx * rel * lose * 0.9, dvz = bvz - nz * rel * lose * 0.9;
      ball.heading = Math.atan2(dvx, -dvz); ball.speed = Math.max(nb, Math.hypot(dvx, dvz) * 0.9);
      topple(p, nx, nz, rel);
      hits.push({ pin: p.id, with: 'ball', speed: rel, x: p.x, z: p.z });
    }
    // Pins against pins (a falling or sliding pin is the same thing as a moving one).
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i], b = pins[j];
      if (a.gone || b.gone) continue;
      const moving = Math.hypot(a.vx, a.vz) + Math.hypot(b.vx, b.vz);
      if (moving < 0.05) continue;
      const ra = a.up ? LANE.pinR : LANE.pinR * PHYS.lie, rb = b.up ? LANE.pinR : LANE.pinR * PHYS.lie;
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), rr = ra + rb;
      if (d >= rr || d === 0) continue;
      const nx = dx / d, nz = dz / d, rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      const push = (rr - d) / 2;
      a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
      if (rel <= 0) continue;
      const j2 = rel * 0.5 * (1 + PHYS.pinPin);
      a.vx -= nx * j2; a.vz -= nz * j2; b.vx += nx * j2; b.vz += nz * j2;
      if (rel > PHYS.topple * 0.7) {
        if (a.up) topple(a, -nx, -nz, rel); if (b.up) topple(b, nx, nz, rel);
        hits.push({ pin: b.up ? b.id : a.id, with: 'pin', speed: rel, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      }
    }
    for (const p of pins) {
      if (p.gone) continue;
      p.x += p.vx * h; p.z += p.vz * h;
      const drag = p.up ? PHYS.standDrag : PHYS.slide; // a pin on its side slides, then stops
      const k = Math.max(0, 1 - drag * h);
      p.vx *= k; p.vz *= k;
      if (Math.hypot(p.vx, p.vz) < 0.04) p.vx = p.vz = 0; // friction wins in the end
      if (!p.up) { p.tilt = Math.min(1, p.tilt + h * 3.2); p.sweep += h; }
      if (Math.abs(p.x) > LANE.half + LANE.gutter + 1.2 || p.z < LANE.pitZ) { p.up = false; p.tilt = 1; }
      if (p.z < LANE.pitZ - 1.2 || Math.abs(p.x) > LANE.half + LANE.gutter + 2.5) { p.gone = true; p.vx = p.vz = 0; }
    }
  }
  return hits;
}

function topple(p: Pin, nx: number, nz: number, rel: number) {
  if (!p.up || rel < PHYS.topple) { if (p.up) { p.vx *= 0.5; p.vz *= 0.5; } return; }
  p.up = false; p.tilt = 0; p.fx = nx; p.fz = nz;
  const r = Math.hypot(nx, nz) || 1; p.fx /= r; p.fz /= r;
  p.spin = (Math.random() - 0.5) * 6;
}

function moveBall(b: Ball, h: number, o: { bumpers?: boolean; hookGain?: number }) {
  if (b.gutter) { // in the gutter it just rolls on down to the pit
    b.z -= b.speed * h; b.roll += b.speed * h; b.heading = 0;
    if (b.z < LANE.pitZ - 1) b.rolling = false;
    return;
  }
  // Skid on the oil, then bite: the hook comes on over the last part of the lane. The bend is per unit of lane length, so a
  // slow ball and a fast one curve along the same line — only the timing differs.
  const bite = b.z < LANE.oilEnd ? 1 : 0.12;
  b.heading += b.hook * (o.hookGain ?? 1) * bite * HOOK * b.speed * h;
  b.x += Math.sin(b.heading) * b.speed * h;
  b.z -= Math.cos(b.heading) * b.speed * h;
  b.roll += b.speed * h;
  const edge = LANE.half - LANE.ballR * 0.2;
  if (Math.abs(b.x) > edge) {
    if (o.bumpers) { b.x = Math.sign(b.x) * edge; b.heading = -b.heading * 0.45 - Math.sign(b.x) * 0.02; b.hook *= 0.4; }
    else if (Math.abs(b.x) > LANE.half + LANE.ballR * 0.35) { b.gutter = Math.sign(b.x); b.x = Math.sign(b.x) * (LANE.half + LANE.gutter / 2); }
  }
  if (b.z < LANE.pitZ - 1) b.rolling = false;
}

export const standing = (pins: Pin[]) => pins.map((p) => p.up && !p.gone);
export const countUp = (pins: Pin[]) => pins.reduce((n, p) => n + (p.up && !p.gone ? 1 : 0), 0);

// Has everything stopped? (Pins still sliding, or the ball still rolling, mean the throw is not over.)
export const settled = (ball: Ball | null, pins: Pin[]) =>
  !(ball?.rolling && ball.z > LANE.pitZ - 1) && pins.every((p) => p.gone || (Math.hypot(p.vx, p.vz) < 0.08 && (p.up || p.tilt >= 1)));

// ---- 3. Scoring --------------------------------------------------------------------------------------------------
// `rolls` is every ball thrown so far, in order. Standard ten-pin: a strike is 10 plus the next two balls, a spare is 10
// plus the next one, and the tenth frame gets up to three balls.
export function frames(rolls: number[]) {
  const out: { balls: number[]; score: number | null; strike: boolean; spare: boolean }[] = [];
  let i = 0;
  for (let f = 0; f < 10; f++) {
    if (i >= rolls.length) { out.push({ balls: [], score: null, strike: false, spare: false }); continue; }
    const a = rolls[i];
    if (f < 9) {
      if (a === 10) { out.push({ balls: [10], score: tally(rolls, i, 3), strike: true, spare: false }); i += 1; }
      else if (i + 1 < rolls.length) { const sp = a + rolls[i + 1] === 10; out.push({ balls: [a, rolls[i + 1]], score: tally(rolls, i, sp ? 3 : 2), strike: false, spare: sp }); i += 2; }
      else { out.push({ balls: [a], score: null, strike: false, spare: false }); i += 1; }
    } else {
      const balls = rolls.slice(i, i + 3), need = a === 10 || (balls.length > 1 && a + balls[1] === 10) ? 3 : 2;
      out.push({ balls, score: balls.length >= need ? balls.reduce((x, y) => x + y, 0) : null, strike: a === 10, spare: a !== 10 && balls.length > 1 && a + balls[1] === 10 });
      i += balls.length;
    }
  }
  let run = 0;
  return out.map((f) => (f.score === null ? { ...f, total: null as number | null } : { ...f, total: (run += f.score) }));
}
const tally = (rolls: number[], i: number, n: number) => (i + n <= rolls.length ? rolls.slice(i, i + n).reduce((a, b) => a + b, 0) : null);

// The running total over the balls thrown so far (frames still waiting on a bonus count what they have).
export function totalOf(rolls: number[]) {
  let total = 0, i = 0;
  for (let f = 0; f < 10 && i < rolls.length; f++) {
    const a = rolls[i];
    if (f === 9) { total += rolls.slice(i, i + 3).reduce((x, y) => x + y, 0); break; }
    if (a === 10) { total += 10 + (rolls[i + 1] ?? 0) + (rolls[i + 2] ?? 0); i += 1; }
    else if (i + 1 < rolls.length) { total += a + rolls[i + 1] + (a + rolls[i + 1] === 10 ? rolls[i + 2] ?? 0 : 0); i += 2; }
    else total += a;
  }
  return total;
}

// Where the game is after `rolls`: which frame and ball the next throw is, how many pins stand for it, and whether it is over.
export function stateOf(rolls: number[]) {
  let i = 0;
  for (let f = 0; f < 9; f++) {
    if (i >= rolls.length) return { frame: f, ball: 0, standing: 10, over: false };
    if (rolls[i] === 10) i += 1;
    else if (i + 1 < rolls.length) i += 2;
    else return { frame: f, ball: 1, standing: 10 - rolls[i], over: false };
  }
  const t = rolls.slice(i);
  if (t.length === 0) return { frame: 9, ball: 0, standing: 10, over: false };
  if (t.length === 1) return { frame: 9, ball: 1, standing: t[0] === 10 ? 10 : 10 - t[0], over: false };
  if (t.length === 2) return t[0] === 10 || t[0] + t[1] === 10 ? { frame: 9, ball: 2, standing: t[0] === 10 && t[1] !== 10 ? 10 - t[1] : 10, over: false } : { frame: 9, ball: 2, standing: 0, over: true };
  return { frame: 9, ball: 2, standing: 0, over: true };
}

// The scorecard as two lines of text, for the HUD: each frame's marks, then the running totals under them.
export function card(rolls: number[]) {
  const fs = frames(rolls), mark = (b: number[], f: number, strike: boolean, spare: boolean) => {
    if (f < 9) return strike ? ' X ' : b.length === 0 ? ' · ' : spare ? `${b[0] || '-'}/ ` : `${b[0] || '-'}${b[1] === undefined ? ' ' : b[1] || '-'} `;
    if (b.length === 0) return ' · ';
    const m = b.map((v, k) => (v === 10 ? 'X' : k > 0 && b[k - 1] !== 10 && b[k - 1] + v === 10 ? '/' : v === 0 ? '-' : String(v)));
    return m.join('').padEnd(3, ' ');
  };
  return {
    marks: fs.map((f, i) => mark(f.balls, i, f.strike, f.spare)).join('│'),
    totals: fs.map((f) => (f.total === null ? '   ' : String(f.total).padStart(3, ' '))).join('│'),
  };
}
