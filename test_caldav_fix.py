import caldav
from config import config
from models import Task

client = caldav.DAVClient(
    url=config.icloud.caldav_url,
    username=config.icloud.username,
    password=config.icloud.password
)

principal = client.principal()
calendars = principal.calendars()

tasks = []
print("Searching iCloud CalDAV for Reminders...")

for cal in calendars:
    name = str(cal.get_display_name() or cal.name or "").strip()
    if name.lower().startswith("reminders"):
        print(f"Found matching Reminders list: '{name}'")
        try:
            results = cal.search(todo=True)
            for res in results:
                comp = res.icalendar_instance.walk("VTODO")[0]
                summary = str(comp.get("SUMMARY", "")).strip()
                status = str(comp.get("STATUS", "")).upper()
                
                # Filter out completed & Apple upgrade placeholder notice
                if status == "COMPLETED" or "upgraded these reminders" in summary:
                    continue

                uid = str(comp.get("UID", res.id))
                notes = str(comp.get("DESCRIPTION", ""))
                prio = int(comp.get("PRIORITY", 0) or 0)
                
                print(f" -> Real Task Found: '{summary}' (UID: {uid}, Priority: {prio})")
                tasks.append(Task(id=uid, title=summary, notes=notes, list_name="Reminders", priority_raw=prio))
        except Exception as e:
            print(f" Error searching list '{name}': {e}")

print(f"\nTotal Real Reminders Fetched: {len(tasks)}")
