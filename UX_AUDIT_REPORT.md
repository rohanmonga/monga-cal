# Monga Cal — Founder & UI/UX Design Audit Report

**Date**: October 17, 2026  
**Scope**: Product, Visual Design, Information Architecture, and Interaction Speed Audit (`static/index.html`, `static/app.css`, `static/app.js`)

---

## 1. The "Vibe-Coded AI" Tells (Why It Looks Generated From 50 Feet Away)

### 1.1 System Emojis Used as Structural Iconography
* **Where**: [index.html](file:///Users/rohanmonga/dev/git/monga-cal/static/index.html#L46-L87), [index.html](file:///Users/rohanmonga/dev/git/monga-cal/static/index.html#L137-L234), [app.js](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L545-L556)
* **The Problem**: Every header, button, and metric relies on Unicode system emojis (`⚡`, `🎯`, `📅`, `⭐`, `🗓️`, `⏱️`, `⛶`, `☀️`, `💤`, `⚙️`, `✅`, `🌙`, `👦`, `🏖️`). On macOS you get glossy Apple 3D emojis; on an Android wall tablet you get flat Google Noto blobs with different baseline metrics.
* **The Fix**: Replace structural UI chrome emojis (header action buttons, section icons, modal close/action icons) with crisp `1.75px`-stroke inline SVGs. Reserve emojis strictly for user-facing semantic task categories and kid avatars.

### 1.2 "Pill & Border Soup" Destroys Visual Hierarchy
* **Where**: [`renderScheduleStream`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L701-L719), [app.css](file:///Users/rohanmonga/dev/git/monga-cal/static/app.css#L765-L841)
* **The Problem**: Each task card in the center column renders a boxed time chip with a `<br>`, a category emoji, a bold title, 3 separate uppercase bordered pills (`badge-focus`, `badge-prio`, `badge-due`), generic AI filler text (`"Standard priority focus block."`), a green bordered `Done` button, and a bordered snooze icon button. When everything is bold, colored, and bordered, nothing stands out.
* **The Fix**:
  * Suppress generic filler directives (`"Standard priority focus block."`, `"Priority task block."`) unless the task has custom notes or a meaningful AI directive.
  * Use a `3.5px` left priority accent bar (`P1` crimson, `P2` amber, `P3` blue, `Fixed` purple) on `.stream-card` and interactive priority pills that can be clicked to cycle priority inline.

### 1.3 Unimplemented CSS Classes in the Gantt Chart (Broken Visuals)
* **Where**: [`renderGanttChart`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L851-L855) vs. [app.css](file:///Users/rohanmonga/dev/git/monga-cal/static/app.css#L1228-L1238)
* **The Problem**: [`ai_estimator.py`](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/ai_estimator.py#L24-L56) emits `color_preset` values of `red`, `amber`, `purple`, `cyan`, `emerald`, and `coral`, and `renderGanttChart` assigns `gantt-block-card preset-${preset}`. However, [app.css](file:///Users/rohanmonga/dev/git/monga-cal/static/app.css#L1228-L1238) only defines `.preset-fixed` and `.preset-neutral`. Categorized tasks on the Gantt chart render without background or text color rules.
* **The Fix**: Implement light and dark theme token palettes for `.preset-red`, `.preset-amber`, `.preset-purple`, `.preset-cyan`, `.preset-emerald`, and `.preset-coral` across both `.gantt-block-card` and `.stream-card`.

### 1.4 Eleven Raw `window.alert()` Calls
* **Where**: [app.js](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L271) (lines 271, 909, 926, 937, 958, 977, 1063, 1231, 1255, 1271, 1300, 1306)
* **The Problem**: Native browser `alert()` dialogs block the main JS thread, freeze the live clock and polling loop, and require manual dismissal on a wall-mounted kiosk tablet.
* **The Fix**: Replace all `alert()` calls with a non-blocking Toast notification system supporting success, warning, error, and action buttons.

---

## 2. Information Architecture & Viewport Failures

### 2.1 The "Black Hole" Task Creation Bug
* **Where**: [`saveAddTask`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L930-L963) & [`renderScheduleStream`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L621)
* **The Problem**: `renderScheduleStream` only displays blocks scheduled for `todayStr`. When today's `max_tasks_per_day` (3) slots are full and a user creates a new task, the solver places the task on a future day (or leaves it in `unscheduled_task_ids`). The modal closes and the task is nowhere to be seen in the center stream, with zero confirmation of when it was scheduled.
* **The Fix**:
  * Add view filter tabs in the center schedule header: **`Today` | `Upcoming` | `All / Unscheduled`**.
  * Trigger a toast on task creation telling the user the exact day and time slot assigned by the solver.

### 2.2 Capacity Meter Ignores Scheduled Tasks
* **Where**: [`renderCapacityMeter`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L586-L606)
* **The Problem**: `percent` and `remaining` only subtract `completedToday` from `maxPerDay`. When `0` tasks are completed and `3` tasks are scheduled today (`max_tasks_per_day = 3`), the bar reads `0%` and claims `3 slots remaining today`, even though today's capacity is 100% booked.
* **The Fix**: Render a dual-segment capacity bar showing **Completed** (solid emerald) + **Scheduled** (accent blue) against total daily capacity, and display accurate open slots remaining (`max(0, maxPerDay - completedToday - scheduledToday)`).

### 2.3 Tablet Portrait Right-Column 50% Empty Hole
* **Where**: [app.css](file:///Users/rohanmonga/dev/git/monga-cal/static/app.css#L1664-L1668)
* **The Problem**: `@media (max-width: 959px)` sets `.bento-col-right { display: grid; grid-template-columns: 1fr 1fr; }` even though `.bento-col-right` has only one child (`#bentoKidsStars`), leaving half the row blank.
* **The Fix**: Make `.bento-col-right` `grid-template-columns: 1fr`.

---

## 3. Interaction Friction & Missing Backend Wiring

### 3.1 Built Backend Features Disconnected From the UI
1. **Priority Override (`POST /api/tasks/{task_id}/priority` in [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L322))**: Wire up priority selection in `#addTaskModal` and inline priority badge clicking on task cards.
2. **Due Date Update (`POST /api/tasks/{task_id}/due` in [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L337))**: Add a Due Date input + quick date chips (`Today`, `Tomorrow`, `+3 Days`) in `#addTaskModal` and inline due date editing.
3. **Delete / Undo Kid Star (`POST /api/kids/stars/{star_id}/delete` in [main.py](file:///Users/rohanmonga/dev/git/monga-cal/monga_cal/main.py#L430))**: Add an undo/delete button on recent chore star entries and an Undo action in the star reward toast.
4. **Estimated Duration Pre-fill in Completion Modal**: [`openCompleteModal`](file:///Users/rohanmonga/dev/git/monga-cal/static/app.js#L881-L887) leaves `#actualMinutesInput` hardcoded at `30` instead of pre-filling the task's actual `estimated_minutes`.

### 3.2 Optimistic UI Updates & Keyboard Shortcuts
* **Optimistic Transitions**: Immediately reflect task completion, snoozing, priority changes, and kid star awards in the UI before the background sync finishes.
* **Keyboard Shortcuts**:
  * `Escape`: Close any active modal.
  * `Enter` (or `Cmd/Ctrl + Enter`): Submit active modal form.
  * `N`: Open `+ Add Task` modal (when not typing in an input).
* **Interactive Gantt Blocks**: Clicking a block on the 7-Day Gantt chart opens completion/details for that task rather than doing nothing.

---

## 4. Glanceability & Temporal Awareness

### 4.1 Past vs. Active vs. Upcoming Visual States & Live "NOW" Line
* **Past blocks (`end < now`)**: Dimmed opacity (`0.55`) with a subtle `PAST` / completed visual treatment.
* **Active block (`start <= now <= end`)**: Highlighted border, `LIVE` pulse badge, and live progress bar on `#heroFocusTile`.
* **"NOW" Temporal Divider**: Insert a live `──● NOW 12:08 PM ──` indicator line between past and future items in the Today stream and a vertical `NOW` marker on the Gantt timeline when viewing Today.
