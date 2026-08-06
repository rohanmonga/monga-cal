from datetime import datetime, date
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

class CalendarSlot(BaseModel):
    start: datetime
    end: datetime
    is_fixed: bool = True
    title: Optional[str] = ""
    event_uid: Optional[str] = None

class Task(BaseModel):
    id: str
    title: str
    notes: Optional[str] = ""
    list_name: str = "Monga Cal"
    due: Optional[datetime] = None
    completed: bool = False
    priority_raw: int = 0
    estimated_minutes: Optional[int] = 30
    priority_score: int = Field(default=3, description="1 (ASAP), 2 (High), 3 (Regular), 4 (Due Next Week), 5 (Tracking)")
    energy: str = "medium"
    manager_directive: str = "Standard priority focus block."
    flexible: bool = True
    created_at: Optional[datetime] = None
    deferred_until: Optional[date] = None

class EstimationResult(BaseModel):
    estimated_minutes: int = 30
    priority_score: int = 3
    energy: str = "medium"
    manager_directive: str = "Standard priority focus block."
    flexible: bool = True

class ScheduledBlock(BaseModel):
    task_id: str
    task_title: str
    start: datetime
    end: datetime
    estimated_minutes: int
    priority_score: int
    energy: str
    manager_directive: str
    event_uid: Optional[str] = None

class SchedulePlan(BaseModel):
    blocks: List[ScheduledBlock] = Field(default_factory=list)
    unscheduled_task_ids: List[str] = Field(default_factory=list)
    solver_stats: Dict[str, Any] = Field(default_factory=dict)
    generated_at: datetime = Field(default_factory=datetime.utcnow)

class TaskCompletionRecord(BaseModel):
    task_id: str
    title: str
    estimated_minutes: int
    actual_minutes: int
    completed_at: datetime = Field(default_factory=datetime.utcnow)

class SyncStatus(BaseModel):
    last_poll_time: Optional[datetime] = None
    last_reschedule_time: Optional[datetime] = None
    tasks_count: int = 0
    scheduled_blocks_count: int = 0
    status: str = "idle"
    last_error: Optional[str] = None

class ScheduleSettingsRequest(BaseModel):
    active_days: List[int]
    work_start_hour: int
    work_end_hour: int
    buffer_minutes: int
    max_tasks_per_day: int
    high_energy_start_hour: int
    high_energy_end_hour: int
