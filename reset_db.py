import sqlite3
import os

db_path = "monga_cal.db"
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM estimate_cache")
    cursor.execute("DELETE FROM plan_history")
    cursor.execute("DELETE FROM task_history")
    conn.commit()
    conn.close()
    print("Successfully cleared all test tasks and caches from SQLite database.")
