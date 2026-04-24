import cv2
import os
from picamera2 import Picamera2
import time

recognizer = cv2.face.LBPHFaceRecognizer_create()
recognizer.read(os.path.expanduser("~/your_project/trainer.yml"))

face_cascade = cv2.CascadeClassifier("/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml")

label_map = {}
with open(os.path.expanduser("~/your_project/labels.txt"), "r") as f:
    for line in f:	
        key, value = line.strip().split(",")
        label_map[int(key)] = value

picam2 = Picamera2()
config = picam2.create_preview_configuration(main={"format": "RGB888", "size": (640,480)})
picam2.configure(config)
picam2.start()
time.sleep(2)

while True:
    frame =picam2.capture_array()
    frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(gray, 1.3, 3)
    print("Faces found:", len(faces))

    for (x, y, w, h) in faces:
        face = gray[y:y+h, x:x+w]
        face = cv2.resize(face, (200, 200))
        label, confidence = recognizer.predict(face)
        if confidence < 80:
            name = label_map[label]
        else:
            name = "Unknown"
        cv2.rectangle(frame, (x, y), (x+w, y+h), (255, 0, 0), 2)
        cv2.putText(frame, name, (x, y-10), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255,0), 2)


    cv2.imshow("Face Recognition", frame)
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

picam2.stop()
cv2.destroyAllWindows()
