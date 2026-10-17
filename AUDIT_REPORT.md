# Monga Cal — Code & Security Audit Report

**Date**: October 17, 2026  
**Scope**: Full-stack audit of `monga-cal` (`monga_cal/` backend and `static/app.js` frontend)

---

## 1. Critical Logic Bugs & Broken Behavior

### 1.1 High-Energy Window Boost Spans All 14 Days Instead of Daily Hours
* **Location**: [`SchedulerSolver.solve`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L261-L278)
* **What breaks & why**:
  `high_slot_indices` collects matching high-energy slot indices across the entire 14-day `slots` array (`h_start <= s_dt.hour < h_end`). However, lines 270–272 collapse that disjoint set of daily windows into a single contiguous min/max range across the whole 2-week horizon:
  ```python
  h_min = min(high_slot_indices)
  h_max = max(high_slot_indices)
  model.AddLinearConstraint(start_var, h_min, h_max).OnlyEnforceIf(in_high_win)
  ```
  Because `h_min` is the first high-energy slot on Day 1 and `h_max` is the last high-energy slot on Day 14, **every single slot on Days 1–13** (including low-energy late afternoon hours) falls between `h_min` and `h_max` and receives the `+500` high-energy bonus.
* **Concrete failing scenario**:
  With `work_start_hour=9`, `work_end_hour=17`, and `high_energy_start_hour=9`, `high_energy_end_hour=12`: a task with `energy="high"` placed at **4:30 PM on Day 1** (slot index `30`) satisfies `0 <= 30 <= 300` (`h_max` on Day 14), so the solver awards `in_high_win = 1` (`+500` objective points) at 4:30 PM—completely defeating high-energy morning prioritization.

### 1.2 CP-SAT Hard Constraint Contradiction Causes Total Schedule Wipeout (`INFEASIBLE`)
* **Location**: [`SchedulerSolver.solve`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L158-L208) and [`SchedulerSolver.solve`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L319-L320)
* **What breaks & why**:
  1. **Lock Window vs. Daily Capacity Contradiction**: Lines 166–173 force any task in `locked_blocks` starting within `lock_window_minutes` (30m) to be scheduled at `closest_slot_idx` via hard constraints (`is_scheduled == 1` and `start == closest_slot_idx`). Meanwhile, lines 202–207 enforce `model.Add(sum(day_starts) <= allowed_today)` as a hard constraint where `allowed_today = max(0, max_tasks_per_day - completed_today_count)`.
  2. **Locked Block Snap Collision**: Line 168 (`matching_indices = [i for i, s_dt in enumerate(slots) if s_dt >= l_start]`) snaps a locked block to the first open slot `>= l_start` if its original slot was removed by a newly added calendar meeting.
* **Concrete failing scenario**:
  * **Scenario A**: `max_tasks_per_day = 3`. The user completes 2 tasks early in the morning, leaving 1 slot (`allowed_today = 1`), and has 2 blocks in `locked_blocks` (or completes a 3rd task via `/api/complete` while another block starts in 20 minutes). The lock constraint requires `sum(day_starts) >= 1` today, while the daily capacity hard constraint requires `sum(day_starts) <= 0`.
  * **Scenario B**: Two locked 30-minute tasks at 10:00 and 10:30 are covered by a newly added 10:00–11:00 Google Calendar meeting. Both snap to `matching_indices[0]` (11:00 AM), violating `model.AddNoOverlap(intervals)`.
  * In both cases, `solver.Solve(model)` returns `cp_model.INFEASIBLE`, causing [`solve`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L319-L320) to return `blocks = []` and deleting all scheduled blocks from Google Calendar.

### 1.3 All-Day Google Calendar Events Block an Extra Full Day (Off-by-One Exclusive End Date)
* **Location**: [`GoogleServicesManager.fetch_calendar_And_tasks`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L364-L381)
* **What breaks & why**:
  Google Calendar returns all-day events with an **exclusive** `end.date` per RFC 5545 (e.g. a 1-day all-day event on `2026-10-19` has `start.date = "2026-10-19"` and `end.date = "2026-10-20"`). Line 380 executes:
  ```python
  dtend = datetime.combine(dtend.date(), datetime.max.time())
  ```
  This turns `2026-10-20` into `2026-10-20 23:59:59.999999`, extending every all-day event by an extra 24 hours.
* **Concrete failing scenario**:
  A user has an all-day event on Monday `2026-10-19` (`start.date="2026-10-19"`, `end.date="2026-10-20"`). `fetch_calendar_And_tasks` creates a fixed `CalendarSlot` from `2026-10-19 00:00:00` to `2026-10-20 23:59:59.999999`, blocking **both Monday and Tuesday** from scheduling any tasks.

### 1.4 Change-Detection Hash Ignores Calendar Events, Task Notes, and Priority Overrides
* **Location**: [`SyncDaemon._compute_task_set_hash`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/daemon.py#L29-L34) and [`SyncDaemon.run_sync_cycle`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/daemon.py#L67-L78)
* **What breaks & why**:
  `_compute_task_set_hash(raw_tasks)` is called at line 67 **before** `ai_estimator.estimate_tasks_batch(raw_tasks)` runs at line 80. At line 67, `t.priority_score` is always the default `3`, `t.notes` is not included in the hash string (`f"{t.id}:{t.title}:{t.due}:{t.priority_score}:{t.deferred_until}"`), and `fixed_events` is completely excluded.
* **Concrete failing scenario**:
  A user adds a new meeting from 11:00–12:00 today on Google Calendar (or updates a task's notes in Google Tasks). On the next 3-minute daemon poll (`force_calendar_sync=False`), `task_set_changed` is `False` (`current_task_hash == self._last_task_set_hash`), so the daemon skips the solver and keeps the old task block overlapping the new 11:00–12:00 meeting.

### 1.5 UTC `toISOString()` Date Filtering in Frontend Hides Today's Schedule After 4–5 PM Local Time
* **Location**: [static/app.js](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L10), [`renderCurrentFocusHero`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L468-L482), [`renderCapacityMeter`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L596-L597), [`renderScheduleStream`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L619-L630), and [`renderGanttChart`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L754)
* **What breaks & why**:
  `new Date().toISOString().split('T')[0]` returns the **UTC** date (`YYYY-MM-DD`), whereas backend `ScheduledBlock.start` and `CalendarSlot.start` strings are local `America/Los_Angeles` timestamps (`YYYY-MM-DDTHH:MM:SS`).
* **Concrete failing scenario**:
  At **5:05 PM PDT** (`00:05 UTC` the next day) on `2026-10-17`, `new Date().toISOString().split('T')[0]` returns `"2026-10-18"`. All `.filter(b => b.start.startsWith(todayStr))` calls filter for `"2026-10-18"`, causing today's tasks and meetings to disappear from the Today stream, Current Focus hero, and Capacity Meter, while the Gantt chart's "Today" tab displays tomorrow's events.

### 1.6 Unreachable Due-Today Weight Branch & Naive/Aware `datetime` Crash on `task.due`
* **Location**: [`GoogleServicesManager.fetch_calendar_And_tasks`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L398-L401) and [`SchedulerSolver.solve`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L283-L287)
* **What breaks & why**:
  1. Google Tasks returns due dates as midnight timestamps (`YYYY-MM-DDT00:00:00.000Z`). [`gservices.py`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L400) parses this as `YYYY-MM-DD 00:00:00`. In [`scheduler.py`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L284-L287):
     ```python
     if t.due < now:
         w += 2000
     elif t.due.date() == now.date():
         w += 1200
     ```
     Whenever `t.due.date() == now.date()` (at any time after `00:00:00.000001`), `t.due < now` is **already `True`**, making the `elif t.due.date() == now.date():` branch dead code and treating every task due today as already overdue.
  2. Unlike `now` and `fixed_events`, `t.due` is never stripped with `.replace(tzinfo=None)` inside `solve()`. Passing a timezone-aware `Task.due` raises `TypeError: can't compare offset-naive and offset-aware datetimes`.
* **Concrete failing scenario**:
  A `Task` constructed with `due=datetime(2026, 10, 18, 17, 0, tzinfo=timezone.utc)` passed to `solver.solve()` crashes with an unhandled `TypeError` at line 284.

---

## 2. Edge Cases & Missing Error Handling

### 2.1 Concurrent `run_sync_cycle` Race Conditions & Thread-Unsafe `googleapiclient` (`httplib2`)
* **Location**: [`lifespan`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L30), [`update_task_priority`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L323), [`SyncDaemon.run_sync_cycle`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/daemon.py#L43-L109), and [`GoogleServicesManager`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L39-L556)
* **Issue**:
  * There is no `asyncio.Lock` or `threading.Lock` preventing overlapping executions of `run_sync_cycle`.
  * Worse, [`update_task_priority`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L323) spawns a separate OS thread (`threading.Thread(target=lambda: asyncio.run(sync_daemon.run_sync_cycle(force_calendar_sync=True)), daemon=True).start()`).
  * `gservices_manager` shares single `self.calendar_service` and `self.tasks_service` objects backed by `httplib2.Http`, which is **not thread-safe**. Concurrent requests across the main thread and the background thread corrupt `httplib2` socket/SSL state (`ssl.SSLError`, `BadStatusLine`, or memory corruption in OpenSSL) and can insert duplicate `[Monga Cal]` calendar events if two batch syncs interleave.

### 2.2 PostgreSQL `date(created_at)` Failure & Aborted Transaction Pool Poisoning
* **Location**: [`Database.get_kids_star_summary`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/db.py#L497-L500) and [`Database._execute`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/db.py#L567-L576)
* **Issue**:
  * Line 497 runs `SELECT kid_name, date(created_at) as log_date ... GROUP BY kid_name, date(created_at)`. `date(timestamp)` is SQLite syntax; PostgreSQL raises `psycopg2.errors.UndefinedFunction: function date(timestamp without time zone) does not exist`.
  * In `_execute` (line 568), `conn.rollback()` is only called `if commit and self.is_postgres:`. When a read query (`commit=False`) raises an exception in PostgreSQL, the connection is returned to `ThreadedConnectionPool` via `self._pool.putconn(conn)` in an aborted transaction state (`TRANSACTION_STATUS_INERROR`), causing subsequent queries borrowing that connection to fail with `InFailedSqlTransaction`.

### 2.3 Silent Priority Reset When `priority > 5`
* **Location**: [`update_task_priority`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L328-L331) and [`AIEstimator.estimate_tasks_batch`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/ai_estimator.py#L104-L107)
* **Issue**:
  ```python
  if prio > 5:
      prio = 3
  prio = max(1, min(5, prio))
  ```
  If `prio > 5` (e.g. `6`), it is overwritten with `3` before `min(5, prio)` is ever reached.

### 2.4 Missing Pagination in Google Tasks & Calendar API Calls (20-Task Truncation)
* **Location**: [`GoogleServicesManager.fetch_calendar_And_tasks`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L353-L395) and [`GoogleServicesManager.sync_blocks_to_calendar`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L429-L437)
* **Issue**:
  * `self.tasks_service.tasks().list(tasklist=list_id, showCompleted=False, showHidden=False).execute()` does not pass `maxResults=100` or iterate `nextPageToken`. Google Tasks API defaults to `maxResults=20`, silently dropping the 21st+ active tasks.
  * `self.calendar_service.events().list(...)` does not follow `nextPageToken` (defaulting to 250 events across 14 days).

### 2.5 Unvalidated `due_date` Format in `/api/tasks/{task_id}/due`
* **Location**: [`update_task_due_endpoint`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L337-L347) and [`GoogleServicesManager.update_task_due`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L544)
* **Issue**:
  `body = {"due": f"{due_date}T00:00:00.000Z"}` does not validate `due_date` as `YYYY-MM-DD`. If the client sends a full ISO datetime (`2026-10-18T12:00:00Z`) or malformed string, Google Tasks returns `400 Bad Request` and the endpoint returns a `500 Internal Server Error`.

---

## 3. Performance & Resource Inefficiencies

### 3.1 Event Loop Starvation via Blocking I/O, `time.sleep`, and CPU-Bound Solver Inside `async def`
* **Location**: [`SyncDaemon.run_sync_cycle`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/daemon.py#L43-L109), [`GoogleServicesManager.sync_blocks_to_calendar`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L501-L503), [`SchedulerSolver.solve`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L305-L306), and FastAPI `async def` routes in [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L168-L441)
* **Issue**:
  `run_sync_cycle` and all FastAPI route handlers are declared `async def`, running directly on the single main asyncio event loop thread without `asyncio.to_thread()`. Inside `run_sync_cycle`, the event loop is blocked synchronously by:
  1. `googleapiclient` HTTP calls (`fetch_calendar_And_tasks`, `sync_blocks_to_calendar`).
  2. `time.sleep(0.3)` between batch calendar sync chunks ([`gservices.py`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L503)).
  3. Synchronous Gemini LLM generation (`self.client.models.generate_content` in [`ai_estimator.py`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/ai_estimator.py#L192-L195)).
  4. Up to **5.0 seconds** of CPU-bound OR-Tools CP-SAT solving ([`scheduler.py`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L305-L306)).
  5. Up to **10.0 seconds** of synchronous `urllib.request.urlopen` in [`_ha_call`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L51).
  While any of these run, Uvicorn cannot accept or respond to any incoming HTTP requests (including `/api/health` or UI actions).

### 3.2 $O(T \times S^2)$ Redundant Slot Scans & Excessive `BoolVar` Allocation in Solver
* **Location**: [`SchedulerSolver.solve`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L180-L227)
* **Issue**:
  * At lines 214–223, inside a `for t in schedulable_tasks:` and `for s_idx, s_dt in enumerate(slots):` loop, the code executes:
    ```python
    same_day_Possible = [idx for idx, dt in enumerate(slots) if dt.date() == s_dt.date()]
    ```
    This performs an $O(S)$ scan inside an $O(T \times S)$ loop ($O(T \times S^2)$ total), even though `day_to_slots: Dict[date, List[int]]` was already computed at line 183.
  * At lines 187–200, for every task and every day, it allocates `len(slot_indices)` separate `BoolVar` variables (`b_in_s`) to check if a task starts on `d_date`. Because `slot_indices` for a given day is always a contiguous integer range `[min_idx, max_idx]`, a single linear range constraint `model.AddLinearConstraint(t_var["start"], slot_indices[0], slot_indices[-1]).OnlyEnforceIf(is_on_day)` eliminates thousands of auxiliary boolean variables.

### 3.3 Unbounded `plan_history` Table Growth & Unpooled SQLite Connections
* **Location**: [`Database._get_connection`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/db.py#L60), [`Database.save_plan`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/db.py#L434-L440), and [`Database.is_task_completed`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/db.py#L320-L323)
* **Issue**:
  * `plan_history` inserts a full JSON array of blocks on every plan update and is never pruned, growing without bound.
  * `task_history` has an index on `completed_at` (`idx_task_history_completed`) but **no index on `task_id`**, causing `is_task_completed(task_id)` to perform a full table scan.
  * In SQLite mode, `_get_connection()` opens and closes a new file connection on every query without enabling `PRAGMA journal_mode=WAL` or `busy_timeout`.

---

## 4. Security Vulnerabilities

### 4.1 Reflected Cross-Site Scripting (XSS) in `/api/auth/callback`
* **Location**: [`oauth_callback`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L126-L157)
* **Vulnerability**:
  The `error` query parameter and `err_detail` exception text are interpolated directly into an `HTMLResponse` without HTML escaping:
  ```python
  if error:
      return HTMLResponse(
          content=f"<html><body style='...'><h2>❌ Google OAuth Error</h2><p>{error}</p></body></html>",
          status_code=400
      )
  ```
  Navigating to `/api/auth/callback?error=<script>...</script>` executes arbitrary JavaScript in the application's origin.

### 4.2 Indirect / Stored DOM XSS via Unescaped `category_icon` and `color_preset`
* **Location**: [`renderScheduleStream`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L706) and [`renderGanttChart`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L855-L870)
* **Vulnerability**:
  In `app.js`, `t.category_icon` (`${t.category_icon || '📌'}` at line 706 and `${icon}` at line 870) is interpolated directly into `innerHTML` without `escapeHtml()`. Because `category_icon` is populated from the Gemini LLM response in [`AIEstimator.estimate_tasks_batch`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/ai_estimator.py#L234-L242) without length or character validation, a prompt-injected task title/note instructing the LLM to output `<img src=x onerror=...>` in `category_icon` achieves stored DOM XSS on the dashboard.

### 4.3 Missing OAuth 2.0 `state` Verification (OAuth Login CSRF)
* **Location**: [`oauth_callback`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L126-L148) and [`GoogleServicesManager.complete_oauth_flow`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L132-L163)
* **Vulnerability**:
  [`generate_auth_url`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L120-L128) saves `"state"` to `.oauth_state.json`, but `oauth_callback` ignores the `state` query parameter from Google, and `complete_oauth_flow` never validates the returned `state` against the stored `"state"`. An attacker can initiate an OAuth flow with their own Google account and trick a user on the local network into visiting `/api/auth/callback?code=<attacker_code>`, silently binding `monga-cal` (`token.json`) to the attacker's Google account.

### 4.4 Permissive CORS (`*` + `allow_credentials=True`) & Unauthenticated Administrative Endpoints
* **Location**: [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L94-L100)
* **Vulnerability**:
  `CORSMiddleware` is configured with `allow_origins=["*"]` and `allow_credentials=True`, and none of the state-mutating endpoints (`/api/auth/exchange`, `/api/settings`, `/api/tasks`, `/api/complete`, `/api/tablet/screen/sleep`) require authentication. Any page opened in a browser on the local network can read the user's schedule or mutate tasks and settings via cross-origin requests.

### 4.5 World-Readable OAuth Refresh Token (`token.json`) and PKCE State (`.oauth_state.json`)
* **Location**: [`GoogleServicesManager._save_token`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L283-L287) and [`GoogleServicesManager.generate_auth_url`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L123-L128)
* **Vulnerability**:
  Both `token.json` (containing long-lived OAuth refresh tokens) and `.oauth_state.json` (containing the plaintext PKCE `code_verifier`) are created with default OS `umask` permissions (typically `0644` world-readable) instead of `0600`.

---

## 5. Severity & Test Plan

### Severity Matrix

| ID | Finding | Location | Severity |
| :--- | :--- | :--- | :--- |
| **1.1** | High-energy window boost spans all 14 days instead of daily hours | [scheduler.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L261-L278) | **Critical** |
| **1.2** | CP-SAT hard constraint contradiction (`INFEASIBLE` wipes entire schedule) | [scheduler.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L158-L208) | **Critical** |
| **1.3** | All-day Google Calendar events block an extra full day | [gservices.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L364-L381) | **High** |
| **1.4** | Task set hash ignores fixed calendar events, task notes, and priority overrides | [daemon.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/daemon.py#L29-L78) | **High** |
| **1.5** | Frontend UTC `toISOString()` date filter hides today's tasks after 4–5 PM PT | [app.js](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L468-L754) | **High** |
| **1.6** | Unreachable due-today branch & naive/aware `datetime` crash on `task.due` | [scheduler.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L283-L287) | **Medium** |
| **2.1** | Concurrent `run_sync_cycle` race condition & thread-unsafe `httplib2` | [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L323), [daemon.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/daemon.py#L43) | **High** |
| **2.2** | PostgreSQL `date(created_at)` crash & un-rolled-back pool connections | [db.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/db.py#L497-L574) | **High** |
| **2.3** | Silent priority reset to `3` when `priority > 5` | [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L328-L331) | **Low** |
| **2.4** | Missing Google Tasks/Calendar pagination (truncates >20 tasks) | [gservices.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L353-L395) | **Medium** |
| **2.5** | Unvalidated `due_date` string in `/api/tasks/{task_id}/due` | [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L337-L347) | **Low** |
| **3.1** | Event loop starvation via blocking I/O & CPU-bound solver in `async def` | [daemon.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/daemon.py#L43-L109), [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L51) | **High** |
| **3.2** | $O(T \times S^2)$ slot scan & per-slot `BoolVar` explosion in CP-SAT | [scheduler.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/scheduler.py#L180-L227) | **Medium** |
| **3.3** | Unbounded `plan_history` growth & missing `task_history(task_id)` index | [db.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/db.py#L320-L440) | **Low** |
| **4.1** | Reflected XSS in `/api/auth/callback` | [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L126-L157) | **High** |
| **4.2** | Stored/Indirect DOM XSS via unescaped `category_icon` in `app.js` | [app.js](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L706-L870) | **Medium** |
| **4.3** | Missing OAuth `state` parameter validation (OAuth Login CSRF) | [gservices.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L132-L163) | **High** |
| **4.4** | Wildcard CORS with credentials & unauthenticated API | [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L94-L100) | **Medium** |
| **4.5** | World-readable `token.json` and `.oauth_state.json` | [gservices.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/gservices.py#L123-L287) | **Low** |

---

### Recommended Unit & Integration Test Suite (5 Tests)

1. **`test_high_energy_task_prefers_morning_over_day1_afternoon` (Catches 1.1)**
   * **Setup**: Configure `work_start_hour=9`, `work_end_hour=17`, `high_energy_start_hour=9`, `high_energy_end_hour=12`. Block Day 1 morning (09:00–12:00) with a fixed `CalendarSlot`, leaving Day 1 afternoon (12:00–17:00) and Day 2 morning (09:00–12:00) open. Create one `Task(id="t1", priority_score=3, energy="high", estimated_minutes=60)`.
   * **Assertion**: Verify that `in_high_win` is only active during `09:00–12:00` on each individual day—specifically that the `+500` high-energy bonus outweighs the single-day `15`-point delay penalty (`32 * 15 = 480 < 500`), scheduling the task in Day 2's `09:00` high-energy window rather than falsely awarding `+500` to Day 1's `12:15` afternoon slot.

2. **`test_locked_block_with_exhausted_daily_capacity_does_not_infeasible_wipe_schedule` (Catches 1.2)**
   * **Setup**: Set `max_tasks_per_day=3` and `completed_today_count=3`. Pass `locked_blocks=[ScheduledBlock(task_id="t_locked", start=now + timedelta(minutes=15), end=now + timedelta(minutes=45), ...)]` along with 4 additional tasks for tomorrow.
   * **Assertion**: `plan = solver.solve(...)` must not return `status == "INFEASIBLE"` and must still schedule the remaining tasks on subsequent days (`len(plan.blocks) >= 4`).

3. **`test_all_day_google_calendar_event_blocks_only_single_day` (Catches 1.3)**
   * **Setup**: Mock `calendar_service.events().list().execute()` to return a 1-day all-day event `{"start": {"date": "2026-10-19"}, "end": {"date": "2026-10-20"}, "summary": "Holiday"}`.
   * **Assertion**: `fixed_events, _ = gservices.fetch_calendar_And_tasks()` produces a `CalendarSlot` where `slot.start.date() == date(2026, 10, 19)` and `slot.end <= datetime(2026, 10, 19, 23, 59, 59, 999999)`, leaving `2026-10-20` open for scheduling.

4. **`test_daemon_reschedules_when_fixed_calendar_event_added` (Catches 1.4)**
   * **Setup**: Run `await daemon.run_sync_cycle(force_calendar_sync=False)` with 1 task scheduled at `10:00–11:00`. Then add a new fixed `CalendarSlot` at `10:00–11:00` while keeping the task list unchanged, and run `await daemon.run_sync_cycle(force_calendar_sync=False)` again.
   * **Assertion**: The daemon detects the calendar change, re-runs the solver, and moves the task block out of the `10:00–11:00` collision window.

5. **`test_oauth_callback_escapes_xss_and_verifies_state` (Catches 4.1 & 4.3)**
   * **Setup**: Send `GET /api/auth/callback?error=<script>alert(1)</script>` and `GET /api/auth/callback?code=fake_code&state=wrong_state` using FastAPI's `TestClient`.
   * **Assertion**:
     1. The response body for `error` contains `&lt;script&gt;alert(1)&lt;/script&gt;` and never raw `<script>`.
     2. A callback with a missing or mismatched `state` parameter is rejected with HTTP `400` before `flow.fetch_token()` is ever invoked.
