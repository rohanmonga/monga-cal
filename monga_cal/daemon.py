import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta
from typing import List, Optional
from monga_cal.models import Task, CalendarSlot, ScheduledBlock, SchedulePlan, SyncStatus
from monga_cal.db import Database
from monga_cal.ai_estimator import AIEstimator
from monga_cal.gservices import GServicesClient
from monga_cal.scheduler import Scheduler
from monga_cal.config import config

logger = logging.getLogger(__name__)

class DaemonService:
    def __init__(self):
        self.db = Database(config.daemon.db_path)
        self.ai = AIEstimator(self.db)
        self.gservices = GServicesClient()
        self.scheduler = Scheduler()
        self.status = SyncStatus()
        self._running = False

    def start(self):
        self._running = True
        self.gservices.connect()

    def compute_plan_hash(self, blocks: List[ScheduledBlock]) -> str:
        data = [
            f"{b.task_id}|{b.start.isoformat()}|{b.end.isoformat()}"
            for b in blocks
        ]
        return hashlib.sha256(";".join(data).encode("utf-8")).hexdigest()

    async def run_sync_cycle(self, force_calendar_sync: bool = False) -> SchedulePlan:
        self.status.status = "syncing"
        self.status.last_poll_time = datetime.now()

        try:
            raw_tasks = self.gservices.fetch_tasks()
            now = datetime.now()
            start_dt = datetime.combine(now.date(), datetime.min.time())
            end_dt = start_dt + timedelta(days=2)

            fixed_events = self.gservices.fetch_fixed_events(start_dt, end_dt)
            
            tasks: List[Task] = []
            for t in raw_tasks:
                def_date = self.db.get_deferred_until(t.id)
                t.deferred_until = def_date
                tasks.append(t)

            self.status.tasks_count = len(tasks)

            estimated_tasks: List[Task] = []
            for t in tasks:
                est_task = self.ai.estimate_task(t)
                estimated_tasks.append(est_task)

            self.status.status = "solving"
            plan = self.scheduler.solve(estimated_tasks, fixed_events, start_time=now)
            self.status.scheduled_blocks_count = len(plan.blocks)

            new_hash = self.compute_plan_hash(plan.blocks)
            last_hash = self.db.get_latest_plan_hash()

            if force_calendar_sync or (new_hash != last_hash):
                logger.info(f"Syncing {len(plan.blocks)} schedule blocks to Google Calendar (force={force_calendar_sync})...")
                synced = self.gservices.sync_scheduled_blocks(plan.blocks, start_dt, end_dt)
                if synced:
                    self.db.save_plan(new_hash, plan.blocks)
                    self.status.last_reschedule_time = datetime.now()
            else:
                logger.info("Schedule unchanged. Skipping Google Calendar update.")

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
            await self.run_sync_cycle()
            await asyncio.sleep(config.daemon.poll_interval_seconds)

daemon_service = DaemonService()
