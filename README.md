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

## Fridge Tablet Setup (onn 12.1" / Fully Kiosk)

1. Open **Fully Kiosk Browser** on your Android tablet.
2. Set Start URL to `http://<raspberry-pi-ip>:8000`.
3. Enable "Keep Screen On" and Auto-Refresh (optional).
