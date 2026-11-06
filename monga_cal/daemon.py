import asyncio
import hashlib
import json
import logging
from datetime import datetime, date, timedelta
from typing import List, Optional, Dict, Any, Set
from monga_cal.models import Task, CalendarSlot, ScheduledBlock, SchedulePlan, SyncStatus
from monga_cal.db import Database
from monga_cal.ai_estimator import AIEstimator
from monga_cal.gservices import gservices_manager
from monga_cal.scheduler import Scheduler
from monga_cal.config import config

logger = logging.getLogger(__name__)

def prepare_scheduled_tasks(
    raw_tasks: List[Task],
    kanban_projects: List[Dict[str, Any]],
    subtask_google_ids: Set[str],
    active_deferrals: Dict[str, date],
    priority_overrides: Dict[str, int],
    now: datetime
) -> List[Task]:
    """
    Filters out micro-subtasks from Google Tasks, and injects top-level macro projects
    from Kanban, ensuring zero calendar clutter and keeping calendar in sync with Kanban.
    """
    tasks: List[Task] = []
    project_titles_lower = {p["title"].strip().lower() for p in kanban_projects}

    # 1. Filter raw Google Tasks: exclude all micro-subtasks and project headers
    for t in raw_tasks:
        t_clean = t.title.strip()
        is_subtask = (
            t.id in subtask_google_ids or
            t_clean.startswith("- [ ]") or
            t_clean.startswith("- [x]") or
            t_clean.startswith("##") or
            t_clean.startswith("* ")
        )
        if is_subtask:
            # Micro-subtask is tracked inside Kanban, NOT scheduled on calendar
            continue

        # If a Google Task matches a macro project title, macro project block represents it
        if t_clean.lower() in project_titles_lower:
            continue

        t.deferred_until = active_deferrals.get(t.id)
        if t.id in priority_overrides:
            t.priority_score = max(1, min(5, priority_overrides[t.id]))
        tasks.append(t)

    # 2. Inject Top-Level Macro Projects from Kanban Board
    weekday = now.weekday() # 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun
    for p in kanban_projects:
        proj_id = p["id"]
        title = p["title"]
        icon = p.get("icon") or "📁"
        cadence = p.get("schedule_cadence") or "Day 1, 3, 5"
        today_count = p.get("today_tasks") or 0
        active_count = p.get("active_tasks") or 0

        # Cadence matching: Day 1, 3, 5 = Mon, Wed, Fri; Day 2, 4 = Tue, Thu; Daily = all days
        cad_lower = cadence.lower()
        if "daily" in cad_lower:
            is_cadence_day = True
        elif "1, 3, 5" in cad_lower:
            is_cadence_day = (weekday in (0, 2, 4))
        elif "2, 4" in cad_lower:
            is_cadence_day = (weekday in (1, 3))
        elif "weekly" in cad_lower:
            is_cadence_day = (weekday == 0)
        else:
            is_cadence_day = True

        # Determine priority:
        # P1 if user has tasks in Kanban 'today' lane!
        # P2 if today is cadence day
        # P3 if active tasks exist
        if today_count > 0:
            prio = 1
        elif is_cadence_day:
            prio = 2
        elif active_count > 0:
            prio = 3
        else:
            prio = 4

        task_id = p.get("google_task_id") or f"kanban_proj_{proj_id}"
        est_mins = 45 if today_count <= 2 else 60

        macro_task = Task(
            id=task_id,
            title=f"{icon} {title}",
            notes=f"Macro project focus window. Execute underlying subtasks in Kanban ({today_count} for today, {active_count} active).",
            list_name="Projects",
            estimated_minutes=est_mins,
            priority_score=prio,
            energy="high" if any(k in title.lower() for k in ["ssn", "tax", "finance"]) else "medium",
            category=p.get("category", "Project"),
            category_icon=icon,
            color_preset=p.get("color_preset", "cyan"),
            manager_directive=f"Macro Focus Block: {title}. {active_count} micro-tasks managed in Kanban."
        )

        macro_task.deferred_until = active_deferrals.get(task_id)
        if task_id in priority_overrides:
            macro_task.priority_score = max(1, min(5, priority_overrides[task_id]))

        tasks.append(macro_task)

    return tasks

class DaemonService:
    def __init__(self):
        self.db = Database(config.daemon.database_url or config.daemon.db_path)
        self.ai = AIEstimator(self.db)
        self.gservices = gservices_manager
        self.scheduler = Scheduler()
        self.status = SyncStatus()
        self._running = False
        self._last_task_set_hash: Optional[str] = None
        self._sync_lock = asyncio.Lock()

    def start(self):
        self._running = True

    def _compute_task_set_hash(
        self,
        tasks: List[Task],
        fixed_events: Optional[List[CalendarSlot]] = None,
        priority_overrides: Optional[Dict[str, int]] = None,
        completed_today: int = 0,
    ) -> str:
        overrides = priority_overrides or {}
        data = [
            f"task:{t.id}:{t.title}:{t.notes or ''}:{overrides.get(t.id, t.priority_score)}:{t.deferred_until}:{t.due.isoformat() if t.due else ''}"
            for t in tasks
        ]
        if fixed_events:
            for ev in fixed_events:
                data.append(f"ev:{ev.event_uid or ev.title}:{ev.start.isoformat()}:{ev.end.isoformat()}")
        data.append(f"completed_today:{completed_today}")
        return hashlib.sha256(";".join(sorted(data)).encode("utf-8")).hexdigest()

    def compute_plan_hash(self, blocks: List[ScheduledBlock]) -> str:
        data = [
            f"{b.task_id}|{b.start.isoformat()}|{b.end.isoformat()}|{b.priority_score}"
            for b in blocks
        ]
        return hashlib.sha256(";".join(data).encode("utf-8")).hexdigest()

    async def run_sync_cycle(self, force_calendar_sync: bool = False) -> SchedulePlan:
        async with self._sync_lock:
            self.status.status = "syncing"
            self.status.last_poll_time = datetime.now()

            try:
                # 1. Sync completed tasks from Google Tasks to DB task_history
                completed_imported = await asyncio.to_thread(
                    self.gservices.sync_completed_tasks_from_google, self.db
                )

                raw_tasks = await asyncio.to_thread(self.gservices.fetch_tasks)
                now = datetime.now()
                start_dt = datetime.combine(now.date(), datetime.min.time())
                end_dt = start_dt + timedelta(days=14)

                fixed_events = await asyncio.to_thread(self.gservices.fetch_fixed_events, start_dt, end_dt)
                active_deferrals = await asyncio.to_thread(self.db.get_all_active_deferrals)
                priority_overrides = await asyncio.to_thread(self.db.get_all_priority_overrides)
                completed_today = await asyncio.to_thread(self.db.get_completed_count_today)

                kanban_projects = await asyncio.to_thread(self.db.get_kanban_projects)
                subtask_google_ids = await asyncio.to_thread(self.db.get_kanban_subtask_google_ids)

                tasks = prepare_scheduled_tasks(
                    raw_tasks, kanban_projects, subtask_google_ids, active_deferrals, priority_overrides, now
                )
                self.status.tasks_count = len(tasks)

                # Check if task set, notes, overrides, or fixed events changed
                current_task_hash = self._compute_task_set_hash(
                    tasks,
                    fixed_events=fixed_events,
                    priority_overrides=priority_overrides,
                    completed_today=completed_today,
                )
                task_set_changed = (current_task_hash != self._last_task_set_hash)
                existing_plan_raw = await asyncio.to_thread(self.db.get_latest_plan)

                # STABLE SCHEDULING: If no human input, no task/calendar change, no completed import, and a valid plan exists: KEEP EXISTING PLAN!
                if not force_calendar_sync and not task_set_changed and completed_imported == 0 and existing_plan_raw:
                    logger.info("No human input or task/calendar changes detected. Keeping existing stable schedule intact.")
                    await asyncio.to_thread(self.ai.estimate_tasks_batch, tasks)
                    self.status.status = "idle"
                    self.status.last_error = None
                    existing_blocks = [ScheduledBlock(**b) for b in existing_plan_raw]
                    scheduled_ids = {b.task_id for b in existing_blocks}
                    unscheduled_ids = [t.id for t in tasks if t.id not in scheduled_ids]
                    self.status.scheduled_blocks_count = len(existing_blocks)
                    return SchedulePlan(
                        blocks=existing_blocks,
                        fixed_events=fixed_events,
                        unscheduled_task_ids=unscheduled_ids,
                        solver_stats={
                            "status": "CACHED_STABLE",
                            "tasks_count": len(tasks),
                            "scheduled_count": len(existing_blocks),
                            "max_tasks_per_day": self.scheduler.max_tasks_per_day,
                            "completed_today_count": completed_today,
                        },
                    )

                # Re-solve when human action or task/calendar change occurs
                self._last_task_set_hash = current_task_hash
                estimated_tasks = await asyncio.to_thread(self.ai.estimate_tasks_batch, tasks)

                # Stable start reference: work start hour today
                work_start_today = datetime.combine(now.date(), datetime.min.time()).replace(hour=config.scheduler.work_start_hour)
                solve_start = max(now, work_start_today) if now > work_start_today else work_start_today

                self.status.status = "solving"
                plan = await asyncio.to_thread(
                    self.scheduler.solve,
                    estimated_tasks,
                    fixed_events,
                    solve_start,
                    14,
                    existing_plan_raw,
                    completed_today,
                )
                self.status.scheduled_blocks_count = len(plan.blocks)

                new_hash = self.compute_plan_hash(plan.blocks)
                await asyncio.to_thread(self.db.save_plan, new_hash, plan.blocks)
                self.status.last_reschedule_time = datetime.now()

                logger.info(f"Syncing {len(plan.blocks)} schedule blocks to Google Calendar (force={force_calendar_sync})...")
                synced = await asyncio.to_thread(self.gservices.sync_scheduled_blocks, plan.blocks)
                if not synced:
                    logger.warning("Google Calendar sync skipped or unauthenticated (local schedule plan saved successfully).")

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
