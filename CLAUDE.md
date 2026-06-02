# CLAUDE.md

Webcam "Red Light · Green Light" (Squid Game) demo. Webcam frames go to a
Python detector; all game logic and rendering is in TypeScript.

## Layout

- `server/detect_server.py` — the **only** Python. FastAPI service that turns a
  posted JPEG into person boxes. Inference only, nothing else.
- `web/src/RedLightGreenLight.tsx` — the whole game: tracking, red/green state
  machine, elimination, canvas overlay. Tuning knobs live at the top of this file.
- `web/src/App.tsx`, `web/src/main.tsx` — React entry points.

## The contract (don't break it)

```
POST http://localhost:8000/detect
  body: raw JPEG bytes (Content-Type: image/jpeg)
  ->   { "detections": [ { "box": [x1,y1,x2,y2], "conf": 0.93, "name": "person" } ] }
```

Coordinates are in pixels of the posted frame. Frontend and backend depend on
this shape — change both sides together.

## Run it (two terminals)

```bash
# 1. Detector — libreyolo must already be installed
cd server && pip install -r requirements.txt && uvicorn detect_server:app --port 8000

# 2. Frontend
cd web && npm install && npm run dev   # open the printed localhost URL, allow camera, press START
```

`getUserMedia` needs a secure context; `localhost` qualifies, so Vite works
out of the box. Build with `npm run build` (runs `tsc --noEmit` then `vite build`).

## Conventions

- Keep Python limited to inference — tracking/game/rendering stays in TS.
- Tune behavior via the constants at the top of `RedLightGreenLight.tsx`
  (`MOVE_THRESH` first) and `CONF_THRESH` in `detect_server.py`.

See `README.md` for the full demo notes, tuning table, and known limits.
