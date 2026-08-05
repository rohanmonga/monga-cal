import os
from pathlib import Path
from typing import Optional, List
import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field

# Load .env if present
load_dotenv()

class GoogleConfig(BaseModel):
    tasks_list_name: str = "Monga Cal"
    calendar_id: str = "primary"

class ICloudConfig(BaseModel):
    caldav_url: str = "https://caldav.icloud.com/"
    username: str = Field(default_factory=lambda: os.getenv("ICLOUD_USERNAME", ""))
    password: str = Field(default_factory=lambda: os.getenv("ICLOUD_PASSWORD", ""))
    calendar_name: str = "Personal"
    reminders_list_name: str = "Reminders"

class SchedulerConfig(BaseModel):
    active_days: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4, 5, 6]) # 0=Mon, 6=Sun
    work_start_hour: int = 8
    work_end_hour: int = 21
    buffer_minutes: int = 10
    min_block_minutes: int = 15
    high_energy_start_hour: int = 9
    high_energy_end_hour: int = 12
    anti_thrash_threshold_minutes: int = 15
    lock_window_minutes: int = 30

class AIConfig(BaseModel):
    api_key: str = Field(default_factory=lambda: os.getenv("GEMINI_API_KEY", ""))
    model_name: str = "gemini-2.0-flash"
    default_duration_minutes: int = 30
    default_priority: int = 5
    history_limit: int = 20

class DaemonConfig(BaseModel):
    poll_interval_seconds: int = 180
    db_path: str = "monga_cal.db"

class AppConfig(BaseModel):
    google: GoogleConfig = Field(default_factory=GoogleConfig)
    icloud: ICloudConfig = Field(default_factory=ICloudConfig)
    scheduler: SchedulerConfig = Field(default_factory=SchedulerConfig)
    ai: AIConfig = Field(default_factory=AIConfig)
    daemon: DaemonConfig = Field(default_factory=DaemonConfig)

def load_config(config_file: str = "config.yaml") -> AppConfig:
    config_data = {}
    config_path = Path(config_file)
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            config_data = yaml.safe_load(f) or {}

    google_data = config_data.get("google", {})
    icloud_data = config_data.get("icloud", {})
    scheduler_data = config_data.get("scheduler", {})
    ai_data = config_data.get("ai", {})
    daemon_data = config_data.get("daemon", {})

    return AppConfig(
        google=GoogleConfig(**google_data),
        icloud=ICloudConfig(**icloud_data),
        scheduler=SchedulerConfig(**scheduler_data),
        ai=AIConfig(**ai_data),
        daemon=DaemonConfig(**daemon_data),
    )

def save_config(app_config: AppConfig, config_file: str = "config.yaml"):
    config_dict = app_config.model_dump()
    with open(config_file, "w", encoding="utf-8") as f:
        yaml.safe_dump(config_dict, f, default_flow_style=False)

config = load_config()
