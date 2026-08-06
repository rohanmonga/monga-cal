import sqlite3
import hashlib
import json
from datetime import datetime, date
from typing import List, Optional, Dict, Any
from models import TaskCompletionRecord, ScheduledBlock

class Database:
    def __init__(self, db_path: str = "monga_cal.db"):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS task_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT,
                    title TEXT NOT NULL,
                    estimated_minutes INTEGER NOT NULL,
                    actual_minutes INTEGER NOT NULL,
                    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS estimate_cache (
                    content_hash TEXT PRIMARY KEY,
                    estimated_minutes INTEGER,
                    priority_score INTEGER,
                    energy_level TEXT,
                    reasoning TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS plan_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    plan_hash TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS task_deferrals (
                    task_id TEXT PRIMARY KEY,
                    deferred_until DATE NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS priority_overrides (
                    task_id TEXT PRIMARY KEY,
                    priority_score INTEGER NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

    def save_setting(self, key: str, value: Any):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO app_settings (key, value_json, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                """,
                (key, json.dumps(value)),
            )
            conn.commit()

    def get_setting(self, key: str) -> Optional[Any]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT value_json FROM app_settings WHERE key = ?",
                (key,),
            )
            row = cursor.fetchone()
            if row:
                try:
                    return json.loads(row["value_json"])
                except Exception:
                    pass
            return None

    def save_priority_override(self, task_id: str, priority_score: int):
        """Save priority override for a task in SQLite DB."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO priority_overrides (task_id, priority_score, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                """,
                (task_id, priority_score),
            )
            conn.commit()

    def get_priority_override(self, task_id: str) -> Optional[int]:
        """Fetch priority override for a task from SQLite DB."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT priority_score FROM priority_overrides WHERE task_id = ?",
                (task_id,),
            )
            row = cursor.fetchone()
            return row["priority_score"] if row else None

    def defer_task(self, task_id: str, until_date: date):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO task_deferrals (task_id, deferred_until, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                """,
                (task_id, until_date.isoformat()),
            )
            conn.commit()

    def get_deferred_until(self, task_id: str) -> Optional[date]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT deferred_until FROM task_deferrals WHERE task_id = ?",
                (task_id,),
            )
            row = cursor.fetchone()
            if row and row["deferred_until"]:
                try:
                    return date.fromisoformat(row["deferred_until"])
                except Exception:
                    pass
            return None

    def record_completion(self, record: TaskCompletionRecord):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO task_history (task_id, title, estimated_minutes, actual_minutes, completed_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    record.task_id,
                    record.title,
                    record.estimated_minutes,
                    record.actual_minutes,
                    record.completed_at.isoformat(),
                ),
            )
            conn.commit()

    def get_recent_completion_history(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT title, estimated_minutes, actual_minutes
                FROM task_history
                ORDER BY completed_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cursor.fetchall()
            return [
                {
                    "title": row["title"],
                    "estimated_minutes": row["estimated_minutes"],
                    "actual_minutes": row["actual_minutes"],
                }
                for row in rows
            ]

    def get_cached_estimate(self, content_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT estimated_minutes, priority_score, energy_level, reasoning
                FROM estimate_cache
                WHERE content_hash = ?
                """,
                (content_hash,),
            )
            row = cursor.fetchone()
            if row:
                return {
                    "estimated_minutes": row["estimated_minutes"],
                    "priority_score": row["priority_score"],
                    "energy_level": row["energy_level"],
                    "reasoning": row["reasoning"],
                }
            return None

    def save_cached_estimate(self, content_hash: str, estimate: Dict[str, Any]):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO estimate_cache
                (content_hash, estimated_minutes, priority_score, energy_level, reasoning)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    content_hash,
                    estimate["estimated_minutes"],
                    estimate["priority_score"],
                    estimate["energy_level"],
                    estimate.get("reasoning", ""),
                ),
            )
            conn.commit()

    def get_latest_plan_hash(self) -> Optional[str]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT plan_hash FROM plan_history ORDER BY id DESC LIMIT 1"
            )
            row = cursor.fetchone()
            return row["plan_hash"] if row else None

    def save_plan(self, plan_hash: str, blocks: List[ScheduledBlock]):
        plan_data = [b.model_dump(mode="json") for b in blocks]
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO plan_history (plan_hash, plan_json)
                VALUES (?, ?)
                """,
                (plan_hash, json.dumps(plan_data)),
            )
            conn.commit()
