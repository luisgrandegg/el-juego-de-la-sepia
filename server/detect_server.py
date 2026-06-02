"""
detect_server.py — thin LibreYOLO inference service for the TS frontend.

This is the ONLY Python in the project. Everything else (webcam, tracking,
game logic, rendering) lives in TypeScript. This file just turns a JPEG into
a list of person boxes.

----------------------------------------------------------------------
RUN
----------------------------------------------------------------------
    # libreyolo must already be installed (hackathon track setup)
    pip install -r requirements.txt
    uvicorn detect_server:app --port 8000

----------------------------------------------------------------------
CONTRACT  (this is the interface the frontend depends on)
----------------------------------------------------------------------
    POST /detect
        body: raw JPEG bytes  (Content-Type: image/jpeg)
    ->  { "detections": [ { "box": [x1,y1,x2,y2], "conf": 0.93, "name": "person" }, ... ] }

    Coordinates are in pixels of the image you posted.
"""

import io

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

from libreyolo import LibreYOLO

MODEL_NAME = "LibreYOLO9t.pt"
CONF_THRESH = 0.40

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading LibreYOLO...")
model = LibreYOLO(MODEL_NAME)
print("Ready.")


def _np(x):
    try:
        return x.cpu().numpy()
    except AttributeError:
        import numpy as np
        return np.asarray(x)


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/detect")
async def detect(request: Request):
    data = await request.body()
    img = Image.open(io.BytesIO(data)).convert("RGB")

    results = model(img)
    r = results[0] if isinstance(results, (list, tuple)) else results

    xyxy = _np(r.boxes.xyxy)
    conf = _np(r.boxes.conf)
    cls = _np(r.boxes.cls).astype(int)
    names = r.names

    dets = []
    for (x1, y1, x2, y2), c, k in zip(xyxy, conf, cls):
        if c < CONF_THRESH or names.get(int(k), "") != "person":
            continue
        dets.append(
            {
                "box": [float(x1), float(y1), float(x2), float(y2)],
                "conf": float(c),
                "name": "person",
            }
        )
    return {"detections": dets}
