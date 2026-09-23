import os
import sys
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/calendar",
]

def main():
    if not os.path.exists("credentials.json"):
        print("❌ Error: credentials.json not found in project workspace root.")
        sys.exit(1)

    print("🔑 Opening browser for Google OAuth authentication...")
    flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
    creds = flow.run_local_server(port=0)
    
    with open("token.json", "w") as token:
        token.write(creds.to_json())
    print("✅ Successfully authenticated! Fresh credentials saved to token.json.")

if __name__ == "__main__":
    main()
