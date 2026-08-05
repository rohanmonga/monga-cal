import subprocess
import json

script = '''
tell application "Reminders"
    set out to {}
    repeat with l in lists
        set lName to name of l
        repeat with r in (reminders of l whose completed is false)
            set rName to name of r
            set rId to id of r
            set rNotes to body of r
            if rNotes is missing value then set rNotes to ""
            set end of out to lName & "|||" & rId & "|||" & rName & "|||" & rNotes
        end repeat
    end repeat
    return out
end tell
'''

def get_mac_reminders():
    try:
        res = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)
        if res.returncode == 0:
            lines = res.stdout.strip().split(", ")
            print(f"Found {len(lines)} raw items in macOS Reminders:")
            for line in lines:
                print(" ->", line)
        else:
            print("Error running osascript:", res.stderr)
    except Exception as e:
        print("Exception:", e)

if __name__ == "__main__":
    get_mac_reminders()
