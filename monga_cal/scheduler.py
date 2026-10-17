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
        self.max_tasks_per_day = max_tasks_per_day if max_tasks_per_day is not None else getattr(config.scheduler, "max_tasks_per_day", 3)

    def solve(
        self,
        tasks: List[Task],
        fixed_events: List[CalendarSlot],
        start_time: Optional[datetime] = None,
        days_ahead: int = 14,
        locked_blocks: Optional[List[Dict[str, Any]]] = None,
        completed_today_count: int = 0,
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

        explicit_due_today_ids = {
            t.id
            for t in active_tasks
            if t.due and (t.due.replace(tzinfo=None) if t.due.tzinfo else t.due).date() == now.date()
        }
        is_offday_today_active = (now.weekday() not in self.active_days) and len(explicit_due_today_ids) > 0

        slots: List[datetime] = []
        curr = now

        while curr < plan_end:
            is_active_day = (curr.weekday() in self.active_days) or (is_offday_today_active and curr.date() == now.date())
            if is_active_day:
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

            # Contiguity check: start_var must be at an index where the required duration is completely contiguous in real time
            valid_start_indices = [
                i for i in range(num_slots - total_duration_slots + 1)
                if slots[i + total_duration_slots - 1] == slots[i] + timedelta(minutes=(total_duration_slots - 1) * SLOT_MINUTES)
                and not (is_offday_today_active and t.id not in explicit_due_today_ids and slots[i].date() == now.date())
            ]

            if not valid_start_indices:
                model.Add(is_scheduled == 0)
                start_var = model.NewIntVar(0, num_slots, f"start_{t.id}")
            else:
                start_var = model.NewIntVarFromDomain(cp_model.Domain.FromValues(valid_start_indices), f"start_{t.id}")

            end_var = model.NewIntVar(0, num_slots, f"end_{t.id}")
            interval_var = model.NewOptionalIntervalVar(
                start_var, total_duration_slots, end_var, is_scheduled, f"interval_{t.id}"
            )

            # Calculate or derive deadline based on creation time & priority score
            t_created = (t.created_at.replace(tzinfo=None) if (t.created_at and t.created_at.tzinfo) else t.created_at) or now
            has_explicit_due = t.due is not None
            t_due = t.due.replace(tzinfo=None) if (t.due and t.due.tzinfo) else t.due

            if not t_due:
                # Set default deadline based on initial priority (1-5 scale)
                prio_val = max(1, min(5, t.priority_score))
                deadline_days_map = {1: 1, 2: 3, 3: 5, 4: 7, 5: 14}
                t_due = t_created + timedelta(days=deadline_days_map.get(prio_val, 5))

            task_vars[t.id] = {
                "task": t,
                "due_naive": t_due,
                "has_explicit_due": has_explicit_due,
                "is_scheduled": is_scheduled,
                "start": start_var,
                "end": end_var,
                "interval": interval_var,
                "num_req_slots": num_req_slots,
                "total_duration_slots": total_duration_slots,
                "valid_start_indices": valid_start_indices,
            }
            interval_vars.append(interval_var)

        # HARD CONSTRAINT: No overlapping tasks
        model.AddNoOverlap(interval_vars)

        # LOCK WINDOW ENFORCEMENT (lock_window_minutes): Freeze blocks starting in < lock_window_minutes
        lock_threshold = now + timedelta(minutes=config.scheduler.lock_window_minutes)
        allowed_today = max(0, self.max_tasks_per_day - completed_today_count) if self.max_tasks_per_day > 0 else len(active_tasks)
        locked_today_count = 0
        locked_intervals: List[Tuple[int, int]] = []

        if locked_blocks:
            for lb in locked_blocks:
                l_id = lb.get("task_id")
                try:
                    raw_start = lb["start"]
                    l_start = datetime.fromisoformat(raw_start) if isinstance(raw_start, str) else raw_start
                    if l_start.tzinfo:
                        l_start = l_start.replace(tzinfo=None)
                    if now <= l_start < lock_threshold and l_id in task_vars:
                        matching_indices = [i for i, s_dt in enumerate(slots) if s_dt >= l_start]
                        if matching_indices:
                            closest_slot_idx = matching_indices[0]
                            slot_dt = slots[closest_slot_idx]
                            drift_minutes = abs((slot_dt - l_start).total_seconds()) / 60.0
                            dur_slots = task_vars[l_id]["total_duration_slots"]
                            cand_start, cand_end = closest_slot_idx, closest_slot_idx + dur_slots

                            # Ensure the locked slot hasn't drifted past anti-thrash, doesn't exceed today's remaining capacity,
                            # and doesn't overlap another locked block
                            is_today_slot = (slot_dt.date() == now.date())
                            if is_today_slot and locked_today_count >= allowed_today:
                                logger.info(f"Lock Window: Skipping lock for '{l_id}' because today's capacity ({allowed_today} remaining) is full.")
                                continue
                            if drift_minutes > config.scheduler.anti_thrash_threshold_minutes:
                                logger.info(f"Lock Window: Skipping lock for '{l_id}' because slot drifted by {drift_minutes:.1f}m.")
                                continue
                            if any(not (cand_end <= s or cand_start >= e) for s, e in locked_intervals):
                                logger.info(f"Lock Window: Skipping lock for '{l_id}' due to overlap with another locked block.")
                                continue

                            if closest_slot_idx in task_vars[l_id]["valid_start_indices"]:
                                model.Add(task_vars[l_id]["is_scheduled"] == 1)
                                model.Add(task_vars[l_id]["start"] == closest_slot_idx)
                                locked_intervals.append((cand_start, cand_end))
                                if is_today_slot:
                                    locked_today_count += 1
                                logger.info(f"Lock Window: Freezing imminent task '{l_id}' at slot {closest_slot_idx} ({slot_dt})")
                except Exception as ex:
                    logger.warning(f"Error locking block '{l_id}': {ex}")

        # OPTIMIZED PER-DAY MAX TASKS CONSTRAINT (Strictly enforced max_tasks_per_day - completed_today_count)
        if self.max_tasks_per_day > 0:
            slots_by_day = defaultdict(list)
            for idx, slot_dt in enumerate(slots):
                slots_by_day[slot_dt.date()].append(idx)

            today_date = now.date()

            for day_date, day_slot_indices in slots_by_day.items():
                min_idx = min(day_slot_indices)
                max_idx = max(day_slot_indices)
                day_starts = []
                for t_id, info in task_vars.items():
                    is_on_day = model.NewBoolVar(f"on_day_{t_id}_{day_date}")
                    c1 = model.NewBoolVar(f"c1_{t_id}_{day_date}")
                    c2 = model.NewBoolVar(f"c2_{t_id}_{day_date}")

                    model.Add(info["start"] >= min_idx).OnlyEnforceIf(c1)
                    model.Add(info["start"] < min_idx).OnlyEnforceIf(c1.Not())
                    model.Add(info["start"] <= max_idx).OnlyEnforceIf(c2)
                    model.Add(info["start"] > max_idx).OnlyEnforceIf(c2.Not())

                    model.AddBoolAnd([info["is_scheduled"], c1, c2]).OnlyEnforceIf(is_on_day)
                    model.AddBoolOr([info["is_scheduled"].Not(), c1.Not(), c2.Not()]).OnlyEnforceIf(is_on_day.Not())
                    if is_offday_today_active and day_date == today_date and t_id not in explicit_due_today_ids:
                        model.Add(is_on_day == 0)
                    day_starts.append(is_on_day)

                if day_date == today_date:
                    model.Add(sum(day_starts) <= allowed_today)
                    logger.info(f"Today's Capacity: max={self.max_tasks_per_day}, completed={completed_today_count}, remaining_allowed={allowed_today}")
                else:
                    model.Add(sum(day_starts) <= self.max_tasks_per_day)

        # Precompute high-energy slot indices across all days (only true daily high-energy hours)
        high_slot_indices = [
            i for i, s_dt in enumerate(slots)
            if config.scheduler.high_energy_start_hour <= s_dt.hour < config.scheduler.high_energy_end_hour
        ]
        high_slot_domain = cp_model.Domain.FromValues(high_slot_indices) if high_slot_indices else None
        non_high_slot_indices = [i for i in range(num_slots + 1) if i not in set(high_slot_indices)]
        non_high_slot_domain = cp_model.Domain.FromValues(non_high_slot_indices) if non_high_slot_indices else None

        # SOFT OBJECTIVES
        objective_terms = []

        for t_id, info in task_vars.items():
            t = info["task"]
            t_due = info["due_naive"]
            is_sched = info["is_scheduled"]
            start_var = info["start"]

            # Priority 1-5 scale (1 is highest/ASAP, 5 is lowest/Tracking)
            raw_prio = max(1, min(5, t.priority_score))

            # Dynamic Priority Escalation as Deadline Draws Closer (using end-of-day for date deadlines):
            days_until_due = 10.0
            due_eod = None
            if t_due:
                due_eod = datetime.combine(t_due.date(), datetime.max.time().replace(microsecond=0))
                days_until_due = (due_eod - now).total_seconds() / 86400.0

            # Escalation logic:
            if t_due and t_due.date() <= now.date():
                effective_prio_val = 1  # Escalates to P1 ASAP when overdue or due today
            elif days_until_due <= 3.0:
                effective_prio_val = max(1, raw_prio - 2)  # Escalates by 2 levels
            elif days_until_due <= 5.0:
                effective_prio_val = max(1, raw_prio - 1)  # Escalates by 1 level
            else:
                effective_prio_val = raw_prio

            # Convert 1-5 priority to 1-5 weight (P1 -> weight 5, P5 -> weight 1)
            eff_prio_weight = max(1, min(5, 6 - effective_prio_val))

            if t_due and t_due.date() < now.date():
                urgency_factor = 12.0  # Explicitly overdue
            elif t_due and t_due.date() == now.date():
                urgency_factor = 10.0  # Due today
            else:
                urgency_factor = 10.0 / (max(0.1, days_until_due) + 1.0)

            base_score = int(eff_prio_weight * 1000 * urgency_factor)
            objective_terms.append(base_score * is_sched)

            slot_weight = max(10, int(eff_prio_weight * urgency_factor * 4))
            earlier_score = model.NewIntVar(-500000, 500000, f"earlier_{t_id}")
            model.Add(earlier_score == (num_slots - start_var) * slot_weight).OnlyEnforceIf(is_sched)
            model.Add(earlier_score == 0).OnlyEnforceIf(is_sched.Not())
            objective_terms.append(earlier_score)

            # EXPLICIT DEADLINE ENFORCEMENT: Penalize scheduling past an explicit user-set due date
            if info["has_explicit_due"] and t_due and due_eod:
                if t_due.date() < now.date():
                    today_eod = datetime.combine(now.date(), datetime.max.time().replace(microsecond=0))
                    overdue_delay_indices = [i for i, s_dt in enumerate(slots) if s_dt > today_eod]
                    if overdue_delay_indices:
                        first_delay_idx = min(overdue_delay_indices)
                        past_today = model.NewBoolVar(f"past_today_{t_id}")
                        is_delayed_further = model.NewBoolVar(f"overdue_delay_{t_id}")
                        model.Add(start_var >= first_delay_idx).OnlyEnforceIf(past_today)
                        model.Add(start_var < first_delay_idx).OnlyEnforceIf(past_today.Not())
                        model.AddBoolAnd([is_sched, past_today]).OnlyEnforceIf(is_delayed_further)
                        model.AddBoolOr([is_sched.Not(), past_today.Not()]).OnlyEnforceIf(is_delayed_further.Not())
                        objective_terms.append(-8000 * is_delayed_further)
                else:
                    late_slot_indices = [i for i, s_dt in enumerate(slots) if s_dt > due_eod]
                    if late_slot_indices:
                        first_late_idx = min(late_slot_indices)
                        past_due = model.NewBoolVar(f"past_due_{t_id}")
                        is_late = model.NewBoolVar(f"late_{t_id}")
                        model.Add(start_var >= first_late_idx).OnlyEnforceIf(past_due)
                        model.Add(start_var < first_late_idx).OnlyEnforceIf(past_due.Not())
                        model.AddBoolAnd([is_sched, past_due]).OnlyEnforceIf(is_late)
                        model.AddBoolOr([is_sched.Not(), past_due.Not()]).OnlyEnforceIf(is_late.Not())
                        objective_terms.append(-5000 * is_late)

            # HIGH-ENERGY WINDOW BOOST (Exact per-day high-energy domain constraint!)
            if t.energy == "high" and high_slot_domain is not None:
                in_high_win = model.NewBoolVar(f"high_win_{t_id}")
                in_high_slot = model.NewBoolVar(f"in_high_slot_{t_id}")
                model.AddLinearExpressionInDomain(start_var, high_slot_domain).OnlyEnforceIf(in_high_slot)
                if non_high_slot_domain is not None:
                    model.AddLinearExpressionInDomain(start_var, non_high_slot_domain).OnlyEnforceIf(in_high_slot.Not())
                else:
                    model.Add(in_high_slot == 1)

                model.AddBoolAnd([is_sched, in_high_slot]).OnlyEnforceIf(in_high_win)
                model.AddBoolOr([is_sched.Not(), in_high_slot.Not()]).OnlyEnforceIf(in_high_win.Not())
                objective_terms.append(2500 * in_high_win)

        model.Maximize(sum(objective_terms))

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 5.0
        status = solver.Solve(model)
        if status == cp_model.INFEASIBLE and locked_blocks:
            logger.warning("CP-SAT returned INFEASIBLE with locked_blocks; retrying without lock constraints.")
            return self.solve(
                tasks=tasks,
                fixed_events=fixed_events,
                start_time=start_time,
                days_ahead=days_ahead,
                locked_blocks=None,
                completed_today_count=completed_today_count,
            )
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
                            category=getattr(t, "category", "General"),
                            category_icon=getattr(t, "category_icon", "📌"),
                            color_preset=getattr(t, "color_preset", "neutral"),
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
            "completed_today_count": completed_today_count,
            "deferred_count": len(deferred_ids),
            "active_days_configured": self.active_days,
            "work_hours": f"{self.work_start_hour}:00 - {self.work_end_hour}:00",
            "fixed_meetings_locked": len(fixed_events),
            "objective_value": int(solver.ObjectiveValue()) if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 0,
        }

        return SchedulePlan(blocks=blocks, fixed_events=fixed_events, unscheduled_task_ids=unscheduled_ids, solver_stats=stats)

