import os
import json
import logging
import sqlite3
from datetime import datetime, date
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    psycopg2 = None
    RealDictCursor = None

from monga_cal.models import TaskCompletionRecord, ScheduledBlock

logger = logging.getLogger(__name__)

class Database:
    def __init__(self, db_path_or_url: Optional[str] = None):
        if not db_path_or_url:
            db_path_or_url = os.getenv("DATABASE_URL")
            
        if not db_path_or_url:
            raise RuntimeError("DATABASE_URL environment variable is missing! Direct PostgreSQL connection to Pi is required.")

        self.connection_string = db_path_or_url
        self.is_postgres = self.connection_string.startswith(("postgresql://", "postgres://"))
        
        if self.is_postgres and not psycopg2:
            raise RuntimeError(
                "PostgreSQL connection string provided in DATABASE_URL, but 'psycopg2' is not installed."
            )

        self._init_db()

    def _get_connection(self):
        if self.is_postgres:
            return psycopg2.connect(self.connection_string, cursor_factory=RealDictCursor)
        else:
            conn = sqlite3.connect(self.connection_string, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            return conn

    def _format_sql(self, sql: str) -> str:
        """Converts ? parameter syntax to %s for PostgreSQL."""
        if self.is_postgres:
            return sql.replace("?", "%s")
        return sql

    def _init_db(self):
        conn = self._get_connection()
        cursor = conn.cursor()

        if self.is_postgres:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS task_history (
                    id SERIAL PRIMARY KEY,
                    task_id TEXT,
                    title TEXT NOT NULL,
                    estimated_minutes INTEGER NOT NULL,
                    actual_minutes INTEGER NOT NULL,
                    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_task_history_completed ON task_history(completed_at DESC);

                CREATE TABLE IF NOT EXISTS estimate_cache (
                    content_hash TEXT PRIMARY KEY,
                    estimated_minutes INTEGER,
                    priority_score INTEGER,
                    energy_level TEXT,
                    category TEXT DEFAULT 'General',
                    category_icon TEXT DEFAULT '📌',
                    color_preset TEXT DEFAULT 'neutral',
                    manager_directive TEXT,
                    reasoning TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS plan_history (
                    id SERIAL PRIMARY KEY,
                    plan_hash TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS task_deferrals (
                    task_id TEXT PRIMARY KEY,
                    deferred_until DATE NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS priority_overrides (
                    task_id TEXT PRIMARY KEY,
                    priority_score INTEGER NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            cursor.execute("ALTER TABLE estimate_cache ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General';")
            cursor.execute("ALTER TABLE estimate_cache ADD COLUMN IF NOT EXISTS category_icon TEXT DEFAULT '📌';")
            cursor.execute("ALTER TABLE estimate_cache ADD COLUMN IF NOT EXISTS color_preset TEXT DEFAULT 'neutral';")
            conn.commit()
        else:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS estimate_cache (
                    content_hash TEXT PRIMARY KEY,
                    estimated_minutes INTEGER,
                    priority_score INTEGER,
                    energy_level TEXT,
                    category TEXT DEFAULT 'General',
                    category_icon TEXT DEFAULT '📌',
                    color_preset TEXT DEFAULT 'neutral',
                    manager_directive TEXT,
                    reasoning TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            try:
                cursor.execute("ALTER TABLE estimate_cache ADD COLUMN category TEXT DEFAULT 'General'")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE estimate_cache ADD COLUMN category_icon TEXT DEFAULT '📌'")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE estimate_cache ADD COLUMN color_preset TEXT DEFAULT 'neutral'")
            except Exception:
                pass
            conn.commit()

        conn.close()
        logger.info(f"Database initialized successfully (Engine: {'PostgreSQL' if self.is_postgres else 'SQLite'})")

    def save_setting(self, key: str, value: Any):
        sql = """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = CURRENT_TIMESTAMP
        """ if self.is_postgres else """
            INSERT OR REPLACE INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        """
        self._execute(sql, (key, json.dumps(value)), commit=True)

    def get_setting(self, key: str) -> Optional[Any]:
        sql = "SELECT value_json FROM app_settings WHERE key = ?"
        row = self._execute(sql, (key,), fetchone=True)
        if row:
            try:
                r_dict = dict(row)
                return json.loads(r_dict["value_json"])
            except Exception as e:
                logger.error(f"Error parsing setting JSON for key '{key}': {e}")
        return None

    def save_priority_override(self, task_id: str, priority_score: int):
        sql = """
            INSERT INTO priority_overrides (task_id, priority_score, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (task_id) DO UPDATE SET priority_score = EXCLUDED.priority_score, updated_at = CURRENT_TIMESTAMP
        """ if self.is_postgres else """
            INSERT OR REPLACE INTO priority_overrides (task_id, priority_score, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        """
        self._execute(sql, (task_id, priority_score), commit=True)

    def get_priority_override(self, task_id: str) -> Optional[int]:
        sql = "SELECT priority_score FROM priority_overrides WHERE task_id = ?"
        row = self._execute(sql, (task_id,), fetchone=True)
        if row:
            return dict(row)["priority_score"]
        return None

    def defer_task(self, task_id: str, until_date: date):
        sql = """
            INSERT INTO task_deferrals (task_id, deferred_until, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (task_id) DO UPDATE SET deferred_until = EXCLUDED.deferred_until, updated_at = CURRENT_TIMESTAMP
        """ if self.is_postgres else """
            INSERT OR REPLACE INTO task_deferrals (task_id, deferred_until, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        """
        self._execute(sql, (task_id, until_date.isoformat()), commit=True)

    def get_deferred_until(self, task_id: str) -> Optional[date]:
        sql = "SELECT deferred_until FROM task_deferrals WHERE task_id = ?"
        row = self._execute(sql, (task_id,), fetchone=True)
        if row:
            r_dict = dict(row)
            if r_dict.get("deferred_until"):
                try:
                    val = r_dict["deferred_until"]
                    def_date = date.fromisoformat(str(val)) if isinstance(val, str) else val
                    if def_date < date.today():
                        self._execute("DELETE FROM task_deferrals WHERE task_id = ?", (task_id,), commit=True)
                        return None
                    return def_date
                except Exception:
                    pass
        return None

    def record_completion(self, record: TaskCompletionRecord):
        sql = """
            INSERT INTO task_history (task_id, title, estimated_minutes, actual_minutes, completed_at)
            VALUES (?, ?, ?, ?, ?)
        """
        self._execute(
            sql,
            (
                record.task_id,
                record.title,
                record.estimated_minutes,
                record.actual_minutes,
                record.completed_at.isoformat(),
            ),
            commit=True,
        )

    def is_task_completed(self, task_id: str) -> bool:
        sql = "SELECT id FROM task_history WHERE task_id = ?"
        row = self._execute(sql, (task_id,), fetchone=True)
        return row is not None

    def get_completed_count_today(self) -> int:
        """Returns the number of tasks completed today."""
        sql = "SELECT COUNT(*) as cnt FROM task_history WHERE completed_at::date = CURRENT_DATE" if self.is_postgres else "SELECT COUNT(*) as cnt FROM task_history WHERE DATE(completed_at) = DATE('now', 'localtime')"
        row = self._execute(sql, fetchone=True)
        if row:
            return dict(row)["cnt"]
        return 0

    def get_recent_completion_history(self, limit: int = 50) -> List[Dict[str, Any]]:
        sql = """
            SELECT id, task_id, title, estimated_minutes, actual_minutes, completed_at
            FROM task_history
            ORDER BY completed_at DESC
            LIMIT ?
        """
        rows = self._execute(sql, (limit,), fetchall=True)
        res = []
        for row in rows:
            r_dict = dict(row)
            dt_str = str(r_dict["completed_at"])
            res.append({
                "id": r_dict["id"],
                "task_id": r_dict["task_id"],
                "title": r_dict["title"],
                "estimated_minutes": r_dict["estimated_minutes"],
                "actual_minutes": r_dict["actual_minutes"],
                "completed_at": dt_str,
            })
        return res

    def update_completion_actual_minutes(self, record_id: int, actual_minutes: int):
        sql = "UPDATE task_history SET actual_minutes = ? WHERE id = ?"
        self._execute(sql, (actual_minutes, record_id), commit=True)

    def get_cached_estimate(self, content_hash: str) -> Optional[Dict[str, Any]]:
        sql = """
            SELECT estimated_minutes, priority_score, energy_level, category, category_icon, color_preset, manager_directive, reasoning
            FROM estimate_cache
            WHERE content_hash = ?
        """
        row = self._execute(sql, (content_hash,), fetchone=True)
        if row:
            r_dict = dict(row)
            return {
                "estimated_minutes": r_dict["estimated_minutes"],
                "priority_score": r_dict["priority_score"],
                "energy_level": r_dict["energy_level"],
                "category": r_dict.get("category", "General") or "General",
                "category_icon": r_dict.get("category_icon", "📌") or "📌",
                "color_preset": r_dict.get("color_preset", "neutral") or "neutral",
                "manager_directive": r_dict["manager_directive"],
                "reasoning": r_dict.get("reasoning", ""),
            }
        return None

    def save_cached_estimate(self, content_hash: str, estimate: Dict[str, Any]):
        sql = """
            INSERT INTO estimate_cache
            (content_hash, estimated_minutes, priority_score, energy_level, category, category_icon, color_preset, manager_directive, reasoning)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (content_hash) DO UPDATE SET
                estimated_minutes = EXCLUDED.estimated_minutes,
                priority_score = EXCLUDED.priority_score,
                energy_level = EXCLUDED.energy_level,
                category = EXCLUDED.category,
                category_icon = EXCLUDED.category_icon,
                color_preset = EXCLUDED.color_preset,
                manager_directive = EXCLUDED.manager_directive,
                reasoning = EXCLUDED.reasoning
        """ if self.is_postgres else """
            INSERT OR REPLACE INTO estimate_cache
            (content_hash, estimated_minutes, priority_score, energy_level, category, category_icon, color_preset, manager_directive, reasoning)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        self._execute(
            sql,
            (
                content_hash,
                estimate["estimated_minutes"],
                estimate["priority_score"],
                estimate["energy_level"],
                estimate.get("category", "General"),
                estimate.get("category_icon", "📌"),
                estimate.get("color_preset", "neutral"),
                estimate.get("manager_directive", "Standard priority work block."),
                estimate.get("reasoning", ""),
            ),
            commit=True,
        )

    def get_latest_plan(self) -> Optional[List[Dict[str, Any]]]:
        sql = "SELECT plan_json FROM plan_history ORDER BY id DESC LIMIT 1"
        row = self._execute(sql, fetchone=True)
        if row:
            r_dict = dict(row)
            if r_dict.get("plan_json"):
                try:
                    return json.loads(r_dict["plan_json"])
                except Exception:
                    pass
        return None

    def get_latest_plan_hash(self) -> Optional[str]:
        sql = "SELECT plan_hash FROM plan_history ORDER BY id DESC LIMIT 1"
        row = self._execute(sql, fetchone=True)
        if row:
            return dict(row)["plan_hash"]
        return None

    def save_plan(self, plan_hash: str, blocks: List[ScheduledBlock]):
        plan_data = [b.model_dump(mode="json") for b in blocks]
        sql = """
            INSERT INTO plan_history (plan_hash, plan_json)
            VALUES (?, ?)
        """
        self._execute(sql, (plan_hash, json.dumps(plan_data)), commit=True)

    def _execute(
        self,
        sql: str,
        params: tuple = (),
        fetchone: bool = False,
        fetchall: bool = False,
        commit: bool = False,
    ):
        conn = self._get_connection()
        try:
            cursor = conn.cursor()
            formatted_sql = self._format_sql(sql)
            cursor.execute(formatted_sql, params)

            if commit:
                conn.commit()

            result = None
            if fetchone:
                result = cursor.fetchone()
            elif fetchall:
                result = cursor.fetchall()

            return result
        except Exception as e:
            logger.error(f"Database query error: {e} | SQL: {sql}")
            raise e
        finally:
            conn.close()
