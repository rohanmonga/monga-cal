# User Preferences & Workspace Rules

1. **Browser Subagent / Screenshots Policy**:
   - DO NOT automatically run browser subagents or take screenshots.
   - Always rely on terminal command logs and python/curl inspection.
   - Ask for explicit user confirmation before running browser subagents or taking screenshots.

2. **Git Commit Policy**:
   - NEVER run `git commit` or `git push` automatically. The user will manage git commits.

3. **User Files Integrity**:
   - Never overwrite user changes (such as `Dockerfile`, `requirements.txt`, or active user documents). Ask the user first.

4. **Daily Workload Capacity Logic**:
   - `max_tasks_per_day` (e.g. 3) represents total daily capacity (Completed Tasks Today + Scheduled Tasks Today <= 3).
   - Completed tasks today count against the daily limit.
