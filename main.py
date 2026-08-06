import asyncio
import logging
from datetime import datetime, date, timedelta
from contextlib import asynccontextmanager
from typing import Optional, List
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from daemon import daemon_service
from models import TaskCompletionRecord, SchedulePlan, Task, ScheduleSettingsRequest
from config import config, save_config

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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

@app.get("/api/status")
def get_status():
    return daemon_service.status.model_dump(mode="json")

@app.get("/api/config")
def get_config():
    return {
        "active_days": config.scheduler.active_days,
        "work_start_hour": config.scheduler.work_start_hour,
        "work_end_hour": config.scheduler.work_end_hour,
        "buffer_minutes": config.scheduler.buffer_minutes,
        "max_tasks_per_day": getattr(config.scheduler, "max_tasks_per_day", 5),
        "high_energy_start_hour": config.scheduler.high_energy_start_hour,
        "high_energy_end_hour": config.scheduler.high_energy_end_hour,
    }

@app.post("/api/config")
async def update_config(req: ScheduleSettingsRequest, background_tasks: BackgroundTasks):
    config.scheduler.active_days = req.active_days
    config.scheduler.work_start_hour = req.work_start_hour
    config.scheduler.work_end_hour = req.work_end_hour
    config.scheduler.buffer_minutes = req.buffer_minutes
    config.scheduler.max_tasks_per_day = req.max_tasks_per_day
    config.scheduler.high_energy_start_hour = req.high_energy_start_hour
    config.scheduler.high_energy_end_hour = req.high_energy_end_hour
    
    settings_dict = {
        "active_days": req.active_days,
        "work_start_hour": req.work_start_hour,
        "work_end_hour": req.work_end_hour,
        "buffer_minutes": req.buffer_minutes,
        "max_tasks_per_day": req.max_tasks_per_day,
        "high_energy_start_hour": req.high_energy_start_hour,
        "high_energy_end_hour": req.high_energy_end_hour,
    }
    daemon_service.db.save_setting("scheduler_settings", settings_dict)
    save_config(config)
    logger.info("Updated schedule settings & saved to SQLite DB + config.yaml")
    
    daemon_service.gservices.invalidate_cache()
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Schedule configuration updated successfully", "config": get_config()}

@app.get("/api/plan")
async def get_plan():
    raw_tasks = daemon_service.gservices.fetch_tasks()
    now = datetime.now()
    fixed_events = daemon_service.gservices.fetch_fixed_events(now, now)
    
    tasks = []
    for t in raw_tasks:
        t.deferred_until = daemon_service.db.get_deferred_until(t.id)
        tasks.append(t)

    estimated_tasks = [daemon_service.ai.estimate_task(t) for t in tasks]
    plan = daemon_service.scheduler.solve(estimated_tasks, fixed_events)

    return {
        "status": daemon_service.status.model_dump(mode="json"),
        "tasks": [t.model_dump(mode="json") for t in estimated_tasks],
        "schedule": plan.model_dump(mode="json"),
        "config": get_config(),
    }

@app.post("/api/tasks")
async def add_task(req: AddTaskRequest, background_tasks: BackgroundTasks):
    import uuid
    new_task = Task(
        id=f"gtask-{uuid.uuid4().hex[:8]}",
        title=req.title,
        notes=req.notes or "",
        list_name=config.google.tasks_list_name,
        priority_raw=req.priority_raw or 0,
    )
    daemon_service.gservices.add_custom_task(new_task)
    logger.info(f"Added task: '{req.title}'")
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Task added successfully", "task": new_task.model_dump(mode="json")}

@app.post("/api/tasks/{task_id}/priority")
async def update_task_priority(task_id: str, req: PriorityOverrideRequest, background_tasks: BackgroundTasks):
    prio = max(1, min(10, req.priority_score))
    daemon_service.db.save_priority_override(task_id, prio)
    logger.info(f"Updated task '{task_id}' priority to P{prio}")
    
    daemon_service.gservices.invalidate_cache()
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": f"Task priority updated to P{prio}", "task_id": task_id, "priority_score": prio}

@app.post("/api/tasks/{task_id}/defer")
async def defer_task(task_id: str, days: int = Query(default=1), background_tasks: BackgroundTasks = None):
    until_date = (datetime.now() + timedelta(days=days)).date()
    daemon_service.db.defer_task(task_id, until_date)
    logger.info(f"Snoozed task '{task_id}' for {days} days (until {until_date})")
    
    daemon_service.gservices.invalidate_cache()
    if background_tasks:
        background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": f"Task snoozed for {days} days (until {until_date})", "task_id": task_id, "deferred_until": until_date.isoformat()}

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
    
    daemon_service.gservices.mark_task_complete(req.task_id)
    daemon_service.gservices._custom_tasks = [
        t for t in daemon_service.gservices._custom_tasks if t.id != req.task_id
    ]
    
    background_tasks.add_task(daemon_service.run_sync_cycle, True)
    return {"message": "Task completion recorded & reschedule triggered", "record": record.model_dump(mode="json")}

# Serve Fridge UI static files
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    uvicorn.run("main:app", host=host, port=port, reload=True)
