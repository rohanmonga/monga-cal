import os
import time
import logging
from datetime import datetime, date, timedelta
from typing import List, Optional, Dict, Any
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

from models import Task, CalendarSlot, ScheduledBlock
from config import config

logger = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/calendar",
]

MONGA_BLOCK_PREFIX = "BLOCK:"
CACHE_TTL_SECONDS = 60  # Cache Google API calls for 60 seconds

class GServicesClient:
    def __init__(self, creds_file: str = "credentials.json", token_file: str = "token.json"):
        self.creds_file = creds_file
        self.token_file = token_file
        self.creds: Optional[Credentials] = None
        self.tasks_service = None
        self.calendar_service = None
        self._custom_tasks: List[Task] = []
        self._connected = False
        self._target_list_id: Optional[str] = None

        # API Caching
        self._tasks_cache: Optional[List[Task]] = None
        self._tasks_cache_time: float = 0.0

        self._events_cache: Optional[List[CalendarSlot]] = None
        self._events_cache_key: str = ""
        self._events_cache_time: float = 0.0

    def invalidate_cache(self):
        """Invalidates task and event caches to force fresh API calls on mutations."""
        self._tasks_cache = None
        self._tasks_cache_time = 0.0
        self._events_cache = None
        self._events_cache_time = 0.0
        logger.info("Invalidated Google Services API cache.")

    def connect(self) -> bool:
        """Authenticate with Google OAuth2 for Google Tasks & Google Calendar APIs."""
        if os.path.exists(self.token_file):
            try:
                self.creds = Credentials.from_authorized_user_file(self.token_file, SCOPES)
            except Exception as e:
                logger.warning(f"Could not load token.json: {e}")

        if not self.creds or not self.creds.valid:
            if self.creds and self.creds.expired and self.creds.refresh_token:
                try:
                    self.creds.refresh(Request())
                except Exception as e:
                    logger.warning(f"Could not refresh Google token: {e}")
                    self.creds = None
            
            if not self.creds and os.path.exists(self.creds_file):
                try:
                    flow = InstalledAppFlow.from_client_secrets_file(self.creds_file, SCOPES)
                    logger.info("Starting Google OAuth login flow...")
                    self.creds = flow.run_local_server(port=0, open_browser=True)
                    with open(self.token_file, "w") as token:
                        token.write(self.creds.to_json())
                except Exception as e:
                    logger.error(f"Google OAuth flow error: {e}")
                    self.creds = None

        if self.creds and self.creds.valid:
            try:
                self.tasks_service = build("tasks", "v1", credentials=self.creds)
                self.calendar_service = build("calendar", "v3", credentials=self.creds)
                self._connected = True
                logger.info("Connected to Google Tasks & Google Calendar APIs successfully.")
                self.get_or_create_monga_list_id()
                return True
            except Exception as e:
                logger.error(f"Error building Google API services: {e}")

        logger.warning("Google Workspace credentials not configured. Operating in mock/custom task mode.")
        self._connected = False
        return False

    def get_or_create_monga_list_id(self) -> str:
        """Finds or creates the dedicated 'Monga Cal' task list in Google Tasks."""
        if self._target_list_id:
            return self._target_list_id

        if not self._connected or not self.tasks_service:
            return "@default"

        target_title = config.google.tasks_list_name
        try:
            lists_result = self.tasks_service.tasklists().list().execute()
            items = lists_result.get("items", [])
            
            for item in items:
                if item.get("title", "").strip().lower() == target_title.lower():
                    self._target_list_id = item.get("id")
                    logger.info(f"Found dedicated Google Tasks list '{target_title}' (ID: {self._target_list_id})")
                    return self._target_list_id

            logger.info(f"Creating new dedicated Google Tasks list named '{target_title}'...")
            new_list = self.tasks_service.tasklists().insert(body={"title": target_title}).execute()
            self._target_list_id = new_list.get("id")
            logger.info(f"Created dedicated Google Tasks list '{target_title}' (ID: {self._target_list_id})")
            return self._target_list_id
        except Exception as e:
            logger.error(f"Error finding/creating dedicated Google Tasks list: {e}")
            return "@default"

    def add_custom_task(self, task: Task):
        """Adds task to Google Tasks list 'Monga Cal'."""
        self.invalidate_cache()
        if self._connected and self.tasks_service:
            list_id = self.get_or_create_monga_list_id()
            try:
                task_body = {
                    "title": task.title,
                    "notes": task.notes or "",
                }
                res = self.tasks_service.tasks().insert(tasklist=list_id, body=task_body).execute()
                task.id = res.get("id")
                logger.info(f"Added new task '{task.title}' to Google Tasks list '{config.google.tasks_list_name}'")
            except Exception as e:
                logger.error(f"Error inserting task into Google Tasks API: {e}")

        self._custom_tasks = [t for t in self._custom_tasks if t.id != task.id]
        self._custom_tasks.append(task)

    def fetch_tasks(self) -> List[Task]:
        """Fetch pending tasks exclusively from the dedicated 'Monga Cal' Google Tasks list (with 60s TTL Cache)."""
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

    def fetch_fixed_events(self, start_dt: datetime, end_dt: datetime) -> List[CalendarSlot]:
        """Fetch fixed meetings from Primary Google Calendar (with 60s TTL Cache)."""
        now_time = time.time()
        cache_key = f"{start_dt.isoformat()}_{end_dt.isoformat()}"
        if self._events_cache is not None and self._events_cache_key == cache_key and (now_time - self._events_cache_time) < CACHE_TTL_SECONDS:
            logger.info(f"Returning cached Google Calendar events ({len(self._events_cache)} events)")
            return self._events_cache

        if not self._connected or not self.calendar_service:
            return self._mock_fixed_events(start_dt, end_dt)

        slots: List[CalendarSlot] = []
        try:
            time_min = start_dt.isoformat() + "Z"
            time_max = end_dt.isoformat() + "Z"

            events_result = self.calendar_service.events().list(
                calendarId=config.google.calendar_id,
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime"
            ).execute()

            events = events_result.get("items", [])
            for event in events:
                summary = event.get("summary", "")
                if summary.startswith(MONGA_BLOCK_PREFIX):
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

    def sync_scheduled_blocks(
        self, blocks: List[ScheduledBlock], start_dt: datetime, end_dt: datetime
    ) -> bool:
        """Pushes Manager-assigned task blocks to Primary Google Calendar."""
        if not self._connected or not self.calendar_service:
            logger.info(f"Mock mode: Syncing {len(blocks)} Manager blocks to Google Calendar.")
            return True

        try:
            time_min = start_dt.isoformat() + "Z"
            time_max = end_dt.isoformat() + "Z"

            events_result = self.calendar_service.events().list(
                calendarId=config.google.calendar_id,
                timeMin=time_min,
                timeMax=time_max,
                q=MONGA_BLOCK_PREFIX
            ).execute()

            for old_event in events_result.get("items", []):
                try:
                    self.calendar_service.events().delete(
                        calendarId=config.google.calendar_id,
                        eventId=old_event["id"]
                    ).execute()
                except Exception as ex:
                    logger.warning(f"Error deleting old Google Calendar block: {ex}")

            for b in blocks:
                summary = f"{MONGA_BLOCK_PREFIX} {b.task_title} (est {b.estimated_minutes}m) [P{b.priority_score}]"
                desc_text = f"📋 Manager Directive: {b.manager_directive or 'Focus block'}\n⚡ Energy: {b.energy} | Priority: P{b.priority_score}\nX-MONGA-TASK-UID:{b.task_id}"

                event_body = {
                    "summary": summary,
                    "description": desc_text,
                    "start": {"dateTime": b.start.isoformat(), "timeZone": "UTC"},
                    "end": {"dateTime": b.end.isoformat(), "timeZone": "UTC"},
                    "extendedProperties": {
                        "private": {
                            "monga_task_id": b.task_id,
                            "monga_block": "true"
                        }
                    }
                }
                self.calendar_service.events().insert(
                    calendarId=config.google.calendar_id,
                    body=event_body
                ).execute()

            logger.info(f"Successfully synced {len(blocks)} Manager blocks to Primary Google Calendar.")
            return True
        except Exception as e:
            logger.error(f"Error syncing blocks to Google Calendar: {e}")
            return False

    def mark_task_complete(self, task_id: str) -> bool:
        """Mark task as complete in Google Tasks."""
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
