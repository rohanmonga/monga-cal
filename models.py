from datetime import datetime, date
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

class EstimationResult(BaseModel):
    estimated_minutes: int = 30
    priority_score: int = 5
    energy_level: str = "medium"
    manager_directive: str = "Standard priority work block."
    reasoning: Optional[str] = ""

class Task(BaseModel):
    id: str
    title: str
    notes: Optional[str] = ""
    list_name: str = "Google Tasks"
    due: Optional[datetime] = None
    completed: bool = False
    priority_raw: int = 0
    estimated_minutes: Optional[int] = None
    priority_score: int = 5
    energy: str = "medium"
    manager_directive: Optional[str] = ""
    flexible: bool = True
    created_at: Optional[datetime] = None
    deferred_until: Optional[date] = None

class CalendarSlot(BaseModel):
    start: datetime
    end: datetime
    is_fixed: bool = True
    title: str
    event_uid: Optional[str] = None

class ScheduledBlock(BaseModel):
    task_id: str
    task_title: str
    start: datetime
    end: datetime
    estimated_minutes: int
    priority_score: int = 5
    energy: str = "medium"
    manager_directive: Optional[str] = ""
    event_uid: Optional[str] = None

class SchedulePlan(BaseModel):
    blocks: List[ScheduledBlock] = Field(default_factory=list)
    unscheduled_task_ids: List[str] = Field(default_factory=list)
    solver_stats: Dict[str, Any] = Field(default_factory=dict)
    generated_at: datetime = Field(default_factory=datetime.now)

class TaskCompletionRecord(BaseModel):
    task_id: str
    title: str
    estimated_minutes: int
    actual_minutes: int
    completed_at: datetime = Field(default_factory=datetime.now)

class SyncStatus(BaseModel):
    last_poll_time: Optional[datetime] = None
    last_reschedule_time: Optional[datetime] = None
    tasks_count: int = 0
    scheduled_blocks_count: int = 0
    status: str = "idle"
    last_error: Optional[str] = None

class ScheduleSettingsRequest(BaseModel):
    active_days: List[int] = Field(default=[0, 1, 2, 3, 4, 5, 6]) # 0=Mon, 6=Sun
    work_start_hour: int = 8
    work_end_hour: int = 21
    buffer_minutes: int = 10
    high_energy_start_hour: int = 9
    high_energy_end_hour: int = 12
