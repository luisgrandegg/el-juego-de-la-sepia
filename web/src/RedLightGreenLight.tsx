/**
 * RedLightGreenLight.tsx
 * Cursor Madrid Hackathon #3 (theme: fun)
 *
 * Webcam Squid Game. All game logic in TypeScript; person detection comes
 * from the tiny LibreYOLO service in ../server/detect_server.py.
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

const GREEN_RANGE: [number, number] = [2.0, 5.0]; // seconds
const RED_RANGE: [number, number] = [1.8, 4.0]; // seconds

// Squid-ish palette
const PINK = "#ED1B76";
const GUARD = "#1FBF8F";
const GOLD = "#FFC83D";
const INK = "#14120b";
const PAPER = "#f3f1ea";

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
// ----------------------------------------------------------------------
type State = "GREEN" | "RED";

class Game {
  running = false;
  state: State = "GREEN";
  until = 0;
  winner: number | null = null;

  start() {
    this.running = true;
    this.winner = null;
    this.enter("GREEN");
  }

  private enter(state: State) {
    this.state = state;
    const [lo, hi] = state === "GREEN" ? GREEN_RANGE : RED_RANGE;
    this.until = now() + lo + Math.random() * (hi - lo);
  }

  tick(tracker: Tracker) {
    if (!this.running || this.winner !== null) return;
    if (now() < this.until) return;
    if (this.state === "GREEN") {
      this.enter("RED");
      for (const t of tracker.tracks) if (!t.eliminated) t.ref = [t.cx, t.cy];
    } else {
      this.enter("GREEN");
      for (const t of tracker.tracks) t.ref = null;
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
      if (this.state !== "RED") continue;
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
// COMPONENT
// ----------------------------------------------------------------------
export default function RedLightGreenLight() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef(new Tracker());
  const gameRef = useRef(new Game());
  const dimsRef = useRef({ w: CAPTURE_W, h: Math.round((CAPTURE_W * 3) / 4) });

  useEffect(() => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    if (!capRef.current) capRef.current = document.createElement("canvas");
    const cap = capRef.current;
    const capCtx = cap.getContext("2d")!;

    let raf = 0;
    let stream: MediaStream | null = null;
    let inFlight = false;
    let lastDetect = 0;
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
      const label = t.won ? `P${t.id} WINNER` : t.eliminated ? `P${t.id} OUT` : `P${t.id}`;
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillStyle = color;
      ctx.fillText(label, mx1, Math.max(14, y1 - 6));
      if (t.eliminated) {
        ctx.beginPath();
        ctx.moveTo(mx1, y1);
        ctx.lineTo(mx2, y2);
        ctx.moveTo(mx2, y1);
        ctx.lineTo(mx1, y2);
        ctx.stroke();
      }
    }

    function draw() {
      const game = gameRef.current;
      const tracker = trackerRef.current;
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      for (const t of tracker.tracks) drawTrack(t, W);

      // Top banner
      if (game.running) {
        const red = game.state === "RED";
        const bar = Math.round(H * 0.14);
        ctx.fillStyle = red ? PINK : GUARD;
        ctx.globalAlpha = 0.82;
        ctx.fillRect(0, 0, W, bar);
        ctx.globalAlpha = 1;
        ctx.fillStyle = PAPER;
        ctx.font = `bold ${Math.round(bar * 0.42)}px system-ui, sans-serif`;
        ctx.fillText(red ? "RED LIGHT  \u25EF FREEZE" : "GREEN LIGHT  \u25B3 MOVE", 16, bar * 0.62);
      }

      // Bottom HUD
      const alive = tracker.tracks.filter((t) => !t.eliminated).length;
      let msg: string;
      if (!game.running && game.winner === null) msg = "press START";
      else if (game.winner !== null) msg = `P${game.winner} WINS! \u2014 press START to replay`;
      else msg = `${game.state}  ${Math.max(0, game.until - now()).toFixed(1)}s   alive: ${alive}`;
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
            gameRef.current.tick(trackerRef.current);
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

  return (
    <div style={{ minHeight: "100vh", background: INK, color: PAPER, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>
        <h1 style={{ letterSpacing: 4, textTransform: "uppercase", fontSize: 22, margin: "0 0 4px" }}>
          <span style={{ color: PINK }}>{"\u25EF"}</span>{" "}
          <span style={{ color: GUARD }}>{"\u25B3"}</span>{" "}
          <span style={{ color: GOLD }}>{"\u25A2"}</span>
          &nbsp;Red Light · Green Light
        </h1>
        <p style={{ opacity: 0.7, margin: "0 0 16px", fontSize: 13 }}>
          Green = move toward the camera. Red = freeze. First to reach the camera wins.
        </p>

        <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", background: "#000", borderRadius: 12, overflow: "hidden" }}>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
          />
          <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button onClick={() => gameRef.current.start()} style={btn(PINK)}>
            START / RESTART
          </button>
          <button
            onClick={() => {
              trackerRef.current.reset();
              gameRef.current.running = false;
              gameRef.current.winner = null;
            }}
            style={btn("#3a3730")}
          >
            REVIVE ALL
          </button>
        </div>
      </div>
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
