import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
from monga_cal.models import Task, CalendarSlot, ScheduledBlock, SchedulePlan, SyncStatus
from monga_cal.db import Database
from monga_cal.ai_estimator import AIEstimator
from monga_cal.gservices import gservices_manager
from monga_cal.scheduler import Scheduler
from monga_cal.config import config

logger = logging.getLogger(__name__)

class DaemonService:
    def __init__(self):
        self.db = Database(config.daemon.database_url)
        self.ai = AIEstimator(self.db)
        self.gservices = gservices_manager
        self.scheduler = Scheduler()
        self.status = SyncStatus()
        self._running = False
        self._last_task_set_hash: Optional[str] = None

    def start(self):
        self._running = True

    def _compute_task_set_hash(self, tasks: List[Task]) -> str:
        data = [f"{t.id}:{t.title}:{t.priority_score}:{t.deferred_until}" for t in tasks]
        return hashlib.sha256(";".join(sorted(data)).encode("utf-8")).hexdigest()

    def compute_plan_hash(self, blocks: List[ScheduledBlock]) -> str:
        data = [
            f"{b.task_id}|{b.start.isoformat()}|{b.end.isoformat()}|{b.priority_score}"
            for b in blocks
        ]
        return hashlib.sha256(";".join(data).encode("utf-8")).hexdigest()

    async def run_sync_cycle(self, force_calendar_sync: bool = False) -> SchedulePlan:
        self.status.status = "syncing"
        self.status.last_poll_time = datetime.now()

        try:
            # 1. Sync completed tasks from Google Tasks to DB task_history
            completed_imported = self.gservices.sync_completed_tasks_from_google(self.db)

            raw_tasks = self.gservices.fetch_tasks()
            now = datetime.now()
            start_dt = datetime.combine(now.date(), datetime.min.time())
            end_dt = start_dt + timedelta(days=14)

            fixed_events = self.gservices.fetch_fixed_events(start_dt, end_dt)
            
            tasks: List[Task] = []
            for t in raw_tasks:
                def_date = self.db.get_deferred_until(t.id)
                t.deferred_until = def_date
                tasks.append(t)

            self.status.tasks_count = len(tasks)

            # Check if task set changed or tasks were completed externally
            current_task_hash = self._compute_task_set_hash(tasks)
            task_set_changed = (current_task_hash != self._last_task_set_hash)
            existing_plan_raw = self.db.get_latest_plan()

            # STABLE SCHEDULING: If no human input, no task set change, no completed import, and a valid plan exists for today: KEEP EXISTING PLAN!
            if not force_calendar_sync and not task_set_changed and completed_imported == 0 and existing_plan_raw:
                logger.info("No human input or task changes detected. Keeping existing stable schedule intact without auto-shifting.")
                self.status.status = "idle"
                self.status.last_error = None
                existing_blocks = [ScheduledBlock(**b) for b in existing_plan_raw]
                self.status.scheduled_blocks_count = len(existing_blocks)
                return SchedulePlan(blocks=existing_blocks, unscheduled_task_ids=[])

            # Re-solve ONLY when human action or task set change occurs
            self._last_task_set_hash = current_task_hash
            estimated_tasks = self.ai.estimate_tasks_batch(tasks)

            # Stable start reference: work start hour today
            work_start_today = datetime.combine(now.date(), datetime.min.time()).replace(hour=config.scheduler.work_start_hour)
            solve_start = max(now, work_start_today) if now > work_start_today else work_start_today
            completed_today = self.db.get_completed_count_today()

            self.status.status = "solving"
            plan = self.scheduler.solve(
                estimated_tasks,
                fixed_events,
                start_time=solve_start,
                locked_blocks=existing_plan_raw,
                completed_today_count=completed_today
            )
            self.status.scheduled_blocks_count = len(plan.blocks)

            new_hash = self.compute_plan_hash(plan.blocks)
            logger.info(f"Human action / trigger: Syncing {len(plan.blocks)} schedule blocks to Google Calendar (force={force_calendar_sync})...")
            synced = self.gservices.sync_scheduled_blocks(plan.blocks)
            if synced:
                self.db.save_plan(new_hash, plan.blocks)
                self.status.last_reschedule_time = datetime.now()

            self.status.status = "idle"
            self.status.last_error = None
            return plan

        except Exception as e:
            logger.error(f"Error during daemon sync cycle: {e}")
            self.status.status = "error"
            self.status.last_error = str(e)
            return SchedulePlan(blocks=[], unscheduled_task_ids=[])

    async def loop(self):
        self.start()
        logger.info(f"Daemon background loop started (interval: {config.daemon.poll_interval_seconds}s)")
        while self._running:
            await self.run_sync_cycle(force_calendar_sync=False)
            await asyncio.sleep(config.daemon.poll_interval_seconds)

daemon_service = DaemonService()
