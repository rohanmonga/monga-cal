import os
import html
import asyncio
import logging
from datetime import datetime, date, timedelta
from contextlib import asynccontextmanager
from typing import Optional, List
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from monga_cal.daemon import daemon_service
from monga_cal.models import TaskCompletionRecord, SchedulePlan, ScheduledBlock, Task, ScheduleSettingsRequest, KidStarRequest, SnoozeRequest
from monga_cal.config import config, save_config


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("monga_cal")

bg_task: Optional[asyncio.Task] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global bg_task
    logger.info("Starting monga-cal background daemon...")
    bg_task = asyncio.create_task(daemon_service.loop())
    yield
    logger.info("Stopping monga-cal background daemon...")
    daemon_service._running = False
    if bg_task:
        bg_task.cancel()

app = FastAPI(
    title="Google Tasks + Google Calendar AI Manager",
    description="Google Workspace bridge powered by Gemini API & OR-Tools CP-SAT for Raspberry Pi & Fridge Tablet",
    version="2.0.0",
    lifespan=lifespan,
)

cors_origins = [
    os.getenv("FRONTEND_URL", "http://localhost:8000"),
    "http://localhost:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://192.168.86.32:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+):?\d*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TaskCompletionRequest(BaseModel):
    task_id: str
    title: Optional[str] = None
    estimated_minutes: Optional[int] = None
    actual_minutes: int = 30

class AddTaskRequest(BaseModel):
    title: str
    notes: Optional[str] = ""
    priority_raw: Optional[int] = 0
    priority_score: Optional[int] = None
    due: Optional[str] = None

class PriorityOverrideRequest(BaseModel):
    priority_score: int

class UpdateLoggedHoursRequest(BaseModel):
    actual_minutes: int

class OAuthExchangeRequest(BaseModel):
    code: str
    redirect_uri: Optional[str] = "http://localhost:8000/api/auth/callback"
    state: Optional[str] = None

class TaskDueUpdateRequest(BaseModel):
    due: Optional[str] = None

@app.get("/api/status")
def get_status():
    st = daemon_service.status.model_dump(mode="json")
    st["google_connected"] = daemon_service.gservices._connected
    st["google_auth_error"] = daemon_service.gservices.auth_error
    st["has_client_secrets"] = os.path.exists("credentials.json")
    return st

@app.get("/api/auth/url")
async def get_auth_url(redirect_uri: str = "http://localhost:8000/api/auth/callback"):
    url = await asyncio.to_thread(daemon_service.gservices.get_authorization_url, redirect_uri)
    if not url:
        raise HTTPException(status_code=400, detail="credentials.json not found in project workspace root.")
    return {"auth_url": url, "redirect_uri": redirect_uri}

@app.post("/api/auth/exchange")
async def exchange_oauth_code(req: OAuthExchangeRequest, background_tasks: BackgroundTasks):
    code = req.code.strip()
    extracted_state = req.state
    if "code=" in code:
        import urllib.parse
        parsed = urllib.parse.urlparse(code if code.startswith("http") else f"http://localhost/{code.lstrip('/')}")
        params = urllib.parse.parse_qs(parsed.query)
        if "code" in params:
            code = params["code"][0]
        if not extracted_state and "state" in params:
            extracted_state = params["state"][0]
        elif "code=" in code:
            try:
                code = code.split("code=")[1].split("&")[0]
                code = urllib.parse.unquote(code)
            except Exception:
                pass

    redirect_uri = req.redirect_uri or "http://localhost:8000/api/auth/callback"
    success = await asyncio.to_thread(
        daemon_service.gservices.complete_oauth_flow, code, redirect_uri, extracted_state
    )
    if not success:
        raise HTTPException(status_code=400, detail=daemon_service.gservices.auth_error or "Failed to exchange authorization code.")
    
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Successfully re-authenticated with Google OAuth!", "status": get_status()}


@app.get("/api/auth/callback", response_class=HTMLResponse)
async def oauth_callback(
    code: Optional[str] = None,
    error: Optional[str] = None,
    state: Optional[str] = None,
):
    if error:
        safe_error = html.escape(str(error))
        return HTMLResponse(
            content=f"""<html><body style="font-family:sans-serif; text-align:center; padding:50px;">
            <h2>❌ Google Authorization Failed</h2><p>{safe_error}</p>
            <a href="/">Return to Dashboard</a></body></html>""",
            status_code=400,
        )
    
    if code:
        if state is None and os.path.exists(".oauth_state.json"):
            return HTMLResponse(
                content="""<html><body style="font-family:sans-serif; text-align:center; padding:50px;">
                <h2>❌ Token Exchange Failed</h2><p>Missing OAuth state parameter.</p>
                <a href="/">Return to Dashboard</a></body></html>""",
                status_code=400,
            )

        redirect_uri = "http://localhost:8000/api/auth/callback"
        success = await asyncio.to_thread(
            daemon_service.gservices.complete_oauth_flow, code, redirect_uri, state
        )
        if success:
            return HTMLResponse(
                content="""<html><body style="font-family:sans-serif; text-align:center; padding:50px; background:#f4f0e8;">
                <h2 style="color:#065f46;">✅ Google Account Reconnected Successfully!</h2>
                <p style="color:#7d7268;">Fresh credentials saved to token.json. Redirecting to dashboard...</p>
                <script>setTimeout(() => { window.location.href = '/'; }, 2000);</script>
                </body></html>""",
                status_code=200,
            )
        else:
            err_detail = html.escape(str(daemon_service.gservices.auth_error or "Unknown error"))
            return HTMLResponse(
                content=f"""<html><body style="font-family:sans-serif; text-align:center; padding:50px;">
                <h2>❌ Token Exchange Failed</h2><p>{err_detail}</p>
                <a href="/">Return to Dashboard</a></body></html>""",
                status_code=400,
            )

    return HTMLResponse(content="""<html><body><a href="/">Return to Dashboard</a></body></html>""")

@app.get("/api/config")
@app.get("/api/settings")
def get_config():
    return {
        "active_days": config.scheduler.active_days,
        "work_start_hour": config.scheduler.work_start_hour,
        "work_end_hour": config.scheduler.work_end_hour,
        "buffer_minutes": config.scheduler.buffer_minutes,
        "max_tasks_per_day": getattr(config.scheduler, "max_tasks_per_day", 3),
        "high_energy_start_hour": config.scheduler.high_energy_start_hour,
        "high_energy_end_hour": config.scheduler.high_energy_end_hour,
    }

@app.post("/api/config")
@app.post("/api/settings")
async def update_config(req: ScheduleSettingsRequest, background_tasks: BackgroundTasks):
    start_h = req.work_start_hour
    end_h = req.work_end_hour
    if end_h <= start_h and end_h <= 12:
        end_h += 12

    config.scheduler.active_days = req.active_days
    config.scheduler.work_start_hour = start_h
    config.scheduler.work_end_hour = end_h
    config.scheduler.buffer_minutes = req.buffer_minutes
    config.scheduler.max_tasks_per_day = req.max_tasks_per_day
    config.scheduler.high_energy_start_hour = req.high_energy_start_hour
    config.scheduler.high_energy_end_hour = req.high_energy_end_hour
    
    settings_dict = {
        "active_days": req.active_days,
        "work_start_hour": start_h,
        "work_end_hour": end_h,
        "buffer_minutes": req.buffer_minutes,
        "max_tasks_per_day": req.max_tasks_per_day,
        "high_energy_start_hour": req.high_energy_start_hour,
        "high_energy_end_hour": req.high_energy_end_hour,
    }
    await asyncio.to_thread(daemon_service.db.save_setting, "scheduler_settings", settings_dict)
    await asyncio.to_thread(save_config, config)
    
    daemon_service.scheduler.work_start_hour = start_h
    daemon_service.scheduler.work_end_hour = end_h
    daemon_service.scheduler.buffer_minutes = req.buffer_minutes
    daemon_service.scheduler.max_tasks_per_day = req.max_tasks_per_day
    daemon_service.scheduler.active_days = req.active_days

    logger.info("Updated schedule settings & saved to DB + config.yaml")
    
    daemon_service.gservices.invalidate_cache()
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Schedule configuration updated successfully", "config": get_config()}

@app.get("/api/today")
async def get_today_schedule():
    plan_blocks = await asyncio.to_thread(daemon_service.db.get_latest_plan) or []
    today_str = datetime.now().strftime("%Y-%m-%d")
    today_blocks = [
        b for b in plan_blocks
        if b.get("start", "").startswith(today_str)
    ]
    return {
        "status": get_status(),
        "today_blocks": today_blocks,
        "config": get_config(),
    }

@app.get("/api/plan")
async def get_plan(force_solve: bool = False):
    existing_plan_raw = await asyncio.to_thread(daemon_service.db.get_latest_plan)
    now = datetime.now()
    start_dt = datetime.combine(now.date(), datetime.min.time())
    end_dt = start_dt + timedelta(days=14)
    fixed_events = await asyncio.to_thread(daemon_service.gservices.fetch_fixed_events, start_dt, end_dt)

    if not force_solve and existing_plan_raw:
        raw_tasks = await asyncio.to_thread(daemon_service.gservices.fetch_tasks)
        active_deferrals = await asyncio.to_thread(daemon_service.db.get_all_active_deferrals)
        priority_overrides = await asyncio.to_thread(daemon_service.db.get_all_priority_overrides)
        tasks = []
        for t in raw_tasks:
            t.deferred_until = active_deferrals.get(t.id)
            tasks.append(t)

        estimated_tasks = await asyncio.to_thread(daemon_service.ai.estimate_tasks_batch, tasks)
        for et in estimated_tasks:
            saved_prio = priority_overrides.get(et.id)
            if saved_prio:
                et.priority_score = max(1, min(5, saved_prio))

        blocks = [ScheduledBlock(**b) for b in existing_plan_raw]
        scheduled_ids = {b.task_id for b in blocks}
        unscheduled_ids = [t.id for t in estimated_tasks if t.id not in scheduled_ids]
        completed_today = await asyncio.to_thread(daemon_service.db.get_completed_count_today)
        
        return {
            "status": get_status(),
            "tasks": [t.model_dump(mode="json") for t in estimated_tasks],
            "schedule": SchedulePlan(
                blocks=blocks,
                fixed_events=fixed_events,
                unscheduled_task_ids=unscheduled_ids,
                solver_stats={
                    "status": "STABLE_PRESERVED",
                    "max_tasks_per_day": config.scheduler.max_tasks_per_day,
                    "completed_today_count": completed_today
                }
            ).model_dump(mode="json"),
            "config": get_config(),
        }

    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    raw_tasks = await asyncio.to_thread(daemon_service.gservices.fetch_tasks)
    active_deferrals = await asyncio.to_thread(daemon_service.db.get_all_active_deferrals)
    priority_overrides = await asyncio.to_thread(daemon_service.db.get_all_priority_overrides)
    for t in raw_tasks:
        t.deferred_until = active_deferrals.get(t.id)
    estimated_tasks = await asyncio.to_thread(daemon_service.ai.estimate_tasks_batch, raw_tasks)

    for et in estimated_tasks:
        saved_prio = priority_overrides.get(et.id)
        if saved_prio:
            et.priority_score = max(1, min(5, saved_prio))

    return {
        "status": get_status(),
        "tasks": [t.model_dump(mode="json") for t in estimated_tasks],
        "schedule": plan.model_dump(mode="json"),
        "config": get_config(),
    }

@app.get("/api/history")
async def get_completion_history():
    await asyncio.to_thread(daemon_service.gservices.sync_completed_tasks_from_google, daemon_service.db)
    history = await asyncio.to_thread(daemon_service.db.get_recent_completion_history, 100)
    total_est = sum(h["estimated_minutes"] for h in history)
    total_act = sum(h["actual_minutes"] for h in history)
    return {
        "history": history,
        "summary": {
            "total_completed": len(history),
            "total_estimated_hours": round(total_est / 60.0, 2),
            "total_actual_hours": round(total_act / 60.0, 2),
            "variance_hours": round((total_act - total_est) / 60.0, 2),
        }
    }

@app.post("/api/history/{record_id}/log")
async def update_logged_hours(record_id: int, req: UpdateLoggedHoursRequest):
    await asyncio.to_thread(daemon_service.db.update_completion_actual_minutes, record_id, req.actual_minutes)
    logger.info(f"Updated completed task #{record_id} logged time to {req.actual_minutes}m")
    return {"message": f"Updated record #{record_id} logged time to {req.actual_minutes} minutes"}

@app.get("/api/kids/stars")
async def get_kids_stars():
    return await asyncio.to_thread(daemon_service.db.get_kids_star_summary)

@app.post("/api/kids/stars")
async def award_kid_star(req: KidStarRequest):
    summary = await asyncio.to_thread(daemon_service.db.add_kid_star, req.kid_name, req.delta, req.chore or "")
    logger.info(f"Awarded {req.delta} star(s) to {req.kid_name} for '{req.chore or 'general chore'}'")
    return summary

@app.delete("/api/kids/stars/{star_id}")
@app.post("/api/kids/stars/{star_id}/delete")
async def delete_kid_star(star_id: int):
    await asyncio.to_thread(daemon_service.db.delete_kid_star, star_id)
    return await asyncio.to_thread(daemon_service.db.get_kids_star_summary)

@app.post("/api/tasks")
async def add_task(req: AddTaskRequest):
    import uuid
    due_dt = None
    if req.due:
        try:
            parsed_d = date.fromisoformat(str(req.due).strip()[:10])
            due_dt = datetime.combine(parsed_d, datetime.min.time())
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid due date format: {req.due}")

    prio = max(1, min(5, int(req.priority_score))) if req.priority_score is not None else 3
    new_task = Task(
        id=f"gtask-{uuid.uuid4().hex[:8]}",
        title=req.title,
        notes=req.notes or "",
        list_name=config.google.tasks_list_name,
        due=due_dt,
        priority_raw=req.priority_raw or 0,
        priority_score=prio,
        created_at=datetime.now(),
    )
    final_id = await asyncio.to_thread(daemon_service.gservices.add_custom_task, new_task)
    new_task.id = final_id
    if req.priority_score is not None:
        await asyncio.to_thread(daemon_service.db.save_priority_override, final_id, prio)
    logger.info(f"Added task: '{req.title}' (ID: {final_id}, P{prio}, due={req.due})")
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {
        "message": "Task added successfully",
        "task": new_task.model_dump(mode="json"),
        "schedule": plan.model_dump(mode="json"),
    }

@app.post("/api/tasks/{task_id}/priority")
async def update_task_priority(task_id: str, req: PriorityOverrideRequest):
    prio = max(1, min(5, int(req.priority_score)))
    
    await asyncio.to_thread(daemon_service.db.save_priority_override, task_id, prio)
    logger.info(f"Updated task '{task_id}' priority to P{prio}")
    
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {"message": f"Task priority updated to P{prio}", "task_id": task_id, "priority_score": prio, "schedule": plan.model_dump(mode="json")}

@app.post("/api/tasks/{task_id}/due")
async def update_task_due(task_id: str, req: TaskDueUpdateRequest):
    if req.due:
        try:
            date.fromisoformat(str(req.due).strip()[:10])
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid ISO date format: {req.due}")

    success = await asyncio.to_thread(daemon_service.gservices.update_task_due, task_id, req.due)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to update due date in Google Tasks")
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {"message": f"Task due date updated to {req.due}", "task_id": task_id, "due": req.due, "schedule": plan.model_dump(mode="json")}

@app.post("/api/tasks/{task_id}/defer")
async def defer_task(task_id: str, days: int = Query(default=1)):
    until_date = (datetime.now() + timedelta(days=days)).date()
    await asyncio.to_thread(daemon_service.db.defer_task, task_id, until_date)
    logger.info(f"Snoozed task '{task_id}' for {days} days (until {until_date})")
    
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {"message": f"Task snoozed for {days} days (until {until_date})", "task_id": task_id, "deferred_until": until_date.isoformat(), "schedule": plan.model_dump(mode="json")}

@app.post("/api/snooze")
async def snooze_task(req: SnoozeRequest):
    days = req.days if req.days is not None else 1
    until_date = (datetime.now() + timedelta(days=days)).date()
    await asyncio.to_thread(daemon_service.db.defer_task, req.task_id, until_date)
    logger.info(f"Snoozed task '{req.task_id}' for {days} days (until {until_date})")
    
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {
        "message": f"Task snoozed for {days} day(s) (until {until_date})",
        "task_id": req.task_id,
        "deferred_until": until_date.isoformat(),
        "schedule": plan.model_dump(mode="json")
    }

@app.post("/api/unsnooze")
async def unsnooze_task(req: SnoozeRequest):
    await asyncio.to_thread(daemon_service.db.clear_deferral, req.task_id)
    logger.info(f"Woke/unsnoozed task '{req.task_id}'")
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {
        "message": "Task unsnoozed",
        "task_id": req.task_id,
        "schedule": plan.model_dump(mode="json")
    }

@app.post("/api/reschedule")
async def trigger_reschedule():
    logger.info("Manual reschedule requested via API.")
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {
        "message": "Reschedule cycle completed successfully",
        "schedule": plan.model_dump(mode="json"),
    }

@app.post("/api/complete")
async def complete_task(req: TaskCompletionRequest, background_tasks: BackgroundTasks):
    title = req.title
    est_min = req.estimated_minutes
    if not title or est_min is None:
        cached_tasks = daemon_service.gservices._tasks_cache or []
        matched = next((t for t in cached_tasks if t.id == req.task_id), None)
        if matched:
            title = title or matched.title
            est_min = est_min if est_min is not None else (matched.estimated_minutes or 30)
        else:
            latest_plan = await asyncio.to_thread(daemon_service.db.get_latest_plan) or []
            matched_block = next((b for b in latest_plan if b.get("task_id") == req.task_id), None)
            if matched_block:
                title = title or matched_block.get("task_title", "Completed Task")
                est_min = est_min if est_min is not None else matched_block.get("estimated_minutes", 30)

    record = TaskCompletionRecord(
        task_id=req.task_id,
        title=title or "Completed Task",
        estimated_minutes=est_min if est_min is not None else 30,
        actual_minutes=req.actual_minutes,
    )
    await asyncio.to_thread(daemon_service.db.record_completion, record)
    logger.info(f"Recorded completion for task '{record.title}' (actual: {req.actual_minutes}m)")

    async def _complete_and_resync():
        await asyncio.to_thread(daemon_service.gservices.mark_task_complete, req.task_id)
        await daemon_service.run_sync_cycle(force_calendar_sync=True)

    background_tasks.add_task(_complete_and_resync)
    return {"message": "Task completion recorded & reschedule triggered", "record": record.model_dump(mode="json")}

def _post_ha_webhook(url: str):
    import urllib.request
    req = urllib.request.Request(url, data=b"", method="POST")
    urllib.request.urlopen(req, timeout=3)

@app.post("/api/tablet/screen/sleep")
async def sleep_tablet():
    try:
        await asyncio.to_thread(_post_ha_webhook, "http://192.168.86.32:8123/api/webhook/sleep_tablet_screen")
        return {"status": "ok", "action": "sleep"}
    except Exception as e:
        logger.warning(f"Failed to sleep tablet screen via HA: {e}")
        return {"status": "error", "error": str(e)}

@app.post("/api/tablet/screen/wake")
async def wake_tablet():
    try:
        await asyncio.to_thread(_post_ha_webhook, "http://192.168.86.32:8123/api/webhook/wake_tablet_screen")
        return {"status": "ok", "action": "wake"}
    except Exception as e:
        logger.warning(f"Failed to wake tablet screen via HA: {e}")
        return {"status": "error", "error": str(e)}

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = os.path.join(os.path.dirname(__file__), "..", "static", "index.html")
    if not os.path.exists(index_path):
        index_path = "static/index.html"
    with open(index_path, "r", encoding="utf-8") as f:
        content = f.read()
    return HTMLResponse(
        content=content,
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )

if os.path.exists("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    uvicorn.run("monga_cal.main:app", host=host, port=port, reload=True)
