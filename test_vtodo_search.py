import caldav
from config import config

client = caldav.DAVClient(
    url=config.icloud.caldav_url,
    username=config.icloud.username,
    password=config.icloud.password
)

principal = client.principal()
calendars = principal.calendars()

print(f"Scanning {len(calendars)} collections for VTODO / Reminders...")
for cal in calendars:
    name = cal.get_display_name() or cal.name
    print(f"\nChecking Collection: '{name}' ({cal.url})")
    try:
        todos = cal.todos()
        print(f"  -> Found {len(todos)} todos via .todos()")
        for t in todos:
            print(f"     Task raw: {t.data}")
    except Exception as e:
        print(f"  -> error calling .todos(): {e}")
        try:
            # try search for VTODO
            results = cal.search(event=False, todo=True)
            print(f"  -> Found {len(results)} todos via search(todo=True)")
            for r in results:
                print(f"     Task: {r.icalendar_instance}")
        except Exception as e2:
            print(f"  -> error searching todo: {e2}")
