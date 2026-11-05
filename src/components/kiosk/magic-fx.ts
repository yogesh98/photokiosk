/*
 * Gold light for the booth, after Atma Mirror's magic.js: streaking sparks,
 * star glints, expanding rings, fairy dust behind a finger, sparkles that fly
 * from one place to another, slow drifting motes, and spirals of flame that
 * wrap around a frame (passing behind it on the back canvas).
 *
 * Atma Mirror renders this with three.js and an HDR bloom. Here it is Canvas 2D
 * with additive blending and pre-drawn glow sprites, so it stays light next to
 * the green-screen compositor, which already keeps the CPU busy.
 *
 * Coordinates are CSS pixels in the viewport (clientX / clientY).
 */

export type FxRect = { left: number; top: number; width: number; height: number };

export type BurstOptions = {
  count?: number;
  speed?: number;
  glints?: number;
  flash?: number;
  life?: number;
  size?: number;
  gravity?: number;
};

export type VortexOptions = {
  mode?: "up" | "down";
  strands?: number;
  waves?: number;
  gap?: number;
  stagger?: number;
  duration?: number;
  trail?: number;
  radius?: number;
  turns?: number;
  spin?: number;
  dir?: 1 | -1;
  width?: number;
  heat?: number;
  tighten?: number;
  tilt?: number;
  embers?: number;
};

export type MagicFx = {
  burst(x: number, y: number, options?: BurstOptions): void;
  ring(x: number, y: number, options?: { count?: number; speed?: number; life?: number; size?: number }): void;
  trail(x: number, y: number): void;
  twinkle(rect: FxRect, options?: { count?: number; duration?: number; size?: number }): void;
  /** Sparkles arcing from one point to another. Returns the arrival time, in seconds. */
  flight(from: [number, number], to: [number, number], options?: { count?: number; spread?: number }): number;
  /** Flame spirals around a rect. Returns when the flames have swept it (cover) and when they are gone (end). */
  vortex(rect: FxRect, options?: VortexOptions): { cover: number; end: number };
  /** Bursts and rings of light popping across an area, like fireworks. */
  fireworks(rect: FxRect, options?: { count?: number; duration?: number }): void;
  setAmbient(level: number): void;
  clear(): void;
  destroy(): void;
};

type RGB = readonly [number, number, number];

const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(items: readonly T[]) => items[(Math.random() * items.length) | 0];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Champagne, honey and rose gold, with the odd pale-aqua spark (Atma Mirror's palette).
const GOLD = ["#ffe2a0", "#ffc766", "#ffd98a", "#fff1d0", "#ffb877", "#ffeab8", "#ffd27a"].map(rgb);
const AQUA = rgb("#bff3ff");
const EMBER: RGB = [1, 0.5, 0.2];
const WARM: RGB = [1, 0.85, 0.6];
const goldish = () => (Math.random() < 0.08 ? AQUA : pick(GOLD));
// Flame colours, coolest to hottest.
const FIRE: readonly RGB[] = [
  [0.5, 0.06, 0.01],
  [1, 0.38, 0.07],
  [1, 0.72, 0.28],
  [1, 0.94, 0.8],
];
const FIRE_HOT: RGB = [1, 0.82, 0.45];
const FIRE_COOL: RGB = [1, 0.36, 0.08];
const fireAt = (heat: number): RGB => {
  const x = clamp01(heat) * (FIRE.length - 1);
  const i = Math.min(FIRE.length - 2, Math.floor(x));
  return mix(FIRE[i], FIRE[i + 1], x - i);
};

// Mostly gentle, with sharp bright glints.
const glint = (t: number, s: number) => 0.6 + 1.4 * Math.pow(Math.abs(Math.sin(t * (1.7 + s * 2.6) + s * 37)), 12);

const SPARK = 0;
const FLIGHT = 1;
const FLAME = 2;
const GLOW = 0;
const STAR = 1;
const FRONT = 1;
const BACK = 0;

type Particle = {
  kind: number;
  shape: number;
  layer: number;
  x: number;
  y: number;
  vx: number; // spark: velocity; flight: target x
  vy: number; // spark: velocity; flight: target y
  t0: number;
  life: number;
  delay: number;
  c0: RGB;
  c1: RGB;
  size: number;
  seed: number;
  g: number; // spark: gravity (px/s², negative rises); flight: travel time; flame: rise speed
  gain: number;
};

type Mote = { x: number; y: number; vx: number; vy: number; size: number; seed: number; deep: boolean; color: RGB };

type Strand = {
  cx: number;
  baseY: number;
  height: number;
  radius: number;
  dur: number;
  trail: number;
  down: boolean;
  turns: number;
  spin: number;
  width: number;
  heat: number;
  tighten: number;
  tilt: number;
  t0: number;
  seed: number;
  phase: number;
  lastHead: number;
  emberBudget: number;
};

const SPRITE = 64;
const STAR_SPRITE = 96;
const STREAK_SECONDS = 0.035;

// The same helix as Atma Mirror's flame ribbons.
const profile = (s: number) => Math.pow(Math.max(Math.sin(Math.PI * (0.14 + 0.86 * s)), 0), 0.8);
const easeP = (p: number) => p - Math.sin(6.2832 * p) * 0.055;

export function createMagicFx(front: HTMLCanvasElement, back: HTMLCanvasElement | null, options: { low?: boolean } = {}): MagicFx {
  const Q = options.low ? 0.5 : 1;
  const MAX = options.low ? 1800 : 3600;
  const n = (count: number) => Math.max(1, Math.round(count * Q));
  const fctx = front.getContext("2d");
  const bctx = back?.getContext("2d") ?? null;
  if (!fctx) return NOOP_FX;

  const T0 = performance.now();
  const now = () => (performance.now() - T0) / 1000;

  let particles: Particle[] = [];
  let strands: Strand[] = [];
  let scheduled: Array<{ at: number; run: () => void }> = [];
  let motes: Mote[] = [];
  let ambient = 0;
  let ambientShown = 0;
  let raf = 0;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let destroyed = false;

  // ---------- sprites ----------
  const spriteCache = new Map<string, HTMLCanvasElement>();
  const quant = (c: RGB) => c.map((v) => Math.round(clamp01(v) * 12)).join(",");

  function glowSprite(c: RGB) {
    const key = "g" + quant(c);
    let sprite = spriteCache.get(key);
    if (sprite) return sprite;
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = SPRITE;
    const ctx = sprite.getContext("2d")!;
    const image = ctx.createImageData(SPRITE, SPRITE);
    const half = SPRITE / 2;
    const r = half / 3;
    for (let y = 0; y < SPRITE; y++) {
      for (let x = 0; x < SPRITE; x++) {
        const dx = x + 0.5 - half;
        const dy = y + 0.5 - half;
        const d2 = dx * dx + dy * dy;
        const edge = 1 - smooth(0.55 * half, half, Math.sqrt(d2));
        const a = Math.min(1, (Math.exp((-d2 / (r * r)) * 1.4) + Math.exp(-d2 / (r * r * 9)) * 0.22) * edge);
        const i = (y * SPRITE + x) * 4;
        image.data[i] = c[0] * 255;
        image.data[i + 1] = c[1] * 255;
        image.data[i + 2] = c[2] * 255;
        image.data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    spriteCache.set(key, sprite);
    return sprite;
  }

  // Star glint: four long flares, four short ones, a hot core.
  function starSprite(c: RGB) {
    const key = "s" + quant(c);
    let sprite = spriteCache.get(key);
    if (sprite) return sprite;
    sprite = document.createElement("canvas");
    sprite.width = sprite.height = STAR_SPRITE;
    const ctx = sprite.getContext("2d")!;
    const image = ctx.createImageData(STAR_SPRITE, STAR_SPRITE);
    const half = STAR_SPRITE / 2;
    for (let y = 0; y < STAR_SPRITE; y++) {
      for (let x = 0; x < STAR_SPRITE; x++) {
        const ux = (x + 0.5 - half) / half;
        const uy = (y + 0.5 - half) / half;
        const d2 = ux * ux + uy * uy;
        const f1 = Math.exp(-Math.abs(ux) * 3.2) * Math.exp(-Math.abs(uy) * 40) + Math.exp(-Math.abs(uy) * 3.2) * Math.exp(-Math.abs(ux) * 40);
        const vx = (ux + uy) * 0.7071;
        const vy = (uy - ux) * 0.7071;
        const f2 = Math.exp(-Math.abs(vx) * 6.5) * Math.exp(-Math.abs(vy) * 55) + Math.exp(-Math.abs(vy) * 6.5) * Math.exp(-Math.abs(vx) * 55);
        const a = Math.min(1, (Math.exp(-d2 * 70) * 1.6 + f1 + f2 * 0.35 + Math.exp(-d2 * 7) * 0.16) * (1 - smooth(0.7, 1, Math.sqrt(d2))));
        const i = (y * STAR_SPRITE + x) * 4;
        image.data[i] = c[0] * 255;
        image.data[i + 1] = c[1] * 255;
        image.data[i + 2] = c[2] * 255;
        image.data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    spriteCache.set(key, sprite);
    return sprite;
  }

  // ---------- canvas size ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, options.low ? 1 : 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    for (const canvas of [front, back]) {
      if (!canvas) continue;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    fctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedMotes();
  }

  function seedMotes() {
    const near = Math.round(((width * height) / 1e6) * 70 * Q);
    const deep = Math.round(near * 0.5);
    motes = [];
    for (let k = 0; k < near + deep; k++) {
      const isDeep = k >= near;
      motes.push({
        x: rand(0, width),
        y: rand(0, height),
        vx: rand(-6, 6),
        vy: isDeep ? -rand(4, 10) : -rand(8, 22),
        size: isDeep ? rand(0.8, 1.6) : rand(1.3, 2.8),
        seed: Math.random(),
        deep: isDeep,
        color: goldish(),
      });
    }
  }

  // ---------- particles ----------
  function add(p: Omit<Particle, "t0"> & { t0?: number }) {
    if (particles.length >= MAX) particles.shift();
    particles.push({ ...p, t0: p.t0 ?? now() });
    wake();
  }

  function burst(x: number, y: number, o: BurstOptions = {}) {
    const count = n(o.count ?? 40);
    const glints = n(o.glints ?? Math.max(4, (o.count ?? 40) * 0.22));
    const speed = o.speed ?? 460;
    for (let k = 0; k < count; k++) {
      // A sphere of sparks seen from the front, so more of them look slow.
      const th = Math.random() * 6.2832;
      const s = Math.sin(Math.acos(2 * Math.random() - 1));
      const v = speed * rand(0.35, 1);
      add({
        kind: SPARK, shape: GLOW, layer: FRONT, x, y,
        vx: s * Math.cos(th) * v, vy: s * Math.sin(th) * v - speed * 0.1,
        life: rand(0.55, 1.15) * (o.life ?? 1), delay: 0,
        c0: goldish(), c1: EMBER, size: rand(1.6, o.size ?? 3.2), seed: Math.random(), g: o.gravity ?? 380, gain: 1.25,
      });
    }
    for (let k = 0; k < glints; k++) {
      const th = Math.random() * 6.2832;
      const v = speed * rand(0.08, 0.3);
      add({
        kind: SPARK, shape: STAR, layer: FRONT, x, y,
        vx: Math.cos(th) * v, vy: Math.sin(th) * v - 30,
        life: rand(0.9, 1.7), delay: rand(0, 0.15),
        c0: goldish(), c1: WARM, size: rand(7, 13), seed: Math.random(), g: 70, gain: 1.1,
      });
    }
    if (o.flash !== 0)
      add({
        kind: SPARK, shape: GLOW, layer: FRONT, x, y, vx: 0, vy: 0, life: 0.45, delay: 0,
        c0: GOLD[3], c1: GOLD[1], size: (o.flash ?? 44) / 3, seed: 0.5, g: 0, gain: 0.45,
      });
  }

  function ring(x: number, y: number, o: { count?: number; speed?: number; life?: number; size?: number } = {}) {
    const count = n(o.count ?? 110);
    const speed = o.speed ?? 460;
    for (let k = 0; k < count; k++) {
      const th = (k / count) * 6.2832 + rand(-0.02, 0.02);
      const v = speed * rand(0.96, 1.04);
      add({
        kind: SPARK, shape: GLOW, layer: FRONT, x, y, vx: Math.cos(th) * v, vy: Math.sin(th) * v,
        life: rand(0.65, 0.9) * (o.life ?? 1), delay: 0,
        c0: goldish(), c1: [1, 0.8, 0.55], size: rand(1.6, o.size ?? 2.6), seed: Math.random(), g: 0, gain: 1.2,
      });
    }
  }

  // Fairy dust behind a finger: a glowing line that fades, glints drifting down.
  let last = { x: -1e4, y: -1e4, t: 0 };
  let travelled = 0;
  function trail(x: number, y: number) {
    const t = now();
    const dx = x - last.x;
    const dy = y - last.y;
    const d = Math.hypot(dx, dy);
    if (d < 3 && t - last.t < 0.05) return;
    const jump = d > 200;
    last = { x, y, t };
    if (jump) return;
    travelled += d;
    const steps = Math.min(6, Math.max(1, Math.round(d / 7)));
    for (let k = 0; k < steps; k++) {
      const f = (k + 1) / steps;
      add({
        kind: SPARK, shape: GLOW, layer: FRONT, x: x - dx * (1 - f), y: y - dy * (1 - f),
        vx: rand(-12, 12), vy: rand(-12, 12), life: rand(0.45, 0.75), delay: 0,
        c0: goldish(), c1: EMBER, size: rand(2.2, 3.6), seed: Math.random(), g: -20, gain: 1.1,
      });
    }
    add({
      kind: SPARK, shape: GLOW, layer: FRONT, x: x + rand(-6, 6), y: y + rand(-6, 6),
      vx: rand(-50, 50), vy: rand(-60, 20), life: rand(0.5, 0.9), delay: 0,
      c0: goldish(), c1: EMBER, size: rand(1.4, 2.2), seed: Math.random(), g: 300, gain: 1.3,
    });
    if (travelled > 38) {
      travelled = 0;
      add({
        kind: SPARK, shape: STAR, layer: FRONT, x: x + rand(-8, 8), y: y + rand(-8, 8),
        vx: rand(-20, 20), vy: rand(-20, 10), life: rand(1, 1.6), delay: 0,
        c0: goldish(), c1: [1, 0.8, 0.5], size: rand(8, 13), seed: Math.random(), g: 90, gain: 1.1,
      });
    }
  }

  function twinkle(rect: FxRect, o: { count?: number; duration?: number; size?: number } = {}) {
    const count = n(o.count ?? 40);
    const duration = o.duration ?? 1.5;
    for (let k = 0; k < count; k++) {
      const delay = rand(0, duration);
      add({
        kind: SPARK, shape: STAR, layer: FRONT,
        x: rect.left + rand(0, rect.width), y: rect.top + rand(0, rect.height),
        vx: rand(-8, 8), vy: rand(-16, 0), life: delay + rand(0.6, 1.1), delay,
        c0: goldish(), c1: WARM, size: rand(7, o.size ?? 15), seed: Math.random(), g: -8, gain: 1.1,
      });
    }
  }

  function flight(from: [number, number], to: [number, number], o: { count?: number; spread?: number } = {}) {
    const count = n(o.count ?? 140);
    const spread = o.spread ?? 0.25;
    let end = 0;
    for (let k = 0; k < count; k++) {
      const delay = Math.random() * spread;
      const travel = rand(0.55, 0.75);
      const star = Math.random() < 0.08;
      end = Math.max(end, delay + travel);
      add({
        kind: FLIGHT, shape: star ? STAR : GLOW, layer: FRONT,
        x: from[0] + rand(-12, 12), y: from[1] + rand(-12, 12),
        vx: to[0] + rand(-16, 16), vy: to[1] + rand(-16, 16),
        life: delay + travel, delay,
        c0: goldish(), c1: [1, 0.95, 0.8], size: star ? rand(8, 12) : rand(1.8, 3.4), seed: Math.random(), g: travel, gain: star ? 1.1 : 1.3,
      });
    }
    return end;
  }

  // ---------- flame spirals ----------
  function helixAt(P: Strand, q: number, age: number, pe: number) {
    const s = clamp01(q);
    const r = P.radius * profile(s) * (1 - P.tighten * pe);
    const th = P.phase + 6.2832 * P.turns * s + P.spin * age;
    const z = Math.sin(th) * r;
    const x = P.cx + Math.cos(th) * r + Math.sin(age * 1.7 + P.seed * 20 + s * 4) * P.radius * 0.05 * s;
    return { x, y: P.baseY - s * P.height + z * P.tilt, z, th, r };
  }

  function sweptAt(L: number) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (easeP(m) * (1 + L) < 1) lo = m;
      else hi = m;
    }
    return lo;
  }

  function vortex(rect: FxRect, o: VortexOptions = {}) {
    const down = o.mode === "down";
    const count = o.strands ?? 4;
    const waves = o.waves ?? 1;
    const gap = o.gap ?? 0.35;
    const stagger = o.stagger ?? 0.05;
    const dur = o.duration ?? 1.7;
    const trailLength = o.trail ?? 0.6;
    const t = now();
    for (let w = 0; w < waves; w++) {
      for (let k = 0; k < count; k++) {
        strands.push({
          cx: rect.left + rect.width / 2,
          baseY: rect.top + rect.height * 1.02,
          height: rect.height * 1.1,
          radius: rect.width * (o.radius ?? 0.46),
          dur,
          trail: trailLength,
          down,
          turns: o.turns ?? 1.4,
          spin: (o.dir ?? 1) * (o.spin ?? 2.4),
          width: rect.width * (o.width ?? 0.26) * rand(0.85, 1.15),
          heat: (o.heat ?? 1) * (w ? 0.8 : 1),
          tighten: o.tighten ?? 0.2,
          tilt: o.tilt ?? 0.2,
          t0: t + w * gap + k * stagger,
          seed: Math.random(),
          phase: (k / count + w * 0.37) * 6.2832 + rand(-0.25, 0.25),
          lastHead: down ? 1 : 0,
          emberBudget: n(o.embers ?? 30),
        });
      }
    }
    wake();
    return { cover: sweptAt(trailLength) * dur + (count - 1) * stagger, end: (waves - 1) * gap + (count - 1) * stagger + dur };
  }

  // Lay flame along the stretch of helix each ribbon's head crossed since the last frame.
  function stepStrands(t: number, dt: number) {
    for (let i = strands.length - 1; i >= 0; i--) {
      const P = strands[i];
      const age = t - P.t0;
      if (age < 0) continue;
      const p = clamp01(age / P.dur);
      const pe = easeP(p);
      const head = P.down ? 1 - pe * (1 + P.trail) : pe * (1 + P.trail);
      const from = P.lastHead;
      P.lastHead = head;
      const lo = Math.max(0, Math.min(from, head));
      const hi = Math.min(1, Math.max(from, head));
      if (hi > lo) {
        const a = helixAt(P, lo, age, pe);
        const b = helixAt(P, hi, age, pe);
        const pathPx = Math.hypot(b.x - a.x, b.y - a.y) + Math.abs(hi - lo) * 6.2832 * P.turns * P.radius;
        const steps = Math.min(60, Math.max(1, Math.round((pathPx / 9) * Q)));
        const rising = head >= from;
        for (let k = 0; k < steps; k++) {
          const f = (k + Math.random()) / steps;
          const q = lo + (hi - lo) * f;
          const h = helixAt(P, q, age, pe);
          const thick = P.width * (0.12 + 0.14 * profile(q)) * rand(0.7, 1.2);
          const heat = P.heat * rand(0.5, 0.9);
          const front = h.z >= 0;
          // Flame laid earlier along this stretch is a little older, so a dropped frame never leaves gaps.
          const along = rising ? f : 1 - f;
          add({
            kind: FLAME, shape: GLOW, layer: front ? FRONT : BACK, t0: t - dt * (1 - along),
            x: h.x + rand(-0.15, 0.15) * thick, y: h.y + rand(-0.25, 0.25) * thick,
            vx: 0, vy: 0, life: rand(0.4, 0.7), delay: 0,
            c0: fireAt(heat), c1: FIRE[0], size: thick, seed: Math.random(), g: rand(60, 160), gain: front ? 0.13 : 0.1,
          });
          // A white-hot spine down the middle of the flame.
          if (k % 3 === 0)
            add({
              kind: FLAME, shape: GLOW, layer: front ? FRONT : BACK, t0: t - dt * (1 - along),
              x: h.x, y: h.y, vx: 0, vy: 0, life: rand(0.25, 0.4), delay: 0,
              c0: FIRE[3], c1: FIRE_HOT, size: thick * 0.35, seed: Math.random(), g: rand(30, 80), gain: front ? 0.32 : 0.22,
            });
          // Sparks thrown off a flame as it passes, rising as they cool.
          if (P.emberBudget > 0 && Math.random() < 0.06) {
            P.emberBudget--;
            const out = rand(30, 150);
            const star = Math.random() < 0.1;
            add({
              kind: SPARK, shape: star ? STAR : GLOW, layer: h.z >= 0 ? FRONT : BACK,
              x: h.x, y: h.y, vx: Math.cos(h.th) * out, vy: -rand(20, 130), life: rand(0.6, 1.4), delay: 0,
              c0: FIRE_HOT, c1: FIRE_COOL, size: star ? rand(6, 10) : rand(1.4, 2.6), seed: Math.random(), g: -rand(80, 240), gain: star ? 1.1 : 1.4,
            });
          }
        }
      }
      if (p >= 1) strands.splice(i, 1);
    }
  }

  function fireworks(rect: FxRect, o: { count?: number; duration?: number } = {}) {
    const count = o.count ?? 6;
    const duration = o.duration ?? 5;
    const t = now();
    for (let k = 0; k < count; k++) {
      const at = t + (k / Math.max(1, count - 1)) * duration * rand(0.85, 1);
      scheduled.push({
        at,
        run: () => {
          const x = rect.left + rand(0.12, 0.88) * rect.width;
          const y = rect.top + rand(0.1, 0.9) * rect.height;
          burst(x, y, { count: 70, speed: 520, glints: 14, flash: 90 });
          ring(x, y, { count: 90, speed: 360 });
        },
      });
    }
    wake();
  }

  // ---------- drawing ----------
  function positionOf(p: Particle, age: number): [number, number] {
    if (p.kind === FLIGHT) {
      const u = clamp01((age - p.delay) / p.g);
      const e = u * u * (3 - 2 * u);
      const mx = (p.x + p.vx) / 2 + (p.seed - 0.5) * 300;
      const my = (p.y + p.vy) / 2 - (120 + p.seed * 220);
      const ax = p.x + (mx - p.x) * e;
      const ay = p.y + (my - p.y) * e;
      return [ax + (mx + (p.vx - mx) * e - ax) * e, ay + (my + (p.vy - my) * e - ay) * e];
    }
    if (p.kind === FLAME) {
      return [p.x + Math.sin(age * 9 + p.seed * 20) * p.size * 0.12, p.y - p.g * age];
    }
    const tau = Math.max(age - p.delay, 0);
    const d = (1 - Math.exp(-2.6 * tau)) / 2.6;
    return [p.x + p.vx * d, p.y + p.vy * d + 0.5 * p.g * tau * tau];
  }

  function drawParticle(ctx: CanvasRenderingContext2D, p: Particle, t: number) {
    const age = t - p.t0;
    if (age < p.delay) return;
    const u = clamp01((age - p.delay) / Math.max(p.life - p.delay, 0.001));
    let alpha: number;
    let color: RGB;
    let size = p.size;
    let streak = true;
    if (p.kind === FLAME) {
      // A tongue of flame: it licks upward, widens and cools from white-gold to ember red.
      alpha = smooth(0, 0.1, u) * (1 - smooth(0.25, 1, u));
      color = mix(p.c0, p.c1, smooth(0.1, 0.9, u));
      size *= 1 + 0.25 * u;
      streak = false;
    } else if (p.kind === FLIGHT) {
      const f = clamp01((age - p.delay) / p.g);
      alpha = smooth(0, 0.12, f) * (1 - smooth(0.9, 1, f) * 0.5);
      color = mix(p.c0, p.c1, f);
    } else {
      alpha = smooth(0, 0.05, u) * (1 - smooth(0.4, 1, u));
      color = mix(p.c0, p.c1, u);
      if (p.vx === 0 && p.vy === 0) streak = false;
    }
    alpha *= Math.min(1, p.gain * (p.kind === FLAME ? 1 : glint(age, p.seed) * 0.75));
    if (alpha < 0.01) return;
    const [x, y] = positionOf(p, age);
    if (p.shape === STAR) {
      const half = size * 3.2;
      const rot = p.seed * 6.2832 + age * 0.4;
      const cos = Math.cos(rot) * dpr;
      const sin = Math.sin(rot) * dpr;
      ctx.globalAlpha = alpha;
      ctx.setTransform(cos, sin, -sin, cos, x * dpr, y * dpr);
      ctx.drawImage(starSprite(color), -half, -half, half * 2, half * 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return;
    }
    if (streak) {
      const [px, py] = positionOf(p, Math.max(p.delay, age - STREAK_SECONDS));
      if (Math.abs(px - x) + Math.abs(py - y) > 1.5) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.strokeStyle = `rgb(${(color[0] * 255) | 0},${(color[1] * 255) | 0},${(color[2] * 255) | 0})`;
        ctx.lineWidth = size * 0.9;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
    const r = size * (p.kind === FLAME ? 1.8 : 3);
    ctx.globalAlpha = alpha;
    ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  }

  function drawMotes(ctx: CanvasRenderingContext2D, t: number, dt: number) {
    if (ambientShown < 0.01) return;
    for (const m of motes) {
      m.x += (m.vx + Math.sin(t * 0.31 + m.seed * 40) * 6) * dt;
      m.y += m.vy * dt;
      if (m.y < -10) {
        m.y = height + 10;
        m.x = rand(0, width);
      }
      if (m.x < -10) m.x = width + 10;
      else if (m.x > width + 10) m.x = -10;
      const a = ambientShown * (m.deep ? 0.32 : 0.55) * glint(t, m.seed);
      if (a < 0.01) continue;
      const r = m.size * 3;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(glowSprite(m.color), m.x - r, m.y - r, r * 2, r * 2);
    }
  }

  function frame() {
    raf = 0;
    if (destroyed) return;
    const t = now();
    const dt = Math.min(0.05, lastFrame ? t - lastFrame : 0.016);
    lastFrame = t;
    ambientShown += (ambient - ambientShown) * Math.min(1, dt * 1.5);

    for (let i = scheduled.length - 1; i >= 0; i--) {
      if (scheduled[i].at <= t) {
        const job = scheduled[i];
        scheduled.splice(i, 1);
        job.run();
      }
    }
    stepStrands(t, dt);
    particles = particles.filter((p) => t - p.t0 <= p.life);

    for (const ctx of [fctx, bctx]) {
      if (!ctx) continue;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
    }
    if (bctx) drawMotes(bctx, t, dt);
    for (const p of particles) {
      const ctx = p.layer === BACK && bctx ? bctx : fctx!;
      drawParticle(ctx, p, t);
    }
    fctx!.globalAlpha = 1;
    if (bctx) bctx.globalAlpha = 1;

    const busy = particles.length > 0 || strands.length > 0 || scheduled.length > 0 || ambientShown > 0.01 || ambient > 0;
    if (busy) raf = requestAnimationFrame(frame);
    else lastFrame = 0;
  }

  function wake() {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);

  return {
    burst,
    ring,
    trail,
    twinkle,
    flight,
    vortex,
    fireworks,
    setAmbient(level) {
      ambient = clamp01(level);
      wake();
    },
    clear() {
      particles = [];
      strands = [];
      scheduled = [];
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      particles = [];
      strands = [];
      scheduled = [];
      spriteCache.clear();
    },
  };
}

const NOOP_FX: MagicFx = {
  burst: () => {},
  ring: () => {},
  trail: () => {},
  twinkle: () => {},
  flight: () => 0,
  vortex: () => ({ cover: 0, end: 0 }),
  fireworks: () => {},
  setAmbient: () => {},
  clear: () => {},
  destroy: () => {},
};
