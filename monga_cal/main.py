import os
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
    "http://192.168.1.73:8000",
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
    title: str
    estimated_minutes: int
    actual_minutes: int

class AddTaskRequest(BaseModel):
    title: str
    notes: Optional[str] = ""
    priority_raw: Optional[int] = 0

class PriorityOverrideRequest(BaseModel):
    priority_score: int

class UpdateLoggedHoursRequest(BaseModel):
    actual_minutes: int

class OAuthExchangeRequest(BaseModel):
    code: str
    redirect_uri: Optional[str] = "http://localhost:8000/api/auth/callback"

@app.get("/api/status")
def get_status():
    st = daemon_service.status.model_dump(mode="json")
    st["google_connected"] = daemon_service.gservices._connected
    st["google_auth_error"] = daemon_service.gservices.auth_error
    st["has_client_secrets"] = os.path.exists("credentials.json")
    return st

@app.get("/api/auth/url")
def get_auth_url(redirect_uri: str = "http://localhost:8000/api/auth/callback"):
    url = daemon_service.gservices.get_authorization_url(redirect_uri=redirect_uri)
    if not url:
        raise HTTPException(status_code=400, detail="credentials.json not found in project workspace root.")
    return {"auth_url": url, "redirect_uri": redirect_uri}

@app.post("/api/auth/exchange")
async def exchange_oauth_code(req: OAuthExchangeRequest, background_tasks: BackgroundTasks):
    code = req.code.strip()
    if "code=" in code:
        import urllib.parse
        parsed = urllib.parse.urlparse(code)
        params = urllib.parse.parse_qs(parsed.query)
        if "code" in params:
            code = params["code"][0]
        else:
            try:
                code = code.split("code=")[1].split("&")[0]
                code = urllib.parse.unquote(code)
            except Exception:
                pass

    redirect_uri = req.redirect_uri or "http://localhost:8000/api/auth/callback"
    success = daemon_service.gservices.complete_oauth_flow(code, redirect_uri)
    if not success:
        raise HTTPException(status_code=400, detail=daemon_service.gservices.auth_error or "Failed to exchange authorization code.")
    
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Successfully re-authenticated with Google OAuth!", "status": get_status()}


@app.get("/api/auth/callback", response_class=HTMLResponse)
async def oauth_callback(code: Optional[str] = None, error: Optional[str] = None):
    if error:
        return f"""<html><body style="font-family:sans-serif; text-align:center; padding:50px;">
        <h2>❌ Google Authorization Failed</h2><p>{error}</p>
        <a href="/">Return to Dashboard</a></body></html>"""
    
    if code:
        redirect_uri = "http://localhost:8000/api/auth/callback"
        success = daemon_service.gservices.complete_oauth_flow(code, redirect_uri)
        if success:
            return """<html><body style="font-family:sans-serif; text-align:center; padding:50px; background:#f4f0e8;">
            <h2 style="color:#065f46;">✅ Google Account Reconnected Successfully!</h2>
            <p style="color:#7d7268;">Fresh credentials saved to token.json. Redirecting to dashboard...</p>
            <script>setTimeout(() => { window.location.href = '/'; }, 2000);</script>
            </body></html>"""
        else:
            err_detail = daemon_service.gservices.auth_error or "Unknown error"
            return f"""<html><body style="font-family:sans-serif; text-align:center; padding:50px;">
            <h2>❌ Token Exchange Failed</h2><p>{err_detail}</p>
            <a href="/">Return to Dashboard</a></body></html>"""

    return """<html><body><a href="/">Return to Dashboard</a></body></html>"""

@app.get("/api/config")
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
    daemon_service.db.save_setting("scheduler_settings", settings_dict)
    save_config(config)
    
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
    plan_blocks = daemon_service.db.get_latest_plan() or []
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
    existing_plan_raw = daemon_service.db.get_latest_plan()
    now = datetime.now()
    start_dt = datetime.combine(now.date(), datetime.min.time())
    end_dt = start_dt + timedelta(days=14)
    fixed_events = daemon_service.gservices.fetch_fixed_events(start_dt, end_dt)

    if not force_solve and existing_plan_raw:
        raw_tasks = daemon_service.gservices.fetch_tasks()
        active_deferrals = daemon_service.db.get_all_active_deferrals()
        tasks = []
        for t in raw_tasks:
            t.deferred_until = active_deferrals.get(t.id)
            tasks.append(t)

        estimated_tasks = daemon_service.ai.estimate_tasks_batch(tasks)
        for et in estimated_tasks:
            saved_prio = daemon_service.db.get_priority_override(et.id)
            if saved_prio:
                et.priority_score = max(1, min(5, saved_prio))

        blocks = [ScheduledBlock(**b) for b in existing_plan_raw]
        completed_today = daemon_service.db.get_completed_count_today()
        
        return {
            "status": get_status(),
            "tasks": [t.model_dump(mode="json") for t in estimated_tasks],
            "schedule": SchedulePlan(
                blocks=blocks,
                fixed_events=fixed_events,
                solver_stats={
                    "status": "STABLE_PRESERVED",
                    "max_tasks_per_day": config.scheduler.max_tasks_per_day,
                    "completed_today_count": completed_today
                }
            ).model_dump(mode="json"),
            "config": get_config(),
        }

    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    raw_tasks = daemon_service.gservices.fetch_tasks()
    estimated_tasks = daemon_service.ai.estimate_tasks_batch(raw_tasks)

    for et in estimated_tasks:
        saved_prio = daemon_service.db.get_priority_override(et.id)
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
    daemon_service.gservices.sync_completed_tasks_from_google(daemon_service.db)
    history = daemon_service.db.get_recent_completion_history(limit=100)
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
    daemon_service.db.update_completion_actual_minutes(record_id, req.actual_minutes)
    logger.info(f"Updated completed task #{record_id} logged time to {req.actual_minutes}m")
    return {"message": f"Updated record #{record_id} logged time to {req.actual_minutes} minutes"}

@app.get("/api/kids/stars")
async def get_kids_stars():
    return daemon_service.db.get_kids_star_summary()

@app.post("/api/kids/stars")
async def award_kid_star(req: KidStarRequest):
    summary = daemon_service.db.add_kid_star(req.kid_name, req.delta, req.chore or "")
    logger.info(f"Awarded {req.delta} star(s) to {req.kid_name} for '{req.chore or 'general chore'}'")
    return summary

@app.delete("/api/kids/stars/{star_id}")
async def delete_kid_star(star_id: int):
    daemon_service.db.delete_kid_star(star_id)
    return daemon_service.db.get_kids_star_summary()

@app.post("/api/tasks")

async def add_task(req: AddTaskRequest, background_tasks: BackgroundTasks):
    import uuid
    new_task = Task(
        id=f"gtask-{uuid.uuid4().hex[:8]}",
        title=req.title,
        notes=req.notes or "",
        list_name=config.google.tasks_list_name,
        priority_raw=req.priority_raw or 0,
        priority_score=3,
        created_at=datetime.now(),
    )
    final_id = daemon_service.gservices.add_custom_task(new_task)
    new_task.id = final_id
    logger.info(f"Added task: '{req.title}' (ID: {final_id})")
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Task added successfully", "task": new_task.model_dump(mode="json")}

@app.post("/api/tasks/{task_id}/priority")
async def update_task_priority(task_id: str, req: PriorityOverrideRequest):
    prio = req.priority_score
    if prio > 5:
        prio = 3
    prio = max(1, min(5, prio))
    
    daemon_service.db.save_priority_override(task_id, prio)
    logger.info(f"Updated task '{task_id}' priority to P{prio}")
    
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {"message": f"Task priority updated to P{prio}", "task_id": task_id, "priority_score": prio, "schedule": plan.model_dump(mode="json")}

@app.post("/api/tasks/{task_id}/defer")
async def defer_task(task_id: str, days: int = Query(default=1)):
    until_date = (datetime.now() + timedelta(days=days)).date()
    daemon_service.db.defer_task(task_id, until_date)
    logger.info(f"Snoozed task '{task_id}' for {days} days (until {until_date})")
    
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {"message": f"Task snoozed for {days} days (until {until_date})", "task_id": task_id, "deferred_until": until_date.isoformat(), "schedule": plan.model_dump(mode="json")}

@app.post("/api/snooze")
async def snooze_task(req: SnoozeRequest):
    days = req.days if req.days is not None else 1
    until_date = (datetime.now() + timedelta(days=days)).date()
    daemon_service.db.defer_task(req.task_id, until_date)
    logger.info(f"Snoozed task '{req.task_id}' for {days} days (until {until_date})")
    
    daemon_service.gservices.invalidate_cache()
    plan = await daemon_service.run_sync_cycle(force_calendar_sync=True)
    return {
        "message": f"Task snoozed for {days} day(s) (until {until_date})",
        "task_id": req.task_id,
        "deferred_until": until_date.isoformat(),
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
    record = TaskCompletionRecord(
        task_id=req.task_id,
        title=req.title,
        estimated_minutes=req.estimated_minutes,
        actual_minutes=req.actual_minutes,
    )
    daemon_service.db.record_completion(record)
    logger.info(f"Recorded completion for task '{req.title}' (actual: {req.actual_minutes}m)")

    background_tasks.add_task(daemon_service.gservices.mark_task_complete, req.task_id)
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Task completion recorded & reschedule triggered", "record": record.model_dump(mode="json")}

if os.path.exists("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    uvicorn.run("monga_cal.main:app", host=host, port=port, reload=True)
