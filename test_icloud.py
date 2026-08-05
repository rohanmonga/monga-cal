import sys
import logging
from config import config
from icloud_client import ICloudClient

logging.basicConfig(level=logging.INFO)

print("=" * 60)
print("   Monga Cal — iCloud CalDAV Connection Test")
print("=" * 60)

if not config.icloud.username or not config.icloud.password:
    print("\n❌ iCloud credentials are not configured in your .env file!")
    print("\nTo connect your real Apple Reminders & Calendar:")
    print("1. Go to https://appleid.apple.com")
    print("2. Navigate to 'App-Specific Passwords' and generate a password.")
    print("3. Add your email & app password to '/Users/rohanmonga/dev/git/monga-cal/.env':")
    print("   ICLOUD_USERNAME=your_email@icloud.com")
    print("   ICLOUD_PASSWORD=xxxx-xxxx-xxxx-xxxx")
    sys.exit(1)

print(f"\nAttempting CalDAV connection for user: {config.icloud.username}...")
client = ICloudClient()
connected = client.connect()

if not connected:
    print("\n❌ Failed to connect to iCloud CalDAV. Please verify your username & App-Specific Password.")
    sys.exit(1)

print("\n✅ Successfully connected to iCloud CalDAV!")
print("\nFetching pending tasks from Apple Reminders list 'Reminders'...")
tasks = client.fetch_tasks()

print(f"\nFound {len(tasks)} tasks in list 'Reminders':")
for i, t in enumerate(tasks, 1):
    print(f" {i}. [{t.id}] {t.title} (Apple Priority: {t.priority_raw}, Due: {t.due})")

print("\n" + "=" * 60)
