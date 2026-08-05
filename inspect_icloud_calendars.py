import caldav
from config import config

client = caldav.DAVClient(
    url=config.icloud.caldav_url,
    username=config.icloud.username,
    password=config.icloud.password
)

principal = client.principal()
calendars = principal.calendars()

print("=" * 60)
print(f" Found {len(calendars)} collections in iCloud for {config.icloud.username}:")
print("=" * 60)

for i, cal in enumerate(calendars, 1):
    print(f"\n{i}. Name: '{cal.name}' | URL: {cal.url}")
    try:
        # Check components supported or count items
        todos = cal.todos()
        print(f"   --> Contains {len(todos)} VTODO (Reminders)")
        for t in todos[:5]: # Print first 5
            try:
                comp = t.icalendar_instance.walk("VTODO")[0]
                summary = str(comp.get("SUMMARY", "No summary"))
                status = str(comp.get("STATUS", "NO_STATUS"))
                print(f"       • Task: '{summary}' (status: {status})")
            except Exception as ex:
                pass
    except Exception:
        try:
            events = cal.events()
            print(f"   --> Contains {len(events)} VEVENT (Calendar Events)")
        except Exception:
            pass

print("=" * 60)
