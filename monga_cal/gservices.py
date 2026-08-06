import os
import json
import time
import logging
from datetime import datetime, date, timedelta
from typing import List, Optional, Dict, Any
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from monga_cal.models import Task, CalendarSlot, ScheduledBlock, TaskCompletionRecord
from monga_cal.config import config

logger = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/calendar",
]

MONGA_BLOCK_PREFIX = "📌 "
CACHE_TTL_SECONDS = 60

class GoogleServicesManager:
    def __init__(self):
        self.creds = None
        self.tasks_service = None
        self.calendar_service = None
        self.tasks_list_id = None
        self.timezone = config.google.timezone
        self._connected = False

        self._custom_tasks: List[Task] = []
        self._tasks_cache: Optional[List[Task]] = None
        self._tasks_cache_time: float = 0.0
        self._events_cache: Optional[List[CalendarSlot]] = None
        self._events_cache_key: Optional[str] = None
        self._events_cache_time: float = 0.0

        self._authenticate()

    def invalidate_cache(self):
        self._tasks_cache = None
        self._events_cache = None
        self._events_cache_key = None

    def _authenticate(self):
        if os.path.exists("token.json"):
            try:
                self.creds = Credentials.from_authorized_user_file("token.json", SCOPES)
            except Exception as e:
                logger.warning(f"Failed to load token.json: {e}")

        if not self.creds or not self.creds.valid:
            if self.creds and self.creds.expired and self.creds.refresh_token:
                try:
                    self.creds.refresh(Request())
                    with open("token.json", "w") as token:
                        token.write(self.creds.to_json())
                except Exception as e:
                    logger.warning(f"Failed to refresh OAuth token: {e}")
                    self.creds = None

        if self.creds and self.creds.valid:
            try:
                self.tasks_service = build("tasks", "v1", credentials=self.creds)
                self.calendar_service = build("calendar", "v3", credentials=self.creds)
                self._connected = True
                logger.info("Connected to Google Tasks & Google Calendar APIs successfully.")
            except Exception as e:
                logger.error(f"Error building Google API clients: {e}")
                self._connected = False
        else:
            logger.warning("No valid Google OAuth credentials found. Operating in fallback mock mode.")
            self._connected = False

    def add_custom_task(self, task: Task) -> str:
        self.invalidate_cache()
        if not self._connected or not self.tasks_service:
            self._custom_tasks.append(task)
            return task.id

        list_id = self.get_or_create_monga_list_id()
        try:
            body = {
                "title": task.title,
                "notes": task.notes or "",
            }
            res = self.tasks_service.tasks().insert(tasklist=list_id, body=body).execute()
            new_id = res.get("id", task.id)
            logger.info(f"Created Google Task '{task.title}' with ID {new_id} in list '{config.google.tasks_list_name}'.")
            return new_id
        except Exception as e:
            logger.error(f"Error creating Google Task: {e}")
            self._custom_tasks.append(task)
            return task.id

    def get_or_create_monga_list_id(self) -> str:
        if self.tasks_list_id:
            return self.tasks_list_id

        if not self._connected or not self.tasks_service:
            return "mock-list-id"

        target_name = config.google.tasks_list_name
        try:
            results = self.tasks_service.tasklists().list().execute()
            items = results.get("items", [])
            for item in items:
                if item.get("title") == target_name:
                    self.tasks_list_id = item.get("id")
                    logger.info(f"Found dedicated Google Tasks list '{target_name}' (ID: {self.tasks_list_id})")
                    return self.tasks_list_id

            res = self.tasks_service.tasklists().insert(body={"title": target_name}).execute()
            self.tasks_list_id = res.get("id")
            logger.info(f"Created new dedicated Google Tasks list '{target_name}' (ID: {self.tasks_list_id})")
            return self.tasks_list_id
        except Exception as e:
            logger.error(f"Error finding/creating Google Tasks list '{target_name}': {e}")
            return "@default"

    def fetch_tasks(self) -> List[Task]:
        now_time = time.time()
        if self._tasks_cache is not None and (now_time - self._tasks_cache_time) < CACHE_TTL_SECONDS:
            logger.info(f"Returning cached Google Tasks ({len(self._tasks_cache)} tasks, age: {int(now_time - self._tasks_cache_time)}s)")
            return self._tasks_cache

        if not self._connected or not self.tasks_service:
            return self._custom_tasks or self._mock_tasks()

        list_id = self.get_or_create_monga_list_id()
        tasks: List[Task] = []
        try:
            results = self.tasks_service.tasks().list(
                tasklist=list_id,
                showCompleted=False,
                showHidden=False
            ).execute()

            items = results.get("items", [])
            for item in items:
                task_id = item.get("id")
                title = item.get("title", "Untitled Task")
                notes = item.get("notes", "")
                due_str = item.get("due")
                due_dt = None
                if due_str:
                    try:
                        due_dt = datetime.fromisoformat(due_str.replace("Z", "+00:00"))
                    except Exception:
                        pass

                tasks.append(
                    Task(
                        id=task_id,
                        title=title,
                        notes=notes,
                        list_name=config.google.tasks_list_name,
                        due=due_dt,
                        priority_raw=5,
                    )
                )
            logger.info(f"Fetched {len(tasks)} tasks from dedicated Google Tasks list '{config.google.tasks_list_name}'.")
            self._tasks_cache = tasks
            self._tasks_cache_time = now_time
        except Exception as e:
            logger.error(f"Error fetching Google Tasks from list '{config.google.tasks_list_name}': {e}")
            return self._custom_tasks or self._mock_tasks()

        return tasks

    def sync_completed_tasks_from_google(self, db) -> int:
        if not self._connected or not self.tasks_service:
            return 0

        list_id = self.get_or_create_monga_list_id()
        imported_count = 0
        try:
            results = self.tasks_service.tasks().list(
                tasklist=list_id,
                showCompleted=True,
                showHidden=True
            ).execute()

            items = results.get("items", [])
            for item in items:
                if item.get("status") == "completed":
                    task_id = item.get("id")
                    if task_id and not db.is_task_completed(task_id):
                        title = item.get("title", "Completed Task")
                        completed_str = item.get("completed")
                        comp_dt = datetime.now()
                        if completed_str:
                            try:
                                comp_dt = datetime.fromisoformat(completed_str.replace("Z", "+00:00"))
                            except Exception:
                                pass
                        
                        rec = TaskCompletionRecord(
                            task_id=task_id,
                            title=title,
                            estimated_minutes=30,
                            actual_minutes=30,
                            completed_at=comp_dt.replace(tzinfo=None) if comp_dt.tzinfo else comp_dt
                        )
                        db.record_completion(rec)
                        imported_count += 1
                        logger.info(f"Imported completed task from Google Tasks: '{title}' (ID: {task_id})")

        except Exception as e:
            logger.error(f"Error syncing completed tasks from Google Tasks: {e}")

        return imported_count

    def fetch_fixed_events(self, start_dt: datetime, end_dt: datetime) -> List[CalendarSlot]:
        now_time = time.time()
        cache_key = f"{config.google.calendar_id}_{start_dt.isoformat()}_{end_dt.isoformat()}"
        if self._events_cache is not None and self._events_cache_key == cache_key and (now_time - self._events_cache_time) < CACHE_TTL_SECONDS:
            logger.info(f"Returning cached Google Calendar events ({len(self._events_cache)} events)")
            return self._events_cache

        if not self._connected or not self.calendar_service:
            return self._mock_fixed_events(start_dt, end_dt)

        slots: List[CalendarSlot] = []
        try:
            t_min_dt = datetime.combine(start_dt.date(), datetime.min.time()).replace(tzinfo=self.timezone)
            t_max_dt = datetime.combine(end_dt.date(), datetime.max.time()).replace(tzinfo=self.timezone)

            events_result = self.calendar_service.events().list(
                calendarId=config.google.calendar_id,
                timeMin=t_min_dt.isoformat(),
                timeMax=t_max_dt.isoformat(),
                singleEvents=True,
                orderBy="startTime"
            ).execute()

            events = events_result.get("items", [])
            for event in events:
                summary = event.get("summary", "")
                if summary.startswith(MONGA_BLOCK_PREFIX) or "monga_block" in event.get("extendedProperties", {}).get("private", {}):
                    continue

                start = event.get("start", {}).get("dateTime") or event.get("start", {}).get("date")
                end = event.get("end", {}).get("dateTime") or event.get("end", {}).get("date")

                if start and end:
                    try:
                        dtstart = datetime.fromisoformat(start.replace("Z", "+00:00"))
                        dtend = datetime.fromisoformat(end.replace("Z", "+00:00"))
                        slots.append(
                            CalendarSlot(
                                start=dtstart,
                                end=dtend,
                                is_fixed=True,
                                title=summary,
                                event_uid=event.get("id"),
                            )
                        )
                    except Exception:
                        pass

            self._events_cache = slots
            self._events_cache_key = cache_key
            self._events_cache_time = now_time
        except Exception as e:
            logger.error(f"Error fetching Google Calendar events: {e}")
            return self._mock_fixed_events(start_dt, end_dt)

        return slots

    def sync_scheduled_blocks(self, blocks: List[ScheduledBlock]) -> bool:
        if not self._connected or not self.calendar_service:
            logger.info("Mock mode: skipping Google Calendar block sync.")
            return True

        try:
            start_search = datetime.now() - timedelta(days=1)
            end_search = datetime.now() + timedelta(days=7)

            events_result = self.calendar_service.events().list(
                calendarId=config.google.calendar_id,
                timeMin=start_search.isoformat() + "Z",
                timeMax=end_search.isoformat() + "Z",
                singleEvents=True,
            ).execute()

            existing_events = events_result.get("items", [])
            old_block_ids = []
            for ev in existing_events:
                summary = ev.get("summary", "")
                priv_props = ev.get("extendedProperties", {}).get("private", {})
                if summary.startswith(MONGA_BLOCK_PREFIX) or priv_props.get("monga_block") == "true":
                    old_block_ids.append(ev["id"])

            created_event_ids = []
            for b in blocks:
                summary = f"{MONGA_BLOCK_PREFIX}{b.task_title}"
                start_dt_local = b.start
                end_dt_local = b.end

                event_body = {
                    "summary": summary,
                    "description": f"Scheduled by Monga Cal AI.\nPriority Score: {b.priority_score}\nEnergy: {b.energy}\nDirective: {b.manager_directive}",
                    "start": {
                        "dateTime": start_dt_local.isoformat(),
                        "timeZone": config.google.timezone
                    },
                    "end": {
                        "dateTime": end_dt_local.isoformat(),
                        "timeZone": config.google.timezone
                    },
                    "extendedProperties": {
                        "private": {
                            "monga_task_id": b.task_id,
                            "monga_block": "true"
                        }
                    }
                }
                res = self.calendar_service.events().insert(
                    calendarId=config.google.calendar_id,
                    body=event_body
                ).execute()
                if res.get("id"):
                    created_event_ids.append(res["id"])

            deleted_count = 0
            for old_id in old_block_ids:
                if old_id not in created_event_ids:
                    try:
                        self.calendar_service.events().delete(
                            calendarId=config.google.calendar_id,
                            eventId=old_id
                        ).execute()
                        deleted_count += 1
                    except Exception as ex:
                        logger.warning(f"Error deleting old Google Calendar block {old_id}: {ex}")

            logger.info(f"Atomic Sync: Created {len(created_event_ids)} new blocks & purged {deleted_count} old blocks on Google Calendar.")
            return True
        except Exception as e:
            logger.error(f"Error syncing blocks to Google Calendar: {e}")
            return False

    def mark_task_complete(self, task_id: str) -> bool:
        self.invalidate_cache()
        if not self._connected or not self.tasks_service:
            return True

        list_id = self.get_or_create_monga_list_id()
        try:
            self.tasks_service.tasks().patch(
                tasklist=list_id,
                task=task_id,
                body={"status": "completed"}
            ).execute()
            logger.info(f"Marked task '{task_id}' complete in Google Tasks list '{config.google.tasks_list_name}'.")
            return True
        except Exception as e:
            logger.error(f"Error marking task complete in Google Tasks: {e}")
            return False

    def _mock_tasks(self) -> List[Task]:
        return []

    def _mock_fixed_events(self, start_dt: datetime, end_dt: datetime) -> List[CalendarSlot]:
        today_9am = datetime.combine(datetime.now().date(), datetime.min.time()).replace(hour=9)
        today_10am = today_9am + timedelta(hours=1)
        today_12pm = today_9am.replace(hour=12)
        today_1pm = today_12pm + timedelta(hours=1)

        return [
            CalendarSlot(
                start=today_9am,
                end=today_10am,
                is_fixed=True,
                title="Team Sync Meeting",
            ),
            CalendarSlot(
                start=today_12pm,
                end=today_1pm,
                is_fixed=True,
                title="Lunch Break",
            ),
        ]

gservices_manager = GoogleServicesManager()
