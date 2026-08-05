import subprocess

applescript = '''
tell application "Reminders"
    set listNames to name of every list
    set res to ""
    repeat with lName in listNames
        set l to list lName
        set remNames to name of every reminder of l whose completed is false
        set res to res & "LIST:" & lName & "\n"
        repeat with rName in remNames
            set res to res & "  - " & rName & "\n"
        end repeat
    end repeat
    return res
end tell
'''

def main():
    print("=" * 60)
    print(" Fetching all Apple Reminders from macOS Reminders App...")
    print("=" * 60)
    try:
        proc = subprocess.run(["osascript", "-e", applescript], capture_output=True, text=True, timeout=8)
        if proc.returncode == 0:
            print(proc.stdout)
        else:
            print("AppleScript stderr:", proc.stderr)
    except subprocess.TimeoutExpired:
        print("\n⚠️ AppleScript timed out!")
        print("This happens when macOS shows a system permission dialog asking:")
        print("  'Terminal / Python wants access to Reminders' [Don't Allow] [OK]")
        print("Please check your Mac screen and click [OK] to allow access.")
    except Exception as e:
        print("Error:", e)

if __name__ == "__main__":
    main()
