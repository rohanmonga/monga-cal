# Monga Cal — Smart Todo & AI Scheduler Bridge

> A lightweight daemon and fridge dashboard for Apple Reminders & Apple Calendar, powered by **Google Gemini API** (`gemini-2.5-flash`) and **Google OR-Tools CP-SAT**. Designed to run 24/7 on a **Raspberry Pi** and display on an Android fridge tablet (e.g., onn 12.1").

---

## Features

- **Apple Reminders + Calendar Integration**: Connects via standard CalDAV (`caldav` Python library). No Mac daemon or third-party paid subscriptions required.
- **AI Task Duration & Priority Estimation**: Uses **Google Gemini API** (`google-genai` SDK) to estimate task duration, assign priority scores (1–10), and evaluate energy requirements (`high`, `medium`, `low`).
- **Learning Loop**: Records actual task completion durations in SQLite to continuously refine Gemini's estimations over time.
- **Constraint Optimization (OR-Tools CP-SAT)**: Solves for optimal, non-overlapping task slots while respecting active work hours, due dates, fixed meetings, and peak productivity energy windows.
- **Fridge Dashboard**: Beautiful, glassmorphism dark-mode UI with live clock, real-time schedule timeline, task completion triggers, and manual "Reshuffle Now" control.
- **CalDAV Isolation & Anti-Thrashing**: Adds flexible task blocks prefixed with `BLOCK:` and tagged with `X-MONGA-TASK-UID`. Throttles calendar rewrites if changes are under 15 minutes.

---

## Requirements

- Python 3.10+
- Apple iCloud account with an **App-Specific Password** (generated at [appleid.apple.com](https://appleid.apple.com))
- Google Gemini API Key (free tier available at [aistudio.google.com](https://aistudio.google.com))

---

## Quick Setup

### 1. Configuration & Secrets

Clone the repository and set up environment variables:

```bash
cp .env.example .env
```

Edit `.env`:
```env
ICLOUD_USERNAME=your_email@icloud.com
ICLOUD_PASSWORD=xxxx-xxxx-xxxx-xxxx
GEMINI_API_KEY=AIzaSy...
```

Customize `config.yaml` for work hours and polling interval if desired.

### 2. Local Execution

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run server & daemon
python main.py
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

---

## Raspberry Pi Deployment

### Option A: Docker Compose (Recommended)

```bash
docker-compose up -d --build
```

### Option B: Native Systemd Service

1. Copy repository to `/home/pi/monga-cal`.
2. Create Python virtual environment and install requirements:
   ```bash
   python3 -m venv venv
   ./venv/bin/pip install -r requirements.txt
   ```
3. Copy systemd service file:
   ```bash
   sudo cp monga-cal.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable monga-cal
   sudo systemctl start monga-cal
   ```

---

## Fridge Tablet & Kiosk Setup (onn 12.1" Android Tablet)

Monga Cal runs natively as the primary wall dashboard on an Android tablet using the **Home Assistant Companion App** (or Chrome browser):

1. **Native Screen Wake Lock**:
   - Monga Cal utilizes the standard **HTML5 Screen Wake Lock API** (`navigator.wakeLock.request('screen')`) to prevent the display from sleeping during normal operation.
   - Automatically re-acquires the wake lock on touch events and `visibilitychange`.
2. **Remote Sleep / Wake Control**:
   - `/api/tablet/screen/sleep`: Releases the screen wake lock and puts the dashboard into sleep mode.
   - `/api/tablet/screen/wake`: Re-acquires the wake lock and brings the dashboard alive.
   - `/api/tablet/screen/toggle`: Toggles between sleep and awake.
   - `/api/tablet/screen/status`: Returns `{"sleeping": bool}`.

---

## Smart Charger & Battery Life Safety (Matter Architecture)

To maximize battery health and prevent swelling on 24/7 wall-mounted tablets, charging is controlled via a TP-Link KP125M smart plug commissioned over **Matter**:

- **Matter-over-Wi-Fi**: Operated via the standalone `matter-server` container (`ghcr.io/home-assistant-libs/python-matter-server:stable`) on the Raspberry Pi host network.
- **Immune to IP Drift**: Matter devices communicate via IPv6 Multicast and persistent Node IDs, eliminating DHCP lease disconnects.
- **Battery Cycle Automations (`scripts/automations.yaml`)**:
  - **Start Charging**: Automatically turns on at **40%** battery (`switch.temple_dashboard_charger`).
  - **Stop Charging**: Automatically cuts power at **80%** battery.
  - **Thermal Safety Cutoff**: Disables charging if battery exceeds **35°C**; dims display if temp exceeds **43°C**.
  - **Safety Watchdogs**: Failsafe cutoff at **85%** and a 4-hour max continuous charge timer.

