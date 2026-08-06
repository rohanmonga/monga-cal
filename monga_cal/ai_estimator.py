import json
import hashlib
import logging
from typing import List, Optional, Dict, Any

try:
    from google import genai
except ImportError:
    genai = None

from monga_cal.models import Task
from monga_cal.db import Database
from monga_cal.config import config

logger = logging.getLogger(__name__)

FALLBACK_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-pro",
]

CATEGORY_MAP = [
    ("urgent", "Urgent", "🚨", "red"),
    ("overdue", "Urgent", "⚠️", "red"),
    ("financial", "Finance", "💳", "red"),
    ("payment", "Finance", "💳", "red"),
    ("balance", "Finance", "💳", "red"),
    ("battery", "Car Maintenance", "🔋", "amber"),
    ("crv", "Car Maintenance", "🔧", "amber"),
    ("car", "Car Maintenance", "🔧", "amber"),
    ("vehicle", "Car Maintenance", "🚘", "amber"),
    ("costco", "Errands", "🚗", "purple"),
    ("ups", "Errands", "📦", "purple"),
    ("amazon", "Errands", "📦", "purple"),
    ("errand", "Errands", "🚗", "purple"),
    ("drop off", "Errands", "📦", "purple"),
    ("return", "Errands", "📦", "purple"),
    ("shipping", "Errands", "🚚", "purple"),
    ("passport", "Official / Admin", "🛂", "cyan"),
    ("zillow", "Finances & Admin", "🏠", "cyan"),
    ("usbank", "Banking", "🏦", "cyan"),
    ("bank", "Banking", "🏦", "cyan"),
    ("rewards", "Rewards", "🎁", "cyan"),
    ("admin", "Admin", "📋", "cyan"),
    ("official", "Admin", "📄", "cyan"),
    ("emulator", "Tech & Dev", "💻", "emerald"),
    ("dashboard", "Tech & Dev", "📱", "emerald"),
    ("tech", "Tech & Dev", "💻", "emerald"),
    ("setup", "Tech & Dev", "⚙️", "emerald"),
    ("campus", "School & Education", "🏫", "coral"),
    ("school", "School & Education", "🏫", "coral"),
    ("legoland", "Family & Trips", "🎟️", "coral"),
    ("education", "School & Education", "🎓", "coral"),
]

def resolve_category_preset(cat_str: str, icon_str: Optional[str] = None, title_str: str = "") -> tuple:
    combined = f"{cat_str} {title_str}".lower()
    
    for key, cname, cicon, cpreset in CATEGORY_MAP:
        if key in combined:
            return cname, (icon_str if (icon_str and icon_str != "📌") else cicon), cpreset
    
    return (cat_str.title() if cat_str else "General"), (icon_str or "📌"), "neutral"

class AIEstimator:
    def __init__(self, db: Database):
        self.db = db
        self.api_key = config.ai.api_key
        if self.api_key and genai:
            try:
                self.client = genai.Client(api_key=self.api_key)
            except Exception as e:
                logger.warning(f"Failed to initialize GenAI client: {e}")
                self.client = None
        else:
            self.client = None
            if not self.api_key:
                logger.warning("No GEMINI_API_KEY found. AI Estimator will fallback to default heuristics.")

    def _hash_task(self, task: Task) -> str:
        raw_str = f"{task.title}_{task.notes}_{task.priority_raw}"
        return hashlib.md5(raw_str.encode("utf-8")).hexdigest()

    def estimate_tasks_batch(self, tasks: List[Task]) -> List[Task]:
        """Performs 1 single batched Gemini API call for all uncached tasks with dynamic category discovery."""
        if not tasks:
            return []

        uncached_tasks: List[Task] = []
        task_hashes: Dict[str, str] = {}

        # 1. Load from DB cache first
        for t in tasks:
            chash = self._hash_task(t)
            task_hashes[t.id] = chash
            cached = self.db.get_cached_estimate(chash)
            if cached:
                prio = cached.get("priority_score", 3)
                if prio > 5:
                    prio = 3
                t.estimated_minutes = cached.get("estimated_minutes", 30)
                t.priority_score = max(1, min(5, prio))
                t.energy = cached.get("energy_level", "medium")

                cat_name, cat_icon, preset = resolve_category_preset(
                    cached.get("category", "General"),
                    cached.get("category_icon"),
                    t.title
                )
                t.category = cat_name
                t.category_icon = cat_icon
                t.color_preset = preset
                t.manager_directive = cached.get("manager_directive", "Standard priority focus block.")
                t.flexible = True
            else:
                uncached_tasks.append(t)

            # Explicit user priority overrides MUST take precedence over cached AI estimates
            saved_prio = self.db.get_priority_override(t.id)
            if saved_prio:
                t.priority_score = max(1, min(5, saved_prio))

        # If all tasks are cached, return immediately with zero API calls!
        if not uncached_tasks:
            logger.info(f"All {len(tasks)} tasks loaded from local DB estimation cache. (0 API calls made)")
            return tasks

        # 2. If Gemini client unavailable, apply fast fallback to uncached
        if not self.client:
            for t in uncached_tasks:
                t.estimated_minutes = t.estimated_minutes or config.ai.default_duration_minutes
                saved_prio = self.db.get_priority_override(t.id)
                prio = saved_prio if saved_prio else (t.priority_score or config.ai.default_priority)
                if prio > 5:
                    prio = 3
                t.priority_score = max(1, min(5, prio))
                cat_name, cat_icon, preset = resolve_category_preset(getattr(t, "title", ""), title_str=getattr(t, "title", ""))
                t.category = cat_name
                t.category_icon = cat_icon
                t.color_preset = preset
            return tasks

        # 3. Perform 1 SINGLE batched Gemini API call for all uncached tasks
        history = self.db.get_recent_completion_history(limit=config.ai.history_limit)
        history_summary = "\n".join([
            f"- '{h['title']}': estimated {h['estimated_minutes']}m, took {h['actual_minutes']}m"
            for h in history
        ]) if history else "No completion history yet."

        batch_payload = [
            {"task_id": t.id, "title": t.title, "notes": t.notes or ""}
            for t in uncached_tasks
        ]

        prompt = f"""You are an executive workload manager AI. Analyze this batch of tasks and estimate duration, priority, focus requirements, and auto-discover categories with specific emoji icons.

User Task Completion History:
{history_summary}

Tasks to Estimate (Batch):
{json.dumps(batch_payload, indent=2)}

Instructions for Categories & Icons:
Choose specific emoji icons matching the task (e.g. 🚗 for errands/driving, 🔧 for car maintenance, 📦 for shipping/packages, 🛂 for passport, 🏦 for banking, 💻 for tech, 🚨 for urgent/overdue, 🏫 for school/campus). Do NOT use generic pin 📌 if a specific emoji fits better!

Respond ONLY with a valid JSON array where each object matches this schema:
[
  {{
    "task_id": "<string matching input task_id>",
    "estimated_minutes": <int, e.g. 15, 30, 45, 60, 90, 120>,
    "priority_score": <int 1-5 where 1=ASAP, 2=High, 3=Regular, 4=Next Week, 5=Tracking>,
    "energy_level": <string, "high" | "medium" | "low">,
    "category": <string, e.g. "Errands", "Car Maintenance", "Banking", "Passport & Admin", "Tech & Dev", "School & Education">,
    "category_icon": <emoji string, e.g. "🚗", "📦", "🔧", "🛂", "🏦", "💻", "🚨", "🏫">,
    "manager_directive": <string, 1 crisp sentence justifying priority & focus slot>,
    "flexible": <boolean, true if can be rescheduled>
  }}
]
"""

        models_to_try = [config.ai.model_name] + [m for m in FALLBACK_MODELS if m != config.ai.model_name]
        response_text = None

        for model_candidate in models_to_try:
            try:
                logger.info(f"Sending 1 batched API request to Gemini ({model_candidate}) for {len(uncached_tasks)} tasks...")
                response = self.client.models.generate_content(
                    model=model_candidate,
                    contents=prompt,
                )
                if response and response.text:
                    response_text = response.text.strip()
                    logger.info(f"Successfully received batch AI estimations using model '{model_candidate}'")
                    break
            except Exception as ex:
                logger.warning(f"Model '{model_candidate}' failed: {ex}. Trying next candidate...")

        if not response_text:
            logger.error("All Gemini model candidates failed. Using default heuristic fallbacks.")
            for t in uncached_tasks:
                t.estimated_minutes = t.estimated_minutes or config.ai.default_duration_minutes
                saved_prio = self.db.get_priority_override(t.id)
                prio = saved_prio if saved_prio else (t.priority_score or config.ai.default_priority)
                if prio > 5:
                    prio = 3
                t.priority_score = max(1, min(5, prio))
                cat_name, cat_icon, preset = resolve_category_preset(getattr(t, "title", ""), title_str=getattr(t, "title", ""))
                t.category = cat_name
                t.category_icon = cat_icon
                t.color_preset = preset
            return tasks

        try:
            resp_text = response_text
            if resp_text.startswith("```json"):
                resp_text = resp_text.replace("```json", "").replace("```", "").strip()
            
            data_list = json.loads(resp_text)
            est_map = {item.get("task_id"): item for item in data_list if isinstance(item, dict)}

            for t in uncached_tasks:
                item = est_map.get(t.id, {})
                prio = int(item.get("priority_score", 3))
                if prio > 5:
                    prio = 3
                prio = max(1, min(5, prio))

                raw_cat = str(item.get("category", t.title))
                raw_icon = item.get("category_icon")
                cat_name, cat_icon, preset = resolve_category_preset(raw_cat, raw_icon, t.title)

                est_dict = {
                    "estimated_minutes": int(item.get("estimated_minutes", 30)),
                    "priority_score": prio,
                    "energy_level": str(item.get("energy_level", "medium")).lower(),
                    "category": cat_name,
                    "category_icon": cat_icon,
                    "color_preset": preset,
                    "manager_directive": str(item.get("manager_directive", "AI batch estimated focus block.")),
                    "reasoning": "Batch AI estimated"
                }

                chash = task_hashes[t.id]
                self.db.save_cached_estimate(chash, est_dict)

                t.estimated_minutes = est_dict["estimated_minutes"]
                
                # Explicit user priority override MUST take precedence over fresh AI estimate
                saved_prio = self.db.get_priority_override(t.id)
                if saved_prio:
                    t.priority_score = max(1, min(5, saved_prio))
                else:
                    t.priority_score = est_dict["priority_score"]

                t.energy = est_dict["energy_level"]
                t.category = est_dict["category"]
                t.category_icon = est_dict["category_icon"]
                t.color_preset = est_dict["color_preset"]
                t.manager_directive = est_dict["manager_directive"]
                t.flexible = bool(item.get("flexible", True))

            logger.info(f"Batch AI estimation & category discovery complete for {len(uncached_tasks)} tasks via 1 Gemini API call.")

        except Exception as e:
            logger.error(f"Error parsing Gemini batch response: {e}. Using fallback default values.")
            for t in uncached_tasks:
                t.estimated_minutes = t.estimated_minutes or config.ai.default_duration_minutes
                saved_prio = self.db.get_priority_override(t.id)
                prio = saved_prio if saved_prio else (t.priority_score or config.ai.default_priority)
                if prio > 5:
                    prio = 3
                t.priority_score = max(1, min(5, prio))
                cat_name, cat_icon, preset = resolve_category_preset(getattr(t, "title", ""), title_str=getattr(t, "title", ""))
                t.category = cat_name
                t.category_icon = cat_icon
                t.color_preset = preset

        return tasks

    def estimate_task(self, task: Task) -> Task:
        res = self.estimate_tasks_batch([task])
        return res[0] if res else task
