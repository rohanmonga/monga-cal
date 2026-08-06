import time
import logging
from collections import defaultdict
from datetime import datetime, date, timedelta
from typing import List, Tuple, Dict, Optional, Any
from ortools.sat.python import cp_model
from monga_cal.models import Task, CalendarSlot, ScheduledBlock, SchedulePlan
from monga_cal.config import config

logger = logging.getLogger(__name__)

SLOT_MINUTES = 15

class Scheduler:
    def __init__(
        self,
        work_start_hour: Optional[int] = None,
        work_end_hour: Optional[int] = None,
        buffer_minutes: Optional[int] = None,
        active_days: Optional[List[int]] = None,
        max_tasks_per_day: Optional[int] = None,
    ):
        self.work_start_hour = work_start_hour if work_start_hour is not None else config.scheduler.work_start_hour
        self.work_end_hour = work_end_hour if work_end_hour is not None else config.scheduler.work_end_hour
        self.buffer_minutes = buffer_minutes if buffer_minutes is not None else config.scheduler.buffer_minutes
        self.active_days = active_days if active_days is not None else config.scheduler.active_days
        self.max_tasks_per_day = max_tasks_per_day if max_tasks_per_day is not None else getattr(config.scheduler, "max_tasks_per_day", 5)

    def solve(
        self,
        tasks: List[Task],
        fixed_events: List[CalendarSlot],
        start_time: Optional[datetime] = None,
        days_ahead: int = 2,
    ) -> SchedulePlan:
        t0 = time.time()

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

        # Buffer-expanded fixed events
        buf_delta = timedelta(minutes=self.buffer_minutes)
        norm_events = []
        for ev in fixed_events:
            ev_start = (ev.start.replace(tzinfo=None) if ev.start.tzinfo else ev.start) - buf_delta
            ev_end = (ev.end.replace(tzinfo=None) if ev.end.tzinfo else ev.end) + buf_delta
            norm_events.append(CalendarSlot(start=ev_start, end=ev_end, is_fixed=ev.is_fixed, title=ev.title, event_uid=ev.event_uid))

        slots: List[datetime] = []
        curr = now

        while curr < plan_end:
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

        # BUG-2 FIX: HARD CONSTRAINT — max_tasks_per_day enforced per individual calendar day
        if self.max_tasks_per_day > 0:
            slots_by_day = defaultdict(list)
            for idx, slot_dt in enumerate(slots):
                slots_by_day[slot_dt.date()].append(idx)

            for day_date, day_slot_indices in slots_by_day.items():
                min_idx = min(day_slot_indices)
                max_idx = max(day_slot_indices)
                
                day_starts = []
                for t_id, info in task_vars.items():
                    is_on_day = model.NewBoolVar(f"on_day_{t_id}_{day_date}")
                    
                    # Create slot index indicator booleans for exact day matching
                    slot_indicators = []
                    for s_idx in day_slot_indices:
                        is_at_s = model.NewBoolVar(f"start_at_{t_id}_{s_idx}")
                        model.Add(info["start"] == s_idx).OnlyEnforceIf([info["is_scheduled"], is_at_s])
                        model.Add(info["start"] != s_idx).OnlyEnforceIf(is_at_s.Not())
                        slot_indicators.append(is_at_s)
                    
                    model.Add(sum(slot_indicators) == 1).OnlyEnforceIf(is_on_day)
                    model.Add(sum(slot_indicators) == 0).OnlyEnforceIf(is_on_day.Not())
                    day_starts.append(is_on_day)

                model.Add(sum(day_starts) <= self.max_tasks_per_day)

        # BUG-3 FIX: Precompute exact max start index for due dates
        for t_id, info in task_vars.items():
            t_due = info["due_naive"]
            if t_due and t_due > now:
                max_start_idx = -1
                for idx, slot_dt in enumerate(slots):
                    slot_finish = slot_dt + timedelta(minutes=info["num_req_slots"] * SLOT_MINUTES)
                    if slot_finish <= t_due:
                        max_start_idx = idx
                if max_start_idx >= 0:
                    model.Add(info["start"] <= max_start_idx).OnlyEnforceIf(info["is_scheduled"])
                else:
                    model.Add(info["is_scheduled"] == 0)

        # SOFT OBJECTIVES
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

            urgency = 10.0 if (t_due and t_due <= now) else 10.0 / (hours_until_due + 1.0)
            eff_prio = max(1, min(10, 11 - t.priority_score))

            base_score = int(eff_prio * 1000 * urgency)
            objective_terms.append(base_score * is_sched)

            earlier_score = model.NewIntVar(-100000, 100000, f"earlier_{t_id}")
            model.Add(earlier_score == (num_slots - start_var) * eff_prio * 20).OnlyEnforceIf(is_sched)
            model.Add(earlier_score == 0).OnlyEnforceIf(is_sched.Not())
            objective_terms.append(earlier_score)

        model.Maximize(sum(objective_terms))

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
            logger.warning(f"CP-SAT solver status: {status_name}.")
            unscheduled_ids.extend([t.id for t in active_tasks])

        blocks.sort(key=lambda x: x.start)

        stats = {
            "engine": "Google OR-Tools CP-SAT v9.15",
            "status": status_name,
            "solve_time_sec": solve_duration,
            "tasks_count": len(tasks),
            "scheduled_count": len(blocks),
            "max_tasks_per_day": self.max_tasks_per_day,
            "deferred_count": len(deferred_ids),
            "active_days_configured": self.active_days,
            "work_hours": f"{self.work_start_hour}:00 - {self.work_end_hour}:00",
            "fixed_meetings_locked": len(fixed_events),
            "objective_value": int(solver.ObjectiveValue()) if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 0,
        }

        return SchedulePlan(blocks=blocks, unscheduled_task_ids=unscheduled_ids, solver_stats=stats)
