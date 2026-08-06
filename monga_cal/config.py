import os
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any
import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()

logger = logging.getLogger(__name__)

class GoogleConfig(BaseModel):
    tasks_list_name: str = "Monga Cal"
    calendar_id: str = "primary"
    timezone: str = "America/Los_Angeles"

class ICloudConfig(BaseModel):
    caldav_url: str = "https://caldav.icloud.com/"
    username: str = Field(default_factory=lambda: os.getenv("ICLOUD_USERNAME", ""))
    password: str = Field(default_factory=lambda: os.getenv("ICLOUD_PASSWORD", ""))
    calendar_name: str = "Personal"
    reminders_list_name: str = "Reminders"

class SchedulerConfig(BaseModel):
    active_days: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    work_start_hour: int = 10
    work_end_hour: int = 17
    buffer_minutes: int = 10
    max_tasks_per_day: int = 3
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
    db_path: str = Field(default_factory=lambda: os.getenv("DB_PATH", "monga_cal.db"))
    database_url: str = Field(default_factory=lambda: os.getenv("DATABASE_URL", os.getenv("DB_PATH", "monga_cal.db")))

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

    try:
        from monga_cal.db import Database
        db_conn_str = daemon_data.get("database_url") or daemon_data.get("db_path") or os.getenv("DATABASE_URL", "monga_cal.db")
        db = Database(db_conn_str)
        saved_settings = db.get_setting("scheduler_settings")
        if saved_settings and isinstance(saved_settings, dict):
            scheduler_data.update(saved_settings)
    except Exception as e:
        logger.warning(f"Could not load settings override from DB: {e}")

    start_h = scheduler_data.get("work_start_hour", 10)
    end_h = scheduler_data.get("work_end_hour", 17)
    if end_h <= start_h and end_h <= 12:
        end_h += 12
    scheduler_data["work_end_hour"] = end_h

    return AppConfig(
        google=GoogleConfig(**google_data),
        icloud=ICloudConfig(**icloud_data),
        scheduler=SchedulerConfig(**scheduler_data),
        ai=AIConfig(**ai_data),
        daemon=DaemonConfig(**daemon_data),
    )

def save_config(app_config: AppConfig, config_file: str = "config.yaml"):
    config_dict = app_config.model_dump()
    if "ai" in config_dict:
        config_dict["ai"].pop("api_key", None)
    if "icloud" in config_dict:
        config_dict["icloud"].pop("password", None)
        
    try:
        with open(config_file, "w", encoding="utf-8") as f:
            yaml.safe_dump(config_dict, f, default_flow_style=False)
    except Exception as e:
        logger.error(f"Error saving config.yaml: {e}")

config = load_config()
