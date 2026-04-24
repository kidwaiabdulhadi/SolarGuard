# ════════════════════════════════════════════════════════════════
#  SolarGuard ADVANCED — Raspberry Pi Multi-Detection System
#  ▸ Face Recognition (LBPH)
#  ▸ Fall Detection (pose heuristics via body bounding box ratio)
#  ▸ Animal Detection (HOG + motion heuristics)
#  ▸ MJPEG Live Stream → PWA
#  ▸ Firebase Realtime DB integration
#
#  HOW TO RUN:
#    python3 recognize_firebase.py
#    hostname -I  → get Pi IP → enter in PWA settings
#
#  INSTALL DEPS (if needed):
#    pip3 install opencv-contrib-python picamera2
#
#  Firebase paths written:
#    faceRecognition/latest        → latest face result
#    faceRecognition/cameraStatus  → online/offline
#    detections/fall               → fall events
#    detections/animal             → animal sightings
#    alerts                        → all alert types
# ════════════════════════════════════════════════════════════════

import cv2
import os
import time
import threading
import json
import urllib.request
import numpy as np
from http.server import BaseHTTPRequestHandler, HTTPServer
from picamera2 import Picamera2
from collections import deque

# ── FIREBASE CONFIG ──────────────────────────────────────────────
FIREBASE_DB_URL = "https://solar-guard-5d63b-default-rtdb.asia-southeast1.firebasedatabase.app"
FIREBASE_AUTH   = ""   # leave empty for test-mode DB

# ── STREAM CONFIG ────────────────────────────────────────────────
STREAM_PORT          = 8080
STREAM_FPS           = 20
STREAM_JPEG_QUALITY  = 72

# ── DETECTION TUNING ─────────────────────────────────────────────
FACE_CONFIDENCE_THRESHOLD = 80   # LBPH: lower = stricter
PUSH_INTERVAL_FACE        = 3    # seconds between Firebase face pushes
PUSH_INTERVAL_ALERT       = 5    # seconds between alert pushes

# Fall detection: person bounding box is "wide" relative to height
FALL_ASPECT_RATIO_THRESHOLD = 1.2   # width/height > this → possible fall
FALL_CONFIRM_FRAMES         = 4     # consecutive frames to confirm fall

# Animal detection HOG params
ANIMAL_MIN_SIZE   = (60, 60)
ANIMAL_MAX_SIZE   = (400, 400)

# ── PATHS ────────────────────────────────────────────────────────
BASE_DIR = os.path.expanduser("~/your_project")


# ════════════════════════════════════════════════════════════════
#  LOAD MODELS
# ════════════════════════════════════════════════════════════════

# Face recognizer
recognizer = cv2.face.LBPHFaceRecognizer_create()
recognizer.read(os.path.join(BASE_DIR, "trainer.yml"))

face_cascade = cv2.CascadeClassifier(
    "/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml"
)

# Full-body detector (used for fall detection)
body_cascade = cv2.CascadeClassifier(
    "/usr/share/opencv4/haarcascades/haarcascade_fullbody.xml"
)

# HOG person detector (backup for fall detection)
hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

# Animal cascade (cat face — available in most OpenCV builds)
animal_cascade_path = "/usr/share/opencv4/haarcascades/haarcascade_frontalcatface.xml"
animal_cascade = None
if os.path.exists(animal_cascade_path):
    animal_cascade = cv2.CascadeClassifier(animal_cascade_path)
    print("[SolarGuard] Animal (cat) cascade loaded.")
else:
    print("[SolarGuard] Cat cascade not found — animal detection uses motion heuristics only.")

# Label map
label_map = {}
with open(os.path.join(BASE_DIR, "labels.txt"), "r") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        key, value = line.split(",", 1)
        label_map[int(key)] = value

print(f"[SolarGuard] Known people: {list(label_map.values())}")


# ════════════════════════════════════════════════════════════════
#  CAMERA SETUP
# ════════════════════════════════════════════════════════════════
picam2 = Picamera2()
config = picam2.create_preview_configuration(
    main={"format": "RGB888", "size": (640, 480)}
)
picam2.configure(config)
picam2.start()
time.sleep(2)
print("[SolarGuard] Camera started.")


# ════════════════════════════════════════════════════════════════
#  SHARED STATE
# ════════════════════════════════════════════════════════════════
latest_frame      = None
frame_lock        = threading.Lock()
stats_lock        = threading.Lock()

# Rolling detection stats (last 60s)
detection_history = deque(maxlen=200)

# Fall detection state
fall_frame_count  = 0
fall_alerted      = False
fall_cooldown     = 0   # epoch time after which we can re-alert

# Motion-based animal detection
prev_gray         = None
motion_frames     = deque(maxlen=5)


# ════════════════════════════════════════════════════════════════
#  FIREBASE HELPERS
# ════════════════════════════════════════════════════════════════
def _fb_request(method, path, data=None):
    try:
        url = f"{FIREBASE_DB_URL}/{path}.json"
        if FIREBASE_AUTH:
            url += f"?auth={FIREBASE_AUTH}"
        payload = json.dumps(data).encode("utf-8") if data else None
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"},
            method=method
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[Firebase] {method} error at {path}: {e}")

def firebase_put(path, data):
    _fb_request("PUT", path, data)

def firebase_post(path, data):
    _fb_request("POST", path, data)


# ════════════════════════════════════════════════════════════════
#  MJPEG STREAM SERVER
# ════════════════════════════════════════════════════════════════
class MJPEGHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                while True:
                    with frame_lock:
                        if latest_frame is None:
                            time.sleep(0.05)
                            continue
                        fc = latest_frame.copy()
                    _, jpeg = cv2.imencode(
                        ".jpg", fc,
                        [cv2.IMWRITE_JPEG_QUALITY, STREAM_JPEG_QUALITY]
                    )
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n\r\n")
                    self.wfile.write(jpeg.tobytes())
                    self.wfile.write(b"\r\n")
                    time.sleep(1 / STREAM_FPS)
            except (BrokenPipeError, ConnectionResetError):
                pass

        elif self.path == "/snapshot":
            with frame_lock:
                if latest_frame is not None:
                    _, jpeg = cv2.imencode(".jpg", latest_frame)
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(jpeg.tobytes())
                    return
            self.send_response(503)
            self.end_headers()

        elif self.path == "/stats":
            with stats_lock:
                hist = list(detection_history)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(hist).encode())

        else:
            self.send_response(404)
            self.end_headers()


def run_stream_server():
    server = HTTPServer(("0.0.0.0", STREAM_PORT), MJPEGHandler)
    print(f"[Stream] MJPEG on :{STREAM_PORT}  — /stream  /snapshot  /stats")
    server.serve_forever()

stream_thread = threading.Thread(target=run_stream_server, daemon=True)
stream_thread.start()


# ════════════════════════════════════════════════════════════════
#  HELPER — DRAW OVERLAY PANEL
# ════════════════════════════════════════════════════════════════
def draw_hud(frame, faces_count, fall_detected, animal_detected):
    """Draws a semi-transparent HUD on the frame."""
    h, w = frame.shape[:2]
    overlay = frame.copy()
    # Top bar
    cv2.rectangle(overlay, (0, 0), (w, 36), (10, 10, 20), -1)
    cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)
    ts = time.strftime("%Y-%m-%d  %H:%M:%S")
    cv2.putText(frame, f"SolarGuard  |  {ts}", (10, 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (180, 220, 255), 1)
    # Status icons
    icons = []
    icons.append(f"Faces:{faces_count}")
    if fall_detected:
        icons.append("FALL!")
    if animal_detected:
        icons.append("ANIMAL")
    status = "   ".join(icons)
    cv2.putText(frame, status, (w - 260, 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                (0, 80, 255) if fall_detected else (100, 255, 140), 1)


# ════════════════════════════════════════════════════════════════
#  DETECTION — FALL
# ════════════════════════════════════════════════════════════════
def detect_fall(gray, frame):
    """
    Returns (fall_detected: bool, annotated_frame).
    Heuristic: full-body bounding box width > height * threshold.
    """
    global fall_frame_count, fall_alerted, fall_cooldown

    bodies, _ = hog.detectMultiScale(
        gray,
        winStride=(8, 8),
        padding=(4, 4),
        scale=1.05
    )

    fall_this_frame = False
    for (bx, by, bw, bh) in bodies:
        aspect = bw / max(bh, 1)
        color = (0, 165, 255)  # orange default
        label = "Person"

        if aspect > FALL_ASPECT_RATIO_THRESHOLD:
            fall_this_frame = True
            color = (0, 0, 255)
            label = f"FALL? ({aspect:.1f})"

        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), color, 2)
        cv2.putText(frame, label, (bx, by - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

    if fall_this_frame:
        fall_frame_count += 1
    else:
        fall_frame_count = max(0, fall_frame_count - 1)

    confirmed = fall_frame_count >= FALL_CONFIRM_FRAMES
    now = time.time()

    if confirmed and now > fall_cooldown:
        fall_cooldown  = now + 30   # 30 s cool-down
        fall_frame_count = 0
        return True, frame

    return False, frame


# ════════════════════════════════════════════════════════════════
#  DETECTION — ANIMAL
# ════════════════════════════════════════════════════════════════
def detect_animal(gray, frame):
    """
    Returns (animal_detected: bool, annotated_frame).
    Uses cat-face cascade + motion blob heuristics.
    """
    global prev_gray, motion_frames

    animal_found = False

    # ── Cascade (cat face) ──────────────────────────────────────
    if animal_cascade is not None:
        cats = animal_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=4,
            minSize=ANIMAL_MIN_SIZE, maxSize=ANIMAL_MAX_SIZE
        )
        for (ax, ay, aw, ah) in cats:
            animal_found = True
            cv2.rectangle(frame, (ax, ay), (ax + aw, ay + ah), (255, 160, 0), 2)
            cv2.putText(frame, "Animal (cat)", (ax, ay - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 160, 0), 2)

    # ── Motion blob heuristic ───────────────────────────────────
    if prev_gray is not None:
        diff = cv2.absdiff(prev_gray, gray)
        _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
        thresh = cv2.dilate(thresh, None, iterations=2)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            # Small fast-moving blobs near the ground → possible small animal
            if 800 < area < 15000:
                mx, my, mw, mh = cv2.boundingRect(cnt)
                aspect = mw / max(mh, 1)
                # Quadruped aspect: wider than tall
                if 0.8 < aspect < 3.0 and my > frame.shape[0] * 0.4:
                    motion_frames.append(1)
                    if sum(motion_frames) >= 3:
                        animal_found = True
                        cv2.rectangle(frame, (mx, my), (mx + mw, my + mh),
                                      (255, 100, 0), 1)
                        cv2.putText(frame, "Motion/Animal?",
                                    (mx, my - 6),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                                    (255, 100, 0), 1)
                else:
                    motion_frames.append(0)

    prev_gray = gray.copy()
    return animal_found, frame


# ════════════════════════════════════════════════════════════════
#  MARK CAMERA ONLINE
# ════════════════════════════════════════════════════════════════
firebase_put("faceRecognition/cameraStatus", {
    "online":       True,
    "streamPort":   STREAM_PORT,
    "capabilities": ["face", "fall", "animal"],
    "timestamp":    int(time.time() * 1000)
})
print("[Firebase] Camera ONLINE.")


# ════════════════════════════════════════════════════════════════
#  MAIN LOOP
# ════════════════════════════════════════════════════════════════
last_face_push   = 0
last_alert_push  = 0

print("[SolarGuard] Running — Press Q to quit.\n")

try:
    while True:
        frame = picam2.capture_array()
        frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray  = cv2.equalizeHist(gray)   # improve detection in low light

        now = time.time()
        ts  = int(now * 1000)

        # ── Face Recognition ─────────────────────────────────────
        faces_raw = face_cascade.detectMultiScale(
            gray, scaleFactor=1.3, minNeighbors=3, minSize=(50, 50)
        )
        face_result = None

        for (x, y, w, h) in faces_raw:
            roi = cv2.resize(gray[y:y + h, x:x + w], (200, 200))
            label_id, confidence = recognizer.predict(roi)

            if confidence < FACE_CONFIDENCE_THRESHOLD:
                name   = label_map.get(label_id, "Unknown")
                rtype  = "known"
                color  = (0, 220, 80)
            else:
                name   = "Unknown"
                rtype  = "unknown"
                color  = (0, 0, 230)

            cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
            cv2.putText(frame, f"{name} ({confidence:.0f})",
                        (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.75, color, 2)

            face_result = {
                "name":       name,
                "result":     rtype,
                "confidence": round((100 - confidence) / 100, 2),
                "camOnline":  True,
                "timestamp":  ts
            }

            # Firebase: face detection (rate-limited)
            if now - last_face_push > PUSH_INTERVAL_FACE:
                last_face_push = now
                firebase_put("faceRecognition/latest", face_result)

                if rtype == "unknown" and now - last_alert_push > PUSH_INTERVAL_ALERT:
                    last_alert_push = now
                    firebase_post("alerts", {**face_result, "type": "unknown_face"})
                    print(f"[Firebase] ALERT — Unknown face!")
                else:
                    print(f"[Firebase] Face: {name} conf={confidence:.0f}")

            # Record in local history
            with stats_lock:
                detection_history.append({
                    "type": "face", "name": name,
                    "result": rtype, "ts": ts
                })

        # ── Fall Detection ────────────────────────────────────────
        fall_detected, frame = detect_fall(gray, frame)
        if fall_detected:
            firebase_post("detections/fall", {
                "type": "fall", "timestamp": ts, "camOnline": True
            })
            firebase_post("alerts", {
                "type": "fall", "timestamp": ts,
                "name": "Fall Detected", "result": "fall",
                "confidence": 0.9, "camOnline": True
            })
            print("[Firebase] ALERT — FALL DETECTED!")
            with stats_lock:
                detection_history.append({"type": "fall", "ts": ts})

        # ── Animal Detection ──────────────────────────────────────
        animal_detected, frame = detect_animal(gray, frame)
        if animal_detected:
            firebase_post("detections/animal", {
                "type": "animal", "timestamp": ts, "camOnline": True
            })
            firebase_post("alerts", {
                "type": "animal", "timestamp": ts,
                "name": "Animal Detected", "result": "animal",
                "confidence": 0.75, "camOnline": True
            })
            print("[Firebase] ALERT — Animal detected!")
            with stats_lock:
                detection_history.append({"type": "animal", "ts": ts})

        # ── HUD overlay ───────────────────────────────────────────
        draw_hud(frame, len(faces_raw), fall_detected, animal_detected)

        # ── Share frame to MJPEG thread ───────────────────────────
        with frame_lock:
            latest_frame = frame.copy()

        # ── Local preview (remove if headless) ────────────────────
        cv2.imshow("SolarGuard (Q = quit)", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

except KeyboardInterrupt:
    print("\n[SolarGuard] Interrupted.")

finally:
    firebase_put("faceRecognition/cameraStatus", {
        "online": False, "timestamp": int(time.time() * 1000)
    })
    print("[Firebase] Camera OFFLINE.")
    picam2.stop()
    cv2.destroyAllWindows()
    print("[SolarGuard] Shutdown complete.")

