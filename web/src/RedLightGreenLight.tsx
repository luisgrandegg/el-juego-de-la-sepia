/**
 * RedLightGreenLight.tsx
 * Cursor Madrid Hackathon #3 (theme: fun)
 *
 * Webcam Squid Game. All game logic in TypeScript; person detection comes
 * from the tiny LibreYOLO service in ../server/detect_server.py.
 *
 * The light cycle is shown by a doll that TURNS HER HEAD: facing away = green
 * (move), facing the room = red (freeze). When her head finishes turning to
 * the front, a sound plays and anyone who moved gets a tomato to the face.
 *
 * LIVE-TUNING KNOBS are the CONFIG block below. The one you'll touch first
 * is MOVE_THRESH (how twitchy elimination is). Test it with 3-4 people
 * before the demo — a threshold tuned solo is always too strict for a group.
 */

import { useEffect, useRef, type CSSProperties } from "react";

// ----------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------
const DETECT_URL = "http://localhost:8000/detect";
const CAPTURE_W = 512; // frame width sent to the detector (smaller = faster)
const DETECT_INTERVAL_MS = 120; // throttle detection; draw runs every frame

const MOVE_THRESH = 0.18; // eliminate if moved more than this * body height
const WIN_RATIO = 0.85; // box height / frame height that counts as "reached camera"
const EMA_ALPHA = 0.5; // centroid smoothing (higher = snappier, more jitter)
const MATCH_FRAC = 0.18; // max match distance between frames, fraction of diagonal
const MAX_MISSED = 12; // drop a track after this many missed detections

const GREEN_RANGE: [number, number] = [2.0, 5.0]; // seconds head faces away
const RED_RANGE: [number, number] = [1.8, 4.0]; // seconds head faces the room
const TURN_S = 0.65; // how long the head takes to swivel each way

// Sound played the instant her head finishes turning to the front (RED).
// Lives in web/public/. Missing file = silent, no error.
const DOLL_SFX_URL = "/shoot.mp3";

// Squid-ish palette
const PINK = "#ED1B76";
const GUARD = "#1FBF8F";
const GOLD = "#FFC83D";
const INK = "#14120b";
const PAPER = "#f3f1ea";
const TOMATO = "#e0341d";

const now = () => performance.now() / 1000;
type Box = [number, number, number, number];
interface Det {
  box: Box;
  conf: number;
  name: string;
}
interface ParsedDet {
  cx: number;
  cy: number;
  h: number;
  box: Box;
}

// ----------------------------------------------------------------------
// TRACKING
// ----------------------------------------------------------------------
class Track {
  id: number;
  cx: number;
  cy: number;
  h: number;
  box: Box;
  eliminated = false;
  won = false;
  ref: [number, number] | null = null;
  missed = 0;

  constructor(id: number, cx: number, cy: number, h: number, box: Box) {
    this.id = id;
    this.cx = cx;
    this.cy = cy;
    this.h = h;
    this.box = box;
  }

  update(cx: number, cy: number, h: number, box: Box) {
    this.cx = EMA_ALPHA * cx + (1 - EMA_ALPHA) * this.cx;
    this.cy = EMA_ALPHA * cy + (1 - EMA_ALPHA) * this.cy;
    this.h = h;
    this.box = box;
    this.missed = 0;
  }
}

class Tracker {
  tracks: Track[] = [];
  private nextId = 1;

  update(dets: ParsedDet[], diag: number) {
    const maxDist = MATCH_FRAC * diag;
    const pairs: [number, number, number][] = [];
    this.tracks.forEach((t, ti) => {
      dets.forEach((d, di) => {
        const dist = Math.hypot(t.cx - d.cx, t.cy - d.cy);
        if (dist <= maxDist) pairs.push([dist, ti, di]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);

    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      const d = dets[di];
      this.tracks[ti].update(d.cx, d.cy, d.h, d.box);
      usedT.add(ti);
      usedD.add(di);
    }

    this.tracks.forEach((t, ti) => {
      if (!usedT.has(ti)) t.missed += 1;
    });
    this.tracks = this.tracks.filter((t) => t.missed <= MAX_MISSED);

    dets.forEach((d, di) => {
      if (!usedD.has(di)) {
        this.tracks.push(new Track(this.nextId++, d.cx, d.cy, d.h, d.box));
      }
    });
  }

  reset() {
    for (const t of this.tracks) {
      t.eliminated = false;
      t.won = false;
      t.ref = null;
    }
  }
}

// ----------------------------------------------------------------------
// GAME STATE
//
// The doll drives the cycle. Phases:
//   GREEN     head faces away, players may move
//   TO_RED    head swiveling to face the room (still lenient)
//   RED       head fully turned — freeze; movement judged here
//   TO_GREEN  head swiveling back away
// ----------------------------------------------------------------------
type Phase = "GREEN" | "TO_RED" | "RED" | "TO_GREEN";

class Game {
  running = false;
  phase: Phase = "GREEN";
  private until = 0; // end of the current GREEN/RED dwell
  private turnStart = 0; // start of the current TO_RED / TO_GREEN swivel
  winner: number | null = null;

  start() {
    this.running = true;
    this.winner = null;
    this.enterGreen();
  }

  private enterGreen() {
    this.phase = "GREEN";
    const [lo, hi] = GREEN_RANGE;
    this.until = now() + lo + Math.random() * (hi - lo);
  }

  /**
   * Advance the phase clock. `onFullyRed` fires once, the moment her head
   * finishes turning to the front (play the sound there).
   */
  tick(tracker: Tracker, onFullyRed: () => void) {
    if (!this.running || this.winner !== null) return;
    const t = now();
    switch (this.phase) {
      case "GREEN":
        if (t >= this.until) {
          this.phase = "TO_RED";
          this.turnStart = t;
        }
        break;
      case "TO_RED":
        if (t - this.turnStart >= TURN_S) {
          this.phase = "RED";
          const [lo, hi] = RED_RANGE;
          this.until = t + lo + Math.random() * (hi - lo);
          // Snap the freeze reference the instant she is fully turned.
          for (const tr of tracker.tracks) if (!tr.eliminated) tr.ref = [tr.cx, tr.cy];
          onFullyRed();
        }
        break;
      case "RED":
        if (t >= this.until) {
          this.phase = "TO_GREEN";
          this.turnStart = t;
        }
        break;
      case "TO_GREEN":
        if (t - this.turnStart >= TURN_S) {
          this.enterGreen();
          for (const tr of tracker.tracks) tr.ref = null;
        }
        break;
    }
  }

  /** 0 = facing away (green), 1 = facing the room (red). For rendering. */
  headFacing(): number {
    const t = now();
    switch (this.phase) {
      case "GREEN":
        return 0;
      case "TO_RED":
        return Math.min(1, (t - this.turnStart) / TURN_S);
      case "RED":
        return 1;
      case "TO_GREEN":
        return Math.max(0, 1 - (t - this.turnStart) / TURN_S);
    }
  }

  judge(tracker: Tracker, frameH: number) {
    if (!this.running || this.winner !== null) return;
    for (const t of tracker.tracks) {
      if (t.eliminated) continue;
      if (t.h / frameH >= WIN_RATIO) {
        t.won = true;
        this.winner = t.id;
        this.running = false;
        return;
      }
      if (this.phase !== "RED") continue; // only judged while fully turned
      if (t.ref === null) {
        t.ref = [t.cx, t.cy]; // newcomer mid-red gets a lenient reference
        continue;
      }
      const disp = Math.hypot(t.cx - t.ref[0], t.cy - t.ref[1]);
      if (t.h > 0 && disp / t.h > MOVE_THRESH) t.eliminated = true;
    }
  }
}

// ----------------------------------------------------------------------
// TOMATO PARTICLES
// ----------------------------------------------------------------------
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number; // seconds remaining
  max: number; // initial life
  color: string;
}

const TOMATO_SHADES = [TOMATO, "#c0271a", "#ff5b3a", "#a81e12"];

function spawnSplat(particles: Particle[], x: number, y: number, scale: number) {
  const n = 26;
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const speed = (60 + Math.random() * 200) * scale;
    const life = 0.6 + Math.random() * 0.7;
    particles.push({
      x,
      y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed - 40 * scale,
      r: (3 + Math.random() * 7) * scale,
      life,
      max: life,
      color: TOMATO_SHADES[i % TOMATO_SHADES.length],
    });
  }
}

function stepParticles(particles: Particle[], dt: number) {
  const GRAV = 520;
  for (const p of particles) {
    p.life -= dt;
    p.vy += GRAV * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  // compact in place
  let w = 0;
  for (let r = 0; r < particles.length; r++) {
    if (particles[r].life > 0) particles[w++] = particles[r];
  }
  particles.length = w;
}

// ----------------------------------------------------------------------
// COMPONENT
// ----------------------------------------------------------------------
export default function RedLightGreenLight() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef(new Tracker());
  const gameRef = useRef(new Game());
  const dimsRef = useRef({ w: CAPTURE_W, h: Math.round((CAPTURE_W * 3) / 4) });

  // doll head DOM (rotated each frame from the loop, no React re-render)
  const headRef = useRef<HTMLDivElement>(null);
  const eyesRef = useRef<HTMLDivElement>(null);

  // audio (unlocked on the START gesture)
  const sfxRef = useRef<HTMLAudioElement | null>(null);

  // tomato splats + which players have already burst
  const particlesRef = useRef<Particle[]>([]);
  const burstRef = useRef<Set<number>>(new Set());

  function resetFx() {
    particlesRef.current.length = 0;
    burstRef.current.clear();
  }

  useEffect(() => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    if (!capRef.current) capRef.current = document.createElement("canvas");
    const cap = capRef.current;
    const capCtx = cap.getContext("2d")!;

    sfxRef.current = new Audio(DOLL_SFX_URL);
    sfxRef.current.preload = "auto";

    let raf = 0;
    let stream: MediaStream | null = null;
    let inFlight = false;
    let lastDetect = 0;
    let lastFrame = performance.now();
    let stopped = false;

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user" } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .catch((e) => console.error("Camera error:", e));

    video.onloadedmetadata = () => {
      const scale = CAPTURE_W / video.videoWidth;
      const h = Math.round(video.videoHeight * scale);
      dimsRef.current = { w: CAPTURE_W, h };
      cap.width = CAPTURE_W;
      cap.height = h;
      canvas.width = CAPTURE_W;
      canvas.height = h;
    };

    async function detect(): Promise<ParsedDet[]> {
      const { w, h } = dimsRef.current;
      capCtx.drawImage(video, 0, 0, w, h); // unmirrored pixels
      const blob: Blob = await new Promise((res) =>
        cap.toBlob((b) => res(b as Blob), "image/jpeg", 0.6),
      );
      const resp = await fetch(DETECT_URL, { method: "POST", body: blob });
      const json: { detections: Det[] } = await resp.json();
      return json.detections.map((d) => {
        const [x1, y1, x2, y2] = d.box;
        return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, h: y2 - y1, box: d.box };
      });
    }

    function drawTrack(t: Track, W: number) {
      const [x1, y1, x2, y2] = t.box;
      const mx1 = W - x2; // mirror x so boxes match the mirrored video
      const mx2 = W - x1;
      const color = t.won ? GOLD : t.eliminated ? PINK : GUARD;
      ctx.lineWidth = t.won || t.eliminated ? 4 : 2;
      ctx.strokeStyle = color;
      ctx.strokeRect(mx1, y1, mx2 - mx1, y2 - y1);
      const label = t.won ? `P${t.id} WINNER` : t.eliminated ? `P${t.id} SPLAT` : `P${t.id}`;
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillStyle = color;
      ctx.fillText(label, mx1, Math.max(14, y1 - 6));

      // Persistent tomato stain on eliminated players (deterministic per id).
      if (t.eliminated) {
        const cx = (mx1 + mx2) / 2;
        const cy = y1 + (y2 - y1) * 0.28;
        const rr = Math.max(10, (mx2 - mx1) * 0.22);
        ctx.globalAlpha = 0.55;
        for (let i = 0; i < 5; i++) {
          const a = (i * 2.3 + t.id) % (Math.PI * 2);
          const d = rr * (0.2 + ((i * 7 + t.id) % 5) / 6);
          ctx.fillStyle = TOMATO_SHADES[i % TOMATO_SHADES.length];
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    function draw() {
      const game = gameRef.current;
      const tracker = trackerRef.current;
      const W = canvas.width;
      const H = canvas.height;
      const tn = performance.now();
      const dt = Math.min(0.05, (tn - lastFrame) / 1000);
      lastFrame = tn;

      ctx.clearRect(0, 0, W, H);

      // newly-eliminated players burst a tomato
      for (const t of tracker.tracks) {
        if (t.eliminated && !burstRef.current.has(t.id)) {
          burstRef.current.add(t.id);
          const [x1, y1, x2, y2] = t.box;
          const cx = W - (x1 + x2) / 2;
          const cy = y1 + (y2 - y1) * 0.28;
          spawnSplat(particlesRef.current, cx, cy, Math.max(0.7, (x2 - x1) / 120));
        }
      }

      for (const t of tracker.tracks) drawTrack(t, W);

      // tomato particles on top of the boxes
      stepParticles(particlesRef.current, dt);
      for (const p of particlesRef.current) {
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // drive the doll's head (DOM, smooth every frame)
      const hf = game.running ? game.headFacing() : 0;
      if (headRef.current) {
        headRef.current.style.transform = `rotateY(${180 * (1 - hf)}deg)`;
      }
      if (eyesRef.current) {
        // eyes glow red as she comes around to face the room
        eyesRef.current.style.opacity = hf > 0.55 ? "1" : "0";
        eyesRef.current.style.boxShadow = hf > 0.85 ? `0 0 14px 4px ${PINK}` : "none";
      }

      // a red vignette while frozen, for drama
      if (game.running && hf > 0.9) {
        ctx.save();
        const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
        g.addColorStop(0, "rgba(237,27,118,0)");
        g.addColorStop(1, "rgba(237,27,118,0.28)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // Bottom HUD
      const alive = tracker.tracks.filter((t) => !t.eliminated).length;
      let msg: string;
      if (!game.running && game.winner === null) msg = "press START";
      else if (game.winner !== null) msg = `P${game.winner} WINS! — press START to replay`;
      else {
        const label =
          game.phase === "GREEN" ? "GREEN — move" : game.phase === "RED" ? "RED — freeze!" : "…turning…";
        msg = `${label}   alive: ${alive}`;
      }
      ctx.font = "bold 15px system-ui, sans-serif";
      const tw = ctx.measureText(msg).width;
      ctx.fillStyle = INK;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(0, H - 30, tw + 20, 30);
      ctx.globalAlpha = 1;
      ctx.fillStyle = PAPER;
      ctx.fillText(msg, 10, H - 9);
    }

    function loop() {
      const t = performance.now();
      if (!inFlight && t - lastDetect >= DETECT_INTERVAL_MS && video.readyState >= 2) {
        inFlight = true;
        lastDetect = t;
        detect()
          .then((dets) => {
            const { w, h } = dimsRef.current;
            const diag = Math.hypot(w, h);
            trackerRef.current.update(dets, diag);
            gameRef.current.tick(trackerRef.current, () => {
              const a = sfxRef.current;
              if (a) {
                a.currentTime = 0;
                a.play().catch(() => {}); // missing file / not unlocked => silent
              }
            });
            gameRef.current.judge(trackerRef.current, h);
          })
          .catch(() => {})
          .finally(() => {
            inFlight = false;
          });
      }
      draw();
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  function handleStart() {
    // Unlock audio inside the user gesture so it can play later on its own.
    const a = sfxRef.current;
    if (a) {
      a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {});
    }
    resetFx();
    trackerRef.current.reset();
    gameRef.current.start();
  }

  function handleRevive() {
    resetFx();
    trackerRef.current.reset();
    gameRef.current.running = false;
    gameRef.current.winner = null;
  }

  return (
    <div style={{ minHeight: "100vh", background: INK, color: PAPER, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
        <h1 style={{ letterSpacing: 4, textTransform: "uppercase", fontSize: 22, margin: "0 0 4px" }}>
          <span style={{ color: PINK }}>{"◯"}</span>{" "}
          <span style={{ color: GUARD }}>{"△"}</span>{" "}
          <span style={{ color: GOLD }}>{"▢"}</span>
          &nbsp;Red Light · Green Light
        </h1>
        <p style={{ opacity: 0.7, margin: "0 0 16px", fontSize: 13 }}>
          The doll faces away = move. She turns around = freeze. Move while she watches and it's tomato time.
        </p>

        <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", background: "#000", borderRadius: 12, overflow: "hidden" }}>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
          />
          <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />

          {/* The doll, watching from the corner */}
          <Doll headRef={headRef} eyesRef={eyesRef} />
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button onClick={handleStart} style={btn(PINK)}>
            START / RESTART
          </button>
          <button onClick={handleRevive} style={btn("#3a3730")}>
            REVIVE ALL
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// DOLL  (pure CSS/divs; the head is a 3D flip-card driven from the loop)
// ----------------------------------------------------------------------
function Doll({
  headRef,
  eyesRef,
}: {
  headRef: React.RefObject<HTMLDivElement>;
  eyesRef: React.RefObject<HTMLDivElement>;
}) {
  const SKIN = "#f4d9b0";
  const HAIR = "#3a2a1a";
  const DRESS = "#f4a93b";
  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        right: 10,
        width: 96,
        padding: "8px 8px 10px",
        borderRadius: 10,
        background: "rgba(20,18,11,0.55)",
        border: `2px solid ${GOLD}`,
        backdropFilter: "blur(2px)",
        textAlign: "center",
      }}
    >
      <div style={{ perspective: 320, height: 64, display: "flex", justifyContent: "center", alignItems: "flex-end" }}>
        <div
          ref={headRef}
          style={{
            position: "relative",
            width: 52,
            height: 56,
            transformStyle: "preserve-3d",
            transform: "rotateY(180deg)",
            transition: "none",
          }}
        >
          {/* FRONT of head — face */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              borderRadius: "46% 46% 44% 44%",
              background: SKIN,
              border: `3px solid ${HAIR}`,
              boxSizing: "border-box",
            }}
          >
            <div
              ref={eyesRef}
              style={{
                position: "absolute",
                top: 22,
                left: 0,
                right: 0,
                display: "flex",
                justifyContent: "center",
                gap: 10,
                opacity: 0,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: PINK }} />
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: PINK }} />
            </div>
            {/* rosy cheeks + mouth */}
            <span style={{ position: "absolute", top: 33, left: 6, width: 9, height: 6, borderRadius: "50%", background: "#e98", opacity: 0.7 }} />
            <span style={{ position: "absolute", top: 33, right: 6, width: 9, height: 6, borderRadius: "50%", background: "#e98", opacity: 0.7 }} />
            <span style={{ position: "absolute", top: 41, left: "50%", transform: "translateX(-50%)", width: 10, height: 5, borderBottom: `2px solid ${HAIR}`, borderRadius: "0 0 8px 8px" }} />
            {/* bangs */}
            <span style={{ position: "absolute", top: -3, left: -3, right: -3, height: 16, background: HAIR, borderRadius: "46% 46% 30% 30%" }} />
          </div>

          {/* BACK of head — just hair + a bun */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              transform: "rotateY(180deg)",
              borderRadius: "46% 46% 44% 44%",
              background: HAIR,
            }}
          >
            <span style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", width: 22, height: 22, borderRadius: "50%", background: "#2c2013" }} />
          </div>
        </div>
      </div>
      {/* pigtails */}
      <span style={{ position: "absolute", top: 30, left: 2, width: 14, height: 14, borderRadius: "50%", background: HAIR }} />
      <span style={{ position: "absolute", top: 30, right: 2, width: 14, height: 14, borderRadius: "50%", background: HAIR }} />
      {/* dress */}
      <div style={{ marginTop: 2, height: 22, background: DRESS, borderRadius: "6px 6px 4px 4px" }} />
      <div style={{ marginTop: 4, fontSize: 9, letterSpacing: 1, color: GOLD, fontWeight: 700 }}>YOUNG-HEE</div>
    </div>
  );
}

function btn(bg: string): CSSProperties {
  return {
    background: bg,
    color: "#fff",
    border: "none",
    padding: "12px 20px",
    borderRadius: 8,
    fontWeight: 700,
    letterSpacing: 1,
    cursor: "pointer",
    fontSize: 14,
  };
}
