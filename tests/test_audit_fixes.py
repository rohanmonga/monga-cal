from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import os
import tempfile
import unittest

from monga_cal.models import Task, CalendarSlot
from monga_cal.scheduler import Scheduler
from monga_cal.db import Database
from monga_cal.ai_estimator import _sanitize_icon, ALLOWED_PRESETS


class TestAuditFixes(unittest.TestCase):
    def test_high_energy_window_enforced_per_day_not_spanning_afternoon(self):
        """
        Finding 1.1: High-energy tasks must only start during high-energy hours (e.g., 9:00-12:00),
        never in afternoon hours (e.g., 14:00) on Day 1 when multi-day horizon is used.
        """
        tz = ZoneInfo("America/Los_Angeles")
        now = datetime(2026, 10, 19, 9, 0, tzinfo=tz)

        scheduler = Scheduler(
            work_start_hour=9,
            work_end_hour=17,
            buffer_minutes=10,
            active_days=[0, 1, 2, 3, 4],
            max_tasks_per_day=3,
        )

        # Block 9:00 AM - 12:00 PM on Day 1 with a fixed meeting so Day 1 morning is unavailable
        fixed = [
            CalendarSlot(
                start=datetime(2026, 10, 19, 9, 0, tzinfo=tz),
                end=datetime(2026, 10, 19, 12, 0, tzinfo=tz),
                title="Morning Offsite",
            )
        ]
        tasks = [
            Task(
                id="t_high",
                title="Deep Architecture Design",
                estimated_minutes=60,
                priority_score=1,
                energy="high",
            )
        ]

        result = scheduler.solve(tasks, fixed, start_time=now)
        self.assertEqual(len(result.blocks), 1)
        scheduled_start = result.blocks[0].start
        self.assertTrue(
            9 <= scheduled_start.hour < 12,
            f"Expected morning hour 9..11, got {scheduled_start}",
        )

    def test_locked_blocks_exceeding_remaining_daily_capacity_do_not_crash_solver(self):
        """
        Finding 1.2: If completed_today_count reduces today's remaining capacity below the number
        of locked blocks, the solver must not fail with INFEASIBLE (0 tasks scheduled).
        """
        tz = ZoneInfo("America/Los_Angeles")
        now = datetime(2026, 10, 19, 10, 0, tzinfo=tz)

        scheduler = Scheduler(
            work_start_hour=9,
            work_end_hour=17,
            buffer_minutes=10,
            active_days=[0, 1, 2, 3, 4],
            max_tasks_per_day=3,
        )

        tasks = [
            Task(id="t1", title="Task 1", estimated_minutes=30, priority_score=1),
            Task(id="t2", title="Task 2", estimated_minutes=30, priority_score=2),
        ]

        locked_blocks = [
            {
                "task_id": "t1",
                "task_title": "Task 1",
                "start": (now + timedelta(minutes=30)).isoformat(),
                "end": (now + timedelta(minutes=60)).isoformat(),
            },
            {
                "task_id": "t2",
                "task_title": "Task 2",
                "start": (now + timedelta(minutes=90)).isoformat(),
                "end": (now + timedelta(minutes=120)).isoformat(),
            },
        ]

        result = scheduler.solve(
            tasks=tasks,
            fixed_events=[],
            start_time=now,
            locked_blocks=locked_blocks,
            completed_today_count=2,
        )

        self.assertEqual(len(result.blocks), 2, "Both tasks should still be scheduled across the horizon")
        today_blocks = [b for b in result.blocks if b.start.date() == now.date()]
        self.assertLessEqual(len(today_blocks), 1, "At most 1 task can remain on today when 2 are already completed")

    def test_overdue_vs_due_today_deadline_urgency(self):
        """
        Finding 1.6: Overdue tasks (due < today) and due-today tasks (due == today)
        should receive distinct urgency weights and schedule earlier than non-due tasks.
        """
        tz = ZoneInfo("America/Los_Angeles")
        now = datetime(2026, 10, 19, 10, 0, tzinfo=tz)

        scheduler = Scheduler(
            work_start_hour=10,
            work_end_hour=17,
            buffer_minutes=10,
            active_days=[0, 1, 2, 3, 4],
            max_tasks_per_day=1,
        )

        tasks = [
            Task(
                id="t_future",
                title="Due Next Week",
                estimated_minutes=30,
                priority_score=2,
                due=now + timedelta(days=5),
            ),
            Task(
                id="t_today",
                title="Due Today",
                estimated_minutes=30,
                priority_score=2,
                due=datetime(2026, 10, 19, 0, 0, tzinfo=tz),
            ),
            Task(
                id="t_overdue",
                title="Overdue Yesterday",
                estimated_minutes=30,
                priority_score=2,
                due=datetime(2026, 10, 18, 0, 0, tzinfo=tz),
            ),
        ]

        result = scheduler.solve(tasks, [], start_time=now)
        by_id = {b.task_id: b.start for b in result.blocks}
        self.assertLess(by_id["t_overdue"], by_id["t_today"])
        self.assertLess(by_id["t_today"], by_id["t_future"])

    def test_sqlite_wal_and_kids_stars_summary(self):
        """
        Finding 2.2 & 3.3: Verify SQLite WAL mode, plan pruning, and kids star summary.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test_monga.db")
            db = Database(db_path_or_url=db_path)

            with db._get_connection() as conn:
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode;")
                mode = cur.fetchone()[0]
                self.assertEqual(mode.lower(), "wal")

            summary = db.add_kid_star("Vivaan", delta=2, chore_description="Cleaned playroom")
            vivaan = next(k for k in summary["kids"] if k["kid_name"] == "Vivaan")
            self.assertEqual(vivaan["total_stars"], 2)
            self.assertEqual(vivaan["today_stars"], 2)
            self.assertEqual(len(summary["recent_history"]), 1)

            rec_id = summary["recent_history"][0]["id"]
            summary_after = db.delete_kid_star(rec_id)
            vivaan_after = next(k for k in summary_after["kids"] if k["kid_name"] == "Vivaan")
            self.assertEqual(vivaan_after["total_stars"], 0)

    def test_ai_estimator_sanitization(self):
        """
        Finding 4.2: Verify AI estimator icon and preset sanitization against XSS payloads.
        """
        evil_icon = "<img src=x onerror=alert(1)>"
        sanitized = _sanitize_icon(evil_icon)
        self.assertNotIn("<", sanitized)
        self.assertNotIn(">", sanitized)
        self.assertEqual(sanitized, "📌")
        self.assertIn("emerald", ALLOWED_PRESETS)
        self.assertNotIn("neutral\" onclick=\"alert(1)", ALLOWED_PRESETS)

    def test_task_completion_request_model_and_oauth_xss_escaping(self):
        """
        Finding 1.7 & 4.1:
        1. TaskCompletionRequest must accept {"task_id": "...", "actual_minutes": 25} without requiring title/estimated_minutes.
        2. /api/auth/callback must HTML-escape the error parameter.
        """
        import asyncio
        from monga_cal.main import TaskCompletionRequest, oauth_callback

        req = TaskCompletionRequest(task_id="task_123", actual_minutes=25)
        self.assertEqual(req.task_id, "task_123")
        self.assertEqual(req.actual_minutes, 25)
        self.assertIsNone(req.title)
        self.assertIsNone(req.estimated_minutes)

        xss_payload = "<script>alert(1)</script>"
        resp = asyncio.run(oauth_callback(error=xss_payload))
        body = resp.body.decode("utf-8")
        self.assertEqual(resp.status_code, 400)
        self.assertNotIn("<script>alert(1)</script>", body)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", body)

    def test_off_day_pull_to_today_schedules_only_explicit_due_today_tasks(self):
        """
        V19 UX Upgrade: On an off-day (e.g., Saturday when active_days=[0,1,2,3,4]),
        tasks explicitly marked due == today ('Pull to Today') are scheduled into Today's
        window, while regular tasks stay on Monday.
        """
        tz = ZoneInfo("America/Los_Angeles")
        # Saturday Oct 17, 2026 at 10:00 AM
        saturday_now = datetime(2026, 10, 17, 10, 0, tzinfo=tz)

        scheduler = Scheduler(
            work_start_hour=10,
            work_end_hour=17,
            buffer_minutes=10,
            active_days=[0, 1, 2, 3, 4],  # Mon-Fri only
            max_tasks_per_day=3,
        )

        tasks = [
            Task(
                id="t_pulled",
                title="Pulled Weekend Task",
                estimated_minutes=30,
                priority_score=1,
                due=datetime(2026, 10, 17, 0, 0, tzinfo=tz),
            ),
            Task(
                id="t_normal",
                title="Regular Weekday Task",
                estimated_minutes=30,
                priority_score=1,
            ),
        ]

        result = scheduler.solve(tasks, [], start_time=saturday_now)
        by_id = {b.task_id: b.start for b in result.blocks}
        self.assertEqual(by_id["t_pulled"].date(), saturday_now.date())
        self.assertEqual(by_id["t_normal"].date(), datetime(2026, 10, 19, tzinfo=tz).date())

    def test_midnight_rollover_changes_task_set_hash(self):
        """
        P0.4: Task set hash must include current date so schedule rolls over at midnight
        even if zero tasks or calendar events changed.
        """
        from datetime import date
        from monga_cal.daemon import DaemonService

        svc = DaemonService.__new__(DaemonService)
        tasks = [Task(id="t1", title="Check mail", priority_score=2)]
        h_day1 = svc._compute_task_set_hash(tasks, today_date=date(2026, 11, 19))
        h_day2 = svc._compute_task_set_hash(tasks, today_date=date(2026, 11, 20))
        self.assertNotEqual(h_day1, h_day2)

    def test_kanban_collapsible_done_exclusion_and_two_way_completion(self):
        """
        P1.2: Tasks moved into a '#' collapsible project or marked 'done' in Kanban
        must be excluded from standalone scheduling; completing from monga-cal marks kanban_tasks done.
        """
        from monga_cal.gservices import GoogleServicesManager

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test_kanban_sync.db")
            db = Database(db_path_or_url=db_path)

            # Seed collapsible project (# SSN) and normal project (Finance)
            db._execute(
                "INSERT INTO kanban_projects (id, title, status) VALUES (?, ?, 'in_flight')",
                ("ssn-prot", "# Protect Kids SSN"),
                commit=True,
            )
            db._execute(
                "INSERT INTO kanban_projects (id, title, status) VALUES (?, ?, 'in_flight')",
                ("fin-prot", "Finance & Taxes"),
                commit=True,
            )
            # Task moved into collapsible project (is_subtask still FALSE)
            db._execute(
                "INSERT INTO kanban_tasks (id, project_id, title, kanban_column, google_task_id, is_subtask) VALUES (?, ?, ?, 'backlog', ?, 0)",
                ("k1", "ssn-prot", "Freeze Equifax", "GOOGLE_ID_MOVED_TO_SSN_123456"),
                commit=True,
            )
            # Active task in normal project
            db._execute(
                "INSERT INTO kanban_tasks (id, project_id, title, kanban_column, google_task_id, is_subtask) VALUES (?, ?, ?, 'today', ?, 0)",
                ("k2", "fin-prot", "Pay property tax", "GOOGLE_ID_ACTIVE_FIN_12345678"),
                commit=True,
            )
            # Done task in normal project
            db._execute(
                "INSERT INTO kanban_tasks (id, project_id, title, kanban_column, google_task_id, is_subtask) VALUES (?, ?, ?, 'done', ?, 0)",
                ("k3", "fin-prot", "Submit refund claim", "GOOGLE_ID_DONE_FIN_1234567890"),
                commit=True,
            )
            # Local-only Kanban task (no google_task_id)
            db._execute(
                "INSERT INTO kanban_tasks (id, project_id, title, kanban_column, google_task_id, is_subtask) VALUES (?, ?, ?, 'today', NULL, 0)",
                ("deadbeef", "fin-prot", "Review budget",),
                commit=True,
            )

            excluded = db.get_kanban_subtask_google_ids()
            self.assertIn("GOOGLE_ID_MOVED_TO_SSN_123456", excluded)
            self.assertIn("GOOGLE_ID_DONE_FIN_1234567890", excluded)
            self.assertNotIn("GOOGLE_ID_ACTIVE_FIN_12345678", excluded)

            # Complete local-only Kanban task from monga-cal
            self.assertTrue(GoogleServicesManager._is_local_only_task_id("deadbeef"))
            self.assertTrue(GoogleServicesManager._is_local_only_task_id("kanban_proj_ssn-prot"))
            self.assertFalse(GoogleServicesManager._is_local_only_task_id("ZUE2YnBFRU14QWhxT0VEOQ"))

            marked = db.mark_kanban_task_complete("deadbeef", actual_minutes=20)
            self.assertTrue(marked)
            row = db._execute("SELECT kanban_column, actual_minutes FROM kanban_tasks WHERE id = ?", ("deadbeef",), fetchone=True)
            self.assertEqual(dict(row)["kanban_column"], "done")
            self.assertEqual(dict(row)["actual_minutes"], 20)

    def test_global_theme_preference_api_and_html_injection(self):
        """
        Global Theme Sync: POST /api/theme persists preference, rejects invalid values,
        and serves it directly in index.html & GET /api/theme.
        """
        import asyncio
        from fastapi import HTTPException
        from monga_cal import main as m

        orig_db = m.daemon_service.db
        orig_pref = m._theme_preference
        with tempfile.TemporaryDirectory() as tmpdir:
            test_db = Database(db_path_or_url=os.path.join(tmpdir, "theme_test.db"))
            try:
                m.daemon_service.db = test_db
                res = asyncio.run(m.set_theme_preference_api(m.ThemePreferenceRequest(preference="dark")))
                self.assertEqual(res["preference"], "dark")
                self.assertEqual(test_db.get_setting("theme_preference"), "dark")

                got = asyncio.run(m.get_theme_preference())
                self.assertEqual(got["preference"], "dark")

                html_resp = asyncio.run(m.serve_index())
                self.assertIn('var serverPref = "dark";', html_resp.body.decode("utf-8"))

                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(m.set_theme_preference_api(m.ThemePreferenceRequest(preference="neon")))
                self.assertEqual(ctx.exception.status_code, 400)
            finally:
                m.daemon_service.db = orig_db
                m._theme_preference = orig_pref


if __name__ == "__main__":
    unittest.main()

