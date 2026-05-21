<div align="center">

# ☀️🛡️ SolarGuard

### AI-Powered Solar Smart Home Security & Energy Management

*Harnessing the power of the sun and intelligence of AI to protect and optimize your smart home.*

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Raspberry Pi](https://img.shields.io/badge/Raspberry_Pi-A22846?style=for-the-badge&logo=raspberrypi&logoColor=white)
![Machine Learning](https://img.shields.io/badge/Machine_Learning-FF6F00?style=for-the-badge&logo=tensorflow&logoColor=white)
![IoT](https://img.shields.io/badge/IoT-4285F4?style=for-the-badge&logo=internetofthings&logoColor=white)
![ESP32](https://img.shields.io/badge/ESP32-E7352C?style=for-the-badge&logo=espressif&logoColor=white)

![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

</div>

---

## 📑 Table of Contents

- [About the Project](#-about-the-project)
- [Key Features](#-key-features)
- [Technologies Used](#-technologies-used)
- [How It Works](#-how-it-works)
- [Hardware Requirements](#-hardware-requirements)
- [Installation & Setup](#-installation--setup)
- [Future Improvements](#-future-improvements)
- [Author](#-author)
- [License](#-license)

---

## 📖 About the Project

**SolarGuard** is an intelligent home security and energy management system that combines **solar energy harvesting**, **AI-driven security monitoring**, and **smart home automation** into one platform. Built using **ESP32**, **Raspberry Pi**, and **Machine Learning** models, it provides real-time monitoring, automated threat detection, and energy optimization — all powered by clean solar energy.

---

## ✨ Key Features

- ☀️ **Solar Energy Monitoring** — Real-time solar panel output & battery tracking
- 🛡️ **AI-Based Security Alerts** — ML anomaly detection & intelligent notifications
- 🏠 **Smart Home Automation** — Automated appliance control via sensor data & ML
- 📊 **Real-Time Data Dashboard** — Live sensor readings, energy stats & security status
- 🔋 **Energy Optimization** — AI-driven recommendations for maximum efficiency
- 📱 **Remote Access** — Monitor and control from anywhere via web interface

---

## 🛠️ Technologies Used

| Category | Technology |
|:---:|:---:|
| 🧠 ML | ![Python](https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white) ![scikit-learn](https://img.shields.io/badge/scikit--learn-F7931E?style=flat-square&logo=scikit-learn&logoColor=white) ![TensorFlow](https://img.shields.io/badge/TensorFlow-FF6F00?style=flat-square&logo=tensorflow&logoColor=white) |
| 🔌 Hardware | ![Raspberry Pi](https://img.shields.io/badge/Raspberry_Pi-A22846?style=flat-square&logo=raspberrypi&logoColor=white) ![ESP32](https://img.shields.io/badge/ESP32-E7352C?style=flat-square&logo=espressif&logoColor=white) |
| 🌐 Web | ![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white) ![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black) ![Firebase](https://img.shields.io/badge/Firebase-FFCA28?style=flat-square&logo=firebase&logoColor=black) |
| 📡 Comms | ![MQTT](https://img.shields.io/badge/MQTT-660066?style=flat-square&logo=mqtt&logoColor=white) ![WiFi](https://img.shields.io/badge/WiFi-4285F4?style=flat-square&logo=wifi&logoColor=white) |

---

## ⚙️ How It Works

```
  Solar Panel ──▶ ESP32 Sensors ──▶ Raspberry Pi (ML Hub) ──▶ Web Dashboard
  Motion Sensors ──▶ ESP32 Controller ──────────┘
```

1. **🔋 Collect** — ESP32 sensors gather solar, temperature, motion & environmental data
2. **📡 Transmit** — Data sent via MQTT/WiFi to the Raspberry Pi hub
3. **🧠 Analyze** — ML models detect patterns and anomalies
4. **⚡ Act** — Automated security alerts, energy optimization, device control
5. **📊 Visualize** — Real-time interactive web dashboard

---

## 🔧 Hardware Requirements

| Component | Purpose |
|:---|:---|
| 🍓 Raspberry Pi 4 | Central processing & ML hub |
| 📡 ESP32 Dev Board (x2+) | Sensor collection & control |
| ☀️ Solar Panel (5W–10W) | Energy harvesting |
| 🔋 Li-ion Battery + Controller | Energy storage |
| 🌡️ DHT22 Sensor | Temperature & humidity |
| 📸 PIR Motion Sensor | Security motion detection |
| 💡 LDR Sensor | Light intensity |
| 🔌 Relay Module | Appliance control |

---

## 🚀 Installation & Setup

```bash
# 1. Clone the repository
git clone https://github.com/kidwaiabdulhadi/SolarGuard.git
cd SolarGuard

# 2. Install dependencies
pip install -r requirements.txt

# 3. Flash ESP32 firmware via Arduino IDE
# Update WiFi credentials and MQTT broker address

# 4. Configure Raspberry Pi hub
python setup.py --configure

# 5. Launch the dashboard
python app.py
# Access at http://<raspberry-pi-ip>:5000
```

---

## 🔮 Future Improvements

- [ ] 🎥 Camera module for AI video surveillance
- [ ] 📱 Mobile app (Flutter/React Native)
- [ ] ☁️ Cloud integration for remote analytics
- [ ] 🗣️ Voice assistant (Alexa/Google Home)
- [ ] 🌤️ Weather API for predictive energy management
- [ ] ⚡ Grid-tie for surplus energy export

---

## 👨‍💻 Author

<div align="center">

**Abdul Hadi Kidwai**
🎓 B.Eng Computer Systems Engineering — Middlesex University Dubai

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/abdul-hadi-kidwai-51231032a)
[![Email](https://img.shields.io/badge/Email-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:a.hadikidwai@gmail.com)

</div>

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

⭐ **Star this repo if you found it useful!** ⭐

*Built with ❤️ and ☀️ by Abdul Hadi Kidwai*

</div>
