import time
import logging
from datetime import datetime, date, timedelta
from typing import List, Tuple, Dict, Optional, Any
from ortools.sat.python import cp_model
from models import Task, CalendarSlot, ScheduledBlock, SchedulePlan
from config import config

logger = logging.getLogger(__name__)

SLOT_MINUTES = 15

class Scheduler:
    def __init__(
        self,
        work_start_hour: Optional[int] = None,
        work_end_hour: Optional[int] = None,
        buffer_minutes: Optional[int] = None,
        active_days: Optional[List[int]] = None
    ):
        self.work_start_hour = work_start_hour if work_start_hour is not None else config.scheduler.work_start_hour
        self.work_end_hour = work_end_hour if work_end_hour is not None else config.scheduler.work_end_hour
        self.buffer_minutes = buffer_minutes if buffer_minutes is not None else config.scheduler.buffer_minutes
        self.active_days = active_days if active_days is not None else config.scheduler.active_days

    def solve(
        self,
        tasks: List[Task],
        fixed_events: List[CalendarSlot],
        start_time: Optional[datetime] = None,
        days_ahead: int = 2,
    ) -> SchedulePlan:
        """
        Solves optimal task scheduling using Google OR-Tools CP-SAT constraint solver.
        - Hard Constraints: fixed meetings can't move, work hours enforced, active days enforced.
        - Not Today / Deferred Tasks: tasks deferred until future date are excluded from today's schedule.
        - Soft Objectives: priority weighted, urgency decay, morning high-energy match.
        """
        t0 = time.time()
        
        # Reload latest config values if default initialized
        self.work_start_hour = config.scheduler.work_start_hour
        self.work_end_hour = config.scheduler.work_end_hour
        self.buffer_minutes = config.scheduler.buffer_minutes
        self.active_days = config.scheduler.active_days

        # Filter out deferred tasks for today
        now = start_time or datetime.now()
        if now.tzinfo is not None:
            now = now.replace(tzinfo=None)

        active_tasks: List[Task] = []
        deferred_ids: List[str] = []

        for t in tasks:
            if t.deferred_until and t.deferred_until >= now.date():
                logger.info(f"Task '{t.title}' deferred until {t.deferred_until}. Excluding from today's schedule.")
                deferred_ids.append(t.id)
            else:
                active_tasks.append(t)

        if not active_tasks:
            return SchedulePlan(
                blocks=[],
                unscheduled_task_ids=deferred_ids,
                solver_stats={"engine": "OR-Tools CP-SAT", "status": "ALL_DEFERRED", "time_sec": time.time() - t0}
            )

        minute_mod = now.minute % SLOT_MINUTES
        if minute_mod != 0:
            now = now + timedelta(minutes=(SLOT_MINUTES - minute_mod))
        now = now.replace(second=0, microsecond=0)

        plan_end = now + timedelta(days=days_ahead)

        # Normalize fixed_events datetimes to naive
        norm_events = []
        for ev in fixed_events:
            ev_start = ev.start.replace(tzinfo=None) if ev.start.tzinfo else ev.start
            ev_end = ev.end.replace(tzinfo=None) if ev.end.tzinfo else ev.end
            norm_events.append(CalendarSlot(start=ev_start, end=ev_end, is_fixed=ev.is_fixed, title=ev.title, event_uid=ev.event_uid))

        # 1. Build list of available 15-min slots matching active_days & work_start/end_hour
        slots: List[datetime] = []
        curr = now

        while curr < plan_end:
            # Enforce active days (e.g. 0=Mon, 6=Sun)
            if curr.weekday() in self.active_days:
                if self.work_start_hour <= curr.hour < self.work_end_hour:
                    slot_end = curr + timedelta(minutes=SLOT_MINUTES)
                    is_blocked = False
                    for ev in norm_events:
                        if not (slot_end <= ev.start or curr >= ev.end):
                            is_blocked = True
                            break
                    if not is_blocked:
                        slots.append(curr)
            curr += timedelta(minutes=SLOT_MINUTES)

        if not slots:
            logger.warning("No available time slots found for scheduling.")
            return SchedulePlan(
                blocks=[],
                unscheduled_task_ids=[t.id for t in active_tasks] + deferred_ids,
                solver_stats={"engine": "OR-Tools CP-SAT", "status": "NO_SLOTS_AVAILABLE", "time_sec": time.time() - t0}
            )

        # 2. Build CP-SAT Model
        model = cp_model.CpModel()
        num_slots = len(slots)

        task_vars = {}
        interval_vars = []

        for t in active_tasks:
            est_min = t.estimated_minutes or config.ai.default_duration_minutes
            num_req_slots = max(1, (est_min + SLOT_MINUTES - 1) // SLOT_MINUTES)
            buffer_slots = max(0, (self.buffer_minutes + SLOT_MINUTES - 1) // SLOT_MINUTES)
            total_duration_slots = num_req_slots + buffer_slots

            is_scheduled = model.NewBoolVar(f"sched_{t.id}")
            start_var = model.NewIntVar(0, max(0, num_slots - total_duration_slots), f"start_{t.id}")
            end_var = model.NewIntVar(0, num_slots, f"end_{t.id}")
            interval_var = model.NewOptionalIntervalVar(
                start_var, total_duration_slots, end_var, is_scheduled, f"interval_{t.id}"
            )

            t_due = t.due.replace(tzinfo=None) if (t.due and t.due.tzinfo) else t.due

            task_vars[t.id] = {
                "task": t,
                "due_naive": t_due,
                "is_scheduled": is_scheduled,
                "start": start_var,
                "end": end_var,
                "interval": interval_var,
                "num_req_slots": num_req_slots,
                "total_duration_slots": total_duration_slots,
            }
            interval_vars.append(interval_var)

        # HARD CONSTRAINT: No overlapping tasks
        model.AddNoOverlap(interval_vars)

        # HARD CONSTRAINT: Due dates
        for t_id, info in task_vars.items():
            t_due = info["due_naive"]
            if t_due and t_due > now:
                for idx, slot_dt in enumerate(slots):
                    slot_finish = slot_dt + timedelta(minutes=info["num_req_slots"] * SLOT_MINUTES)
                    if slot_finish > t_due:
                        model.Add(info["start"] < idx).OnlyEnforceIf(info["is_scheduled"])

        # SOFT OBJECTIVES: Priority × Urgency + Morning Energy Match
        objective_terms = []

        for t_id, info in task_vars.items():
            t = info["task"]
            t_due = info["due_naive"]
            is_sched = info["is_scheduled"]
            start_var = info["start"]

            hours_until_due = 100.0
            if t_due:
                delta = (t_due - now).total_seconds() / 3600.0
                hours_until_due = max(0.1, delta)
            
            if t_due and t_due <= now:
                urgency = 10.0
            else:
                urgency = 10.0 / (hours_until_due + 1.0)
                
            base_score = int(t.priority_score * 10 * urgency)

            objective_terms.append(base_score * is_sched)

            if t.energy == "high":
                for idx, slot_dt in enumerate(slots):
                    if config.scheduler.high_energy_start_hour <= slot_dt.hour < config.scheduler.high_energy_end_hour:
                        is_at_idx = model.NewBoolVar(f"at_{t_id}_{idx}")
                        model.Add(start_var == idx).OnlyEnforceIf([is_sched, is_at_idx])
                        model.Add(start_var != idx).OnlyEnforceIf(is_at_idx.Not())
                        objective_terms.append(50 * is_at_idx)

        model.Maximize(sum(objective_terms))

        # 4. Solve Model
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 5.0
        status = solver.Solve(model)
        solve_duration = round(time.time() - t0, 4)

        blocks: List[ScheduledBlock] = []
        unscheduled_ids: List[str] = list(deferred_ids)
        status_name = solver.StatusName(status)

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            for t_id, info in task_vars.items():
                if solver.Value(info["is_scheduled"]):
                    start_idx = solver.Value(info["start"])
                    start_dt = slots[start_idx]
                    end_dt = start_dt + timedelta(minutes=info["num_req_slots"] * SLOT_MINUTES)

                    t = info["task"]
                    blocks.append(
                        ScheduledBlock(
                            task_id=t.id,
                            task_title=t.title,
                            start=start_dt,
                            end=end_dt,
                            estimated_minutes=t.estimated_minutes or 30,
                            priority_score=t.priority_score,
                            energy=t.energy,
                            manager_directive=t.manager_directive,
                        )
                    )
                else:
                    unscheduled_ids.append(t_id)
        else:
            logger.warning("CP-SAT solver could not find feasible schedule.")
            unscheduled_ids.extend([t.id for t in active_tasks])

        blocks.sort(key=lambda x: x.start)

        stats = {
            "engine": "Google OR-Tools CP-SAT v9.15",
            "status": status_name,
            "solve_time_sec": solve_duration,
            "tasks_count": len(tasks),
            "scheduled_count": len(blocks),
            "deferred_count": len(deferred_ids),
            "active_days_configured": self.active_days,
            "work_hours": f"{self.work_start_hour}:00 - {self.work_end_hour}:00",
            "fixed_meetings_locked": len(fixed_events),
            "objective_value": int(solver.ObjectiveValue()) if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 0,
        }

        return SchedulePlan(blocks=blocks, unscheduled_task_ids=unscheduled_ids, solver_stats=stats)
