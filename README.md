# Red Light · Green Light

Webcam Squid Game for the **Cursor Madrid Hackathon #3** (theme: _fun_).

Green light → players move toward the camera. Red light → freeze. Anyone who
moves during red is eliminated. First to reach the camera wins. The whole room
plays the demo live.

## Architecture

```
browser (TypeScript)                    Python (LibreYOLO)
─────────────────────                   ──────────────────
webcam ──capture frame every 120ms──▶   POST /detect
                                          └─ person boxes ──▶
tracker + game logic + canvas overlay ◀── { detections: [...] }
```

Python does **only** inference. Everything else — tracking, the red/green
state machine, elimination logic, rendering — is TypeScript.

### The contract (so you can split work in the team)

```
POST http://localhost:8000/detect
  body: raw JPEG bytes (Content-Type: image/jpeg)
  ->   { "detections": [ { "box": [x1,y1,x2,y2], "conf": 0.93, "name": "person" } ] }
       coordinates in pixels of the posted frame
```

Lock this in the first 10 minutes; frontend and backend then move in parallel.

## Run it locally

Two terminals.

**1. Detector (Python)** — `libreyolo` must already be installed.

```bash
cd server
pip install -r requirements.txt
uvicorn detect_server:app --port 8000
# first run downloads the YOLO9t weights; wait for "Ready."
```

**2. Frontend (TypeScript)**

```bash
cd web
npm install
npm run dev
# open the printed localhost URL, allow the camera, press START
```

> getUserMedia needs a secure context. `localhost` counts, so the Vite dev
> server works out of the box. If you serve from another IP you'll need HTTPS.

## Controls

- **START / RESTART** — begin a round
- **REVIVE ALL** — bring every player back to alive
- The light cycle (red/green) runs automatically.

## Tuning knobs

All at the top of `web/src/RedLightGreenLight.tsx`:

| Knob | What it does |
| --- | --- |
| `MOVE_THRESH` | How twitchy elimination is (fraction of body height). **Tune this first.** |
| `GREEN_RANGE` / `RED_RANGE` | Pacing of the light cycle, in seconds |
| `WIN_RATIO` | How close to the camera counts as a win |
| `DETECT_INTERVAL_MS` | Detection rate; raise if the laptop is laggy |
| `CAPTURE_W` | Frame width sent to the model; lower = faster |

Server side, `CONF_THRESH` in `detect_server.py`.

## Known limits (be honest in the demo)

- **ID swaps:** the greedy centroid tracker can swap player IDs when two people
  cross very close. Fine for a fun demo; don't claim it's robust.
- **Tune with a crowd:** a `MOVE_THRESH` that feels right solo is usually too
  strict for 3-4 people. Test with the group before presenting.
- **CPU:** YOLO9t on CPU is fine at a few FPS. If it lags, raise
  `DETECT_INTERVAL_MS` and/or drop `CAPTURE_W`.

## Nice next steps if time allows

- Swap POST-per-frame for a **WebSocket** (lower latency, smoother).
- Add the doll voice ("red light, green light") on state change — pure frontend,
  and it's what lands the demo on a _fun_ theme.
- A winner overlay / elimination sound.
```
