import os
import json
import time
import logging
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
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
        self.auth_error: Optional[str] = None
        self._active_flow: Optional[InstalledAppFlow] = None
        self._code_verifier: Optional[str] = None
        
        try:
            self.tz_info = ZoneInfo(config.google.timezone)
        except Exception:
            self.tz_info = ZoneInfo("UTC")

        self._connected = False
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

    def _authenticate(self, force: bool = False):
        if self._connected and self.creds and self.creds.valid and not force:
            return

        self.auth_error = None
        if os.path.exists("token.json"):
            try:
                self.creds = Credentials.from_authorized_user_file("token.json", SCOPES)
            except Exception as e:
                logger.warning(f"Failed to load token.json: {e}")
                self.auth_error = f"Failed to load token.json: {e}"

        if self.creds and not self.creds.valid:
            if self.creds.expired and self.creds.refresh_token:
                try:
                    self.creds.refresh(Request())
                    with open("token.json", "w") as token:
                        token.write(self.creds.to_json())
                    self.auth_error = None
                except Exception as e:
                    logger.warning(f"Failed to refresh OAuth token: {e}")
                    self.auth_error = f"OAuth token expired or revoked ({e}). Please re-authenticate."
                    self.creds = None
                    try:
                        if os.path.exists("token.json"):
                            os.rename("token.json", "token.json.expired")
                    except Exception:
                        pass
            else:
                self.auth_error = "OAuth token invalid or missing refresh token."
                self.creds = None
        elif not self.creds:
            self.auth_error = "No token.json found. Please authenticate with Google."

        if self.creds and self.creds.valid:
            try:
                self.tasks_service = build("tasks", "v1", credentials=self.creds)
                self.calendar_service = build("calendar", "v3", credentials=self.creds)
                self._connected = True
                self.auth_error = None
                logger.info("Connected to Google Tasks & Google Calendar APIs successfully.")
            except Exception as e:
                logger.error(f"Error building Google API clients: {e}")
                self._connected = False
                self.auth_error = f"Error connecting to Google APIs: {e}"
        else:
            self._connected = False

    def get_authorization_url(self, redirect_uri: str) -> Optional[str]:
        if not os.path.exists("credentials.json"):
            logger.error("credentials.json not found in workspace root.")
            return None

        try:
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES, redirect_uri=redirect_uri)
            auth_url, state = flow.authorization_url(prompt="consent", access_type="offline", include_granted_scopes="true")
            self._active_flow = flow
            self._code_verifier = getattr(flow, "code_verifier", None)

            state_data = {
                "code_verifier": self._code_verifier,
                "redirect_uri": redirect_uri,
                "state": state,
                "created_at": time.time()
            }
            try:
                with open(".oauth_state.json", "w") as f:
                    json.dump(state_data, f)
            except Exception as ex:
                logger.warning(f"Failed to persist .oauth_state.json: {ex}")

            logger.info("Generated Google OAuth authorization URL with persisted PKCE verifier.")
            return auth_url
        except Exception as e:
            logger.error(f"Error generating OAuth authorization URL: {e}")
            return None

    def complete_oauth_flow(self, code: str, redirect_uri: Optional[str] = None) -> bool:
        if not os.path.exists("credentials.json"):
            logger.error("credentials.json not found in workspace root.")
            return False

        try:
            saved_verifier = self._code_verifier
            saved_redirect_uri = redirect_uri or "http://localhost:8000/api/auth/callback"

            if os.path.exists(".oauth_state.json"):
                try:
                    with open(".oauth_state.json", "r") as f:
                        saved_state = json.load(f)
                        saved_verifier = saved_state.get("code_verifier") or saved_verifier
                        saved_redirect_uri = saved_state.get("redirect_uri") or saved_redirect_uri
                except Exception as ex:
                    logger.warning(f"Failed to load .oauth_state.json: {ex}")

            flow = self._active_flow
            if not flow:
                flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES, redirect_uri=saved_redirect_uri)
            elif saved_redirect_uri:
                flow.redirect_uri = saved_redirect_uri

            if saved_verifier:
                flow.code_verifier = saved_verifier

            flow.fetch_token(code=code)
            self.creds = flow.credentials
            with open("token.json", "w") as token:
                token.write(self.creds.to_json())

            try:
                if os.path.exists(".oauth_state.json"):
                    os.remove(".oauth_state.json")
            except Exception:
                pass

            self.invalidate_cache()
            self._authenticate(force=True)
            logger.info("Successfully re-authenticated with Google OAuth and saved fresh token.json!")
            return self._connected
        except Exception as e:
            logger.error(f"Error completing OAuth flow: {e}")
            self.auth_error = f"Failed to exchange OAuth code: {e}"
            return False

    def add_custom_task(self, task: Task) -> str:
        self.invalidate_cache()
        if not self._connected:
            self._authenticate()

        if not self._connected or not self.tasks_service:
            logger.error(f"Cannot add task '{task.title}': Google Tasks API is not connected ({self.auth_error})")
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
            return task.id

    def get_or_create_monga_list_id(self) -> str:
        if self.tasks_list_id:
            return self.tasks_list_id

        if not self._connected:
            self._authenticate()

        if not self._connected or not self.tasks_service:
            logger.error(f"Cannot get/create Google Tasks list: Google API not connected ({self.auth_error})")
            return "@default"

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

        if not self._connected:
            self._authenticate()

        if not self._connected or not self.tasks_service:
            logger.error(f"Cannot fetch Google Tasks: Google API not connected ({self.auth_error})")
            return []

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
            return []

        return tasks

    def sync_completed_tasks_from_google(self, db) -> int:
        if not self._connected:
            self._authenticate()

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

        if not self._connected:
            self._authenticate()

        if not self._connected or not self.calendar_service:
            logger.error(f"Cannot fetch Google Calendar events: Google API not connected ({self.auth_error})")
            return []

        slots: List[CalendarSlot] = []
        try:
            t_min_dt = datetime.combine(start_dt.date(), datetime.min.time()).replace(tzinfo=self.tz_info)
            t_max_dt = datetime.combine(end_dt.date(), datetime.max.time()).replace(tzinfo=self.tz_info)

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

                        if dtstart.tzinfo:
                            dtstart = dtstart.astimezone(self.tz_info).replace(tzinfo=None)
                        else:
                            dtstart = datetime.combine(dtstart.date(), datetime.min.time())

                        if dtend.tzinfo:
                            dtend = dtend.astimezone(self.tz_info).replace(tzinfo=None)
                        else:
                            dtend = datetime.combine(dtend.date(), datetime.max.time())

                        slots.append(
                            CalendarSlot(
                                start=dtstart,
                                end=dtend,
                                is_fixed=True,
                                title=summary or "Calendar Event",
                                event_uid=event.get("id"),
                            )
                        )
                    except Exception as ex:
                        logger.warning(f"Error parsing fixed event '{summary}': {ex}")

            self._events_cache = slots
            self._events_cache_key = cache_key
            self._events_cache_time = now_time
            logger.info(f"Successfully fetched {len(slots)} fixed events from Google Calendar.")
        except Exception as e:
            logger.error(f"Error fetching Google Calendar events: {e}")
            return []

        return slots

    def sync_scheduled_blocks(self, blocks: List[ScheduledBlock]) -> bool:
        """NATIVE GOOGLE API BATCH SYNC: Combines all differential operations into rate-limited chunks."""
        if not self._connected:
            self._authenticate()

        if not self._connected or not self.calendar_service:
            logger.error(f"Cannot sync schedule blocks to Google Calendar: Google API not connected ({self.auth_error})")
            return False

        t0 = time.time()
        try:
            start_search = (datetime.now(self.tz_info) - timedelta(days=1)).isoformat()
            end_search = (datetime.now(self.tz_info) + timedelta(days=14)).isoformat()

            events_result = self.calendar_service.events().list(
                calendarId=config.google.calendar_id,
                timeMin=start_search,
                timeMax=end_search,
                singleEvents=True,
            ).execute()

            existing_events = events_result.get("items", [])
            existing_by_task_id: Dict[str, Dict[str, Any]] = {}
            for ev in existing_events:
                priv = ev.get("extendedProperties", {}).get("private", {})
                t_id = priv.get("monga_task_id")
                summary = ev.get("summary", "")
                if t_id:
                    existing_by_task_id[t_id] = ev
                elif summary.startswith(MONGA_BLOCK_PREFIX):
                    existing_by_task_id[summary] = ev

            tasks_to_run = []
            matched_task_ids = set()

            for b in blocks:
                summary = f"{MONGA_BLOCK_PREFIX}{b.task_title}"
                matched_task_ids.add(b.task_id)
                existing_ev = existing_by_task_id.get(b.task_id) or existing_by_task_id.get(summary)

                event_body = {
                    "summary": summary,
                    "description": f"Scheduled by Monga Cal AI.\nPriority Score: {b.priority_score}\nEnergy: {b.energy}\nDirective: {b.manager_directive}",
                    "start": {
                        "dateTime": b.start.isoformat(),
                        "timeZone": config.google.timezone
                    },
                    "end": {
                        "dateTime": b.end.isoformat(),
                        "timeZone": config.google.timezone
                    },
                    "extendedProperties": {
                        "private": {
                            "monga_task_id": b.task_id,
                            "monga_block": "true"
                        }
                    }
                }

                if existing_ev:
                    ex_id = existing_ev["id"]
                    ex_start = existing_ev.get("start", {}).get("dateTime", "")
                    ex_end = existing_ev.get("end", {}).get("dateTime", "")

                    if ex_start.startswith(b.start.isoformat()[:16]) and ex_end.startswith(b.end.isoformat()[:16]):
                        continue
                    else:
                        tasks_to_run.append(("patch", ex_id, event_body))
                else:
                    tasks_to_run.append(("insert", None, event_body))

            for key, ev in existing_by_task_id.items():
                priv = ev.get("extendedProperties", {}).get("private", {})
                t_id = priv.get("monga_task_id")
                if t_id and t_id not in matched_task_ids:
                    tasks_to_run.append(("delete", ev["id"], None))

            if not tasks_to_run:
                logger.info(f"Differential Batch Sync: All {len(blocks)} blocks up to date on Google Calendar. (0 API calls made in {round(time.time() - t0, 3)}s)")
                return True

            def batch_callback(request_id, response, exception):
                if exception is not None:
                    logger.warning(f"Batch request #{request_id} error: {exception}")

            chunk_size = 5
            for i in range(0, len(tasks_to_run), chunk_size):
                chunk = tasks_to_run[i:i + chunk_size]
                batch = self.calendar_service.new_batch_http_request(callback=batch_callback)
                for idx, (op_type, ev_id, body) in enumerate(chunk):
                    if op_type == "insert":
                        req = self.calendar_service.events().insert(calendarId=config.google.calendar_id, body=body)
                    elif op_type == "patch":
                        req = self.calendar_service.events().patch(calendarId=config.google.calendar_id, eventId=ev_id, body=body)
                    elif op_type == "delete":
                        req = self.calendar_service.events().delete(calendarId=config.google.calendar_id, eventId=ev_id)
                    batch.add(req, request_id=str(i + idx))
                batch.execute()
                if i + chunk_size < len(tasks_to_run):
                    time.sleep(0.3)

            logger.info(f"Native Google API Batch Sync: Executed {len(tasks_to_run)} operations for {len(blocks)} blocks in {round(time.time() - t0, 3)}s.")
            return True
        except Exception as e:
            logger.error(f"Error executing native Google API batch sync: {e}")
            return False

    def mark_task_complete(self, task_id: str) -> bool:
        self.invalidate_cache()
        if not self._connected:
            self._authenticate()

        if not self._connected or not self.tasks_service:
            logger.error(f"Cannot mark task complete: Google API not connected ({self.auth_error})")
            return False

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

gservices_manager = GoogleServicesManager()
