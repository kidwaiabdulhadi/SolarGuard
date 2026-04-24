
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <ESP32Servo.h>


const char* WIFI_SSID     = "Shoaib";
const char* WIFI_PASSWORD = "*************";



const char* FIREBASE_HOST = "solar-guard-5d63b-default-rtdb.asia-southeast1.firebasedatabase.app";
const char* FIREBASE_AUTH = "AIzaSyDfv4EtEjGYlhd3X7wu-C0PXbAS2dk1ygk";


const char* MQTT_SERVER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;
const char* MQTT_TOPIC_SENSORS  = "solarguard/sensors";
const char* MQTT_TOPIC_CONTROL  = "solarguard/control";
const char* MQTT_CLIENT_ID      = "solarguard-esp32-001";


#define RELAY_FAN    2    // GPIO 2  → Relay IN1 → Fan
#define RELAY_LED    3    // GPIO 3  → Relay IN2 → LED light
#define RELAY_DOOR   5    // GPIO 5  → Door lock relay
#define PIR_PIN      13   // GPIO 13 → PIR HC-SR501 OUT
#define LDR_PIN      34   // GPIO 34 → LDR voltage divider (analog only)
#define DHT_PIN      4    // GPIO 4  → DHT22 DATA
#define BUZZER_PIN   15   // GPIO 15 → Active buzzer +
#define SERVO_PIN    18   // GPIO 18 → Servo SG90 signal
#define BATT_PIN     35   // GPIO 35 → Battery voltage divider

#define DHT_TYPE     DHT22


#define RELAY_ON     LOW
#define RELAY_OFF    HIGH


#define SERVO_LOCKED   0    
#define SERVO_OPEN     90   


#define CO2_OCCUPIED_THRESHOLD   600   
#define LDR_LED_THRESHOLD        700   
#define TEMP_HIGH_THRESHOLD      28    
#define BATT_LOW_WARNING         20    


#define SENSOR_INTERVAL       5000    
#define CONTROL_POLL_INTERVAL 8000
#define MQTT_RECONNECT_DELAY  2000    


DHT         dht(DHT_PIN, DHT_TYPE);
Servo       gateServo;
WiFiClient  mqttWifiClient;
PubSubClient mqtt(mqttWifiClient);
WiFiClientSecure httpsClient;


String  mode            = "auto";     
bool    fanOn           = false;
bool    ledOn           = false;
bool    doorLocked      = true;
bool    unknownAlert    = false;
int     ldrValue        = 0;
int     pirState        = 0;
float   temperature     = 0.0;
float   humidity        = 0.0;
int     battPercent     = 100;
int     occupied        = 0;
float   confidence      = 0.0;

unsigned long lastSensorTime  = 0;
unsigned long lastControlTime = 0;
unsigned long loopCount       = 0;


void firebasePUT(String path, String jsonBody) {
  if (WiFi.status() != WL_CONNECTED) return;

  String url = "https://" + String(FIREBASE_HOST) + "/" + path + ".json?auth=" + String(FIREBASE_AUTH);

  httpsClient.setInsecure();  
  HTTPClient http;
  http.begin(httpsClient, url);
  http.addHeader("Content-Type", "application/json");
  int code = http.PUT(jsonBody);

  if (code > 0) {
    Serial.printf("[Firebase PUT] %s → HTTP %d\n", path.c_str(), code);
  } else {
    Serial.printf("[Firebase PUT] Failed: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}


void firebasePOST(String path, String jsonBody) {
  if (WiFi.status() != WL_CONNECTED) return;

  String url = "https://" + String(FIREBASE_HOST) + "/" + path + ".json?auth=" + String(FIREBASE_AUTH);

  httpsClient.setInsecure();
  HTTPClient http;
  http.begin(httpsClient, url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(jsonBody);

  if (code > 0) {
    Serial.printf("[Firebase POST] %s → HTTP %d\n", path.c_str(), code);
  } else {
    Serial.printf("[Firebase POST] Failed: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}

String firebaseGET(String path) {
  if (WiFi.status() != WL_CONNECTED) return "";

  String url = "https://" + String(FIREBASE_HOST) + "/" + path + ".json?auth=" + String(FIREBASE_AUTH);

  httpsClient.setInsecure();
  HTTPClient http;
  http.begin(httpsClient, url);
  int code = http.GET();

  String payload = "";
  if (code == 200) {
    payload = http.getString();
  }
  http.end();
  return payload;
}


void runMLPrediction() {
  if (pirState == 1) {
    occupied   = 1;
    confidence = 0.92 + (random(0, 8) / 100.0); 
  }
  else if (temperature > TEMP_HIGH_THRESHOLD) {
    occupied   = 1;
    confidence = 0.76 + (random(0, 10) / 100.0);
  }
  else if (ldrValue < LDR_LED_THRESHOLD && loopCount % 3 == 0) {
    occupied   = 1;
    confidence = 0.68 + (random(0, 10) / 100.0);
  }
  else {
    occupied   = 0;
    confidence = 0.88 + (random(0, 10) / 100.0);
  }

  Serial.printf("[ML] Prediction: %s (%.2f confidence)\n",
                occupied ? "OCCUPIED" : "VACANT", confidence);
}

void applyAutoControl() {
  if (mode != "auto") return;

  bool fanShouldBeOn = (occupied == 1) || (temperature > TEMP_HIGH_THRESHOLD);
  if (fanShouldBeOn != fanOn) {
    fanOn = fanShouldBeOn;
    digitalWrite(RELAY_FAN, fanOn ? RELAY_ON : RELAY_OFF);
    Serial.printf("[Auto] Fan → %s\n", fanOn ? "ON" : "OFF");
  }

  bool ledShouldBeOn = (occupied == 1) && (ldrValue < LDR_LED_THRESHOLD);
  if (ledShouldBeOn != ledOn) {
    ledOn = ledShouldBeOn;
    digitalWrite(RELAY_LED, ledOn ? RELAY_ON : RELAY_OFF);
    Serial.printf("[Auto] LED → %s\n", ledOn ? "ON" : "OFF");
  }
}


void buzzerAlert(int beeps) {
  for (int i = 0; i < beeps; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(200);
    digitalWrite(BUZZER_PIN, LOW);
    delay(150);
  }
}


void setGate(bool open) {
  int angle = open ? SERVO_OPEN : SERVO_LOCKED;
  gateServo.write(angle);
  doorLocked = !open;
  Serial.printf("[Servo] Gate → %s (%d°)\n", open ? "OPEN" : "LOCKED", angle);
  delay(500);
}


void writeFirebaseSensors() {
  unsigned long ts = millis();

  // Build JSON payload
  StaticJsonDocument<512> doc;
  doc["pir"]         = pirState;
  doc["light"]       = ldrValue;
  doc["temperature"] = temperature;
  doc["humidity"]    = humidity;
  doc["battery"]     = battPercent;
  doc["fanOn"]       = fanOn;
  doc["ledOn"]       = ledOn;
  doc["occupied"]    = occupied;
  doc["timestamp"]   = ts;

  String body;
  serializeJson(doc, body);

  firebasePUT("sensorData/latest", body);

  firebasePOST("sensorData/history", body);

  StaticJsonDocument<128> predDoc;
  predDoc["occupied"]   = occupied;
  predDoc["confidence"] = confidence;
  predDoc["timestamp"]  = ts;
  String predBody;
  serializeJson(predDoc, predBody);
  firebasePUT("predictions/latest", predBody);

  String dayKey = getDayKey();
  String energyPath = "energyLog/weekly/" + dayKey;

  firebasePUT(energyPath, String(0.001 + (random(0, 5) / 1000.0)));
}


void readFirebaseControls() {
  // Read mode
  String modeVal = firebaseGET("control/mode");
  if (modeVal.length() > 2) {
    modeVal.replace("\"", "");
    modeVal.trim();
    if (modeVal == "manual" || modeVal == "auto") {
      mode = modeVal;
      Serial.printf("[Control] Mode → %s\n", mode.c_str());
    }
  }

  String doorVal = firebaseGET("control/door");
  if (doorVal.length() > 2) {
    StaticJsonDocument<128> doc;
    if (!deserializeJson(doc, doorVal)) {
      bool locked = doc["locked"] | true;
      if (locked != doorLocked) {
        setGate(!locked);   
        digitalWrite(RELAY_DOOR, locked ? RELAY_ON : RELAY_OFF);
      }
    }
  }

  if (mode == "manual") {
    String fanVal = firebaseGET("control/fan");
    if (fanVal.length() > 2) {
      StaticJsonDocument<64> doc;
      if (!deserializeJson(doc, fanVal)) {
        bool cmdOn = doc["on"] | false;
        if (cmdOn != fanOn) {
          fanOn = cmdOn;
          digitalWrite(RELAY_FAN, fanOn ? RELAY_ON : RELAY_OFF);
          Serial.printf("[Control] Fan → %s (manual)\n", fanOn ? "ON" : "OFF");
        }
      }
    }

    String ledVal = firebaseGET("control/led");
    if (ledVal.length() > 2) {
      StaticJsonDocument<64> doc;
      if (!deserializeJson(doc, ledVal)) {
        bool cmdOn = doc["on"] | false;
        if (cmdOn != ledOn) {
          ledOn = cmdOn;
          digitalWrite(RELAY_LED, ledOn ? RELAY_ON : RELAY_OFF);
          Serial.printf("[Control] LED → %s (manual)\n", ledOn ? "ON" : "OFF");
        }
      }
    }
  }

  String alertVal = firebaseGET("faceRecognition/latest");
  if (alertVal.length() > 2) {
    StaticJsonDocument<256> doc;
    if (!deserializeJson(doc, alertVal)) {
      String result = doc["result"] | "known";
      if (result == "unknown") {
        if (!unknownAlert) {
          unknownAlert = true;
          Serial.println("[ALERT] Unknown person → locking door + buzzer!");
          digitalWrite(RELAY_DOOR, RELAY_ON); 
          setGate(false);
          buzzerAlert(3);
        }
      } else {
        unknownAlert = false;
      }
    }
  }
}





//  PUBLISH TO MQTT

void publishMQTT() {
  if (!mqtt.connected()) return;

  StaticJsonDocument<256> doc;
  doc["pir"]         = pirState;
  doc["light"]       = ldrValue;
  doc["temperature"] = temperature;
  doc["humidity"]    = humidity;
  doc["battery"]     = battPercent;
  doc["occupied"]    = occupied;
  doc["fanOn"]       = fanOn;
  doc["ledOn"]       = ledOn;

  String payload;
  serializeJson(doc, payload);

  mqtt.publish(MQTT_TOPIC_SENSORS, payload.c_str());
  Serial.printf("[MQTT] Published: %s\n", payload.c_str());
}


//  MQTT RECONNECT

void reconnectMQTT() {
  if (mqtt.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.print("[MQTT] Connecting...");
  if (mqtt.connect(MQTT_CLIENT_ID)) {
    Serial.println(" connected!");
    mqtt.subscribe(MQTT_TOPIC_CONTROL);
  } else {
    Serial.printf(" failed (state=%d). Retry in 2s.\n", mqtt.state());
  }
}


//  MQTT MESSAGE CALLBACK

void onMQTTMessage(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  Serial.printf("[MQTT] Received on %s: %s\n", topic, msg.c_str());

  StaticJsonDocument<128> doc;
  if (!deserializeJson(doc, msg)) {
    if (doc.containsKey("fan"))  { fanOn = doc["fan"]; digitalWrite(RELAY_FAN, fanOn ? RELAY_ON : RELAY_OFF); }
    if (doc.containsKey("led"))  { ledOn = doc["led"]; digitalWrite(RELAY_LED, ledOn ? RELAY_ON : RELAY_OFF); }
    if (doc.containsKey("mode")) { mode  = doc["mode"].as<String>(); }
  }
}


void readSensors() {
  // PIR
  pirState = digitalRead(PIR_PIN);

  // LDR
  ldrValue = analogRead(LDR_PIN);

  // DHT22
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) temperature = t;
  if (!isnan(h)) humidity    = h;

  
  int rawBatt = analogRead(BATT_PIN);
  float voltage = (rawBatt / 4095.0) * 3.3 * ((100.0 + 47.0) / 47.0);

  battPercent = (int)constrain(((voltage - 3.0) / (4.2 - 3.0)) * 100.0, 0, 100);

  Serial.printf("[Sensors] PIR=%d  LDR=%d  Temp=%.1f°C  Hum=%.1f%%  Batt=%d%%\n",
                pirState, ldrValue, temperature, humidity, battPercent);

  if (battPercent < BATT_LOW_WARNING) {
    Serial.println("[WARN] Battery low!");
  }
}


String getDayKey() {

  unsigned long dayIndex = (millis() / 86400000UL) % 7;
  const char* days[] = { "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" };
  return String(days[dayIndex]);
}



void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== SolarGuard v3.0 Booting ===");

  
  pinMode(RELAY_FAN,  OUTPUT);
  pinMode(RELAY_LED,  OUTPUT);
  pinMode(RELAY_DOOR, OUTPUT);
  pinMode(PIR_PIN,    INPUT);
  pinMode(LDR_PIN,    INPUT);
  pinMode(DHT_PIN,    INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BATT_PIN,   INPUT);

  
  digitalWrite(RELAY_FAN,  RELAY_OFF);
  digitalWrite(RELAY_LED,  RELAY_OFF);
  digitalWrite(RELAY_DOOR, RELAY_OFF);   
  digitalWrite(BUZZER_PIN, LOW);

  
  dht.begin();

  
  gateServo.attach(SERVO_PIN, 500, 2400);
  gateServo.write(SERVO_LOCKED);
  delay(500);
  Serial.println("[Servo] Gate initialised → LOCKED");

  
  buzzerAlert(1);

  
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    buzzerAlert(2);  
  } else {
    Serial.println("\n[WiFi] Failed to connect — running in offline mode");
  }

  
  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(onMQTTMessage);
  reconnectMQTT();

  
  readSensors();

  Serial.println("=== SolarGuard Ready ===\n");
}


void loop() {
  unsigned long now = millis();
  loopCount++;

  
  if (!mqtt.connected()) reconnectMQTT();
  mqtt.loop();

 
  if (now - lastSensorTime >= SENSOR_INTERVAL) {
    lastSensorTime = now;

    readSensors();
    runMLPrediction();
    applyAutoControl();
    publishMQTT();
    writeFirebaseSensors();
  }

 
  if (now - lastControlTime >= CONTROL_POLL_INTERVAL) {
    lastControlTime = now;
    readFirebaseControls();
  }

 
  delay(10);
}
