import EventKit
import Foundation
import time

store = EventKit.EKEventStore.alloc().init()

def request_access():
    state = {"granted": False, "done": False}
    def callback(granted, error):
        state["granted"] = granted
        state["done"] = True

    store.requestAccessToEntityType_completion_(1, callback)
    
    start = time.time()
    while not state["done"] and (time.time() - start) < 5.0:
        Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(0.1))
        
    return state["granted"]

if __name__ == "__main__":
    print("Requesting EventKit access to Apple Reminders...")
    access = request_access()
    print(f"EventKit Reminders Access Granted: {access}")
    
    if access:
        calendars = store.calendarsForEntityType_(1) # EKEntityTypeReminder
        print(f"Found {len(calendars)} reminder lists in EventKit:")
        for c in calendars:
            print(f"\n - List: '{c.title()}'")
            
            predicate = store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(None, None, [c])
            res_holder = {"list": [], "fetched": False}
            
            def fetch_cb(rems):
                res_holder["list"] = list(rems) if rems else []
                res_holder["fetched"] = True
                
            store.fetchRemindersMatchingPredicate_completion_(predicate, fetch_cb)
            
            start = time.time()
            while not res_holder["fetched"] and (time.time() - start) < 3.0:
                Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(0.1))
                
            print(f"   --> Found {len(res_holder['list'])} pending reminders:")
            for r in res_holder["list"]:
                print(f"       • '{r.title()}' (notes: '{r.notes()}')")
