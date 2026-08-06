import json
import hashlib
import logging
from typing import List, Optional

try:
    from google import genai
except ImportError:
    genai = None

from monga_cal.models import Task, EstimationResult
from monga_cal.db import Database
from monga_cal.config import config

logger = logging.getLogger(__name__)

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

    def estimate_task(self, task: Task) -> Task:
        content_hash = self._hash_task(task)
        cached = self.db.get_cached_estimate(content_hash)
        if cached:
            prio = cached.get("priority_score", 3)
            if prio > 5:
                prio = 3
            task.estimated_minutes = cached.get("estimated_minutes", 30)
            task.priority_score = max(1, min(5, prio))
            task.energy = cached.get("energy_level", "medium")
            task.manager_directive = cached.get("manager_directive", "Standard priority focus block.")
            task.flexible = True
            return task

        history = self.db.get_recent_completion_history(limit=config.ai.history_limit)
        history_summary = "\n".join([
            f"- '{h['title']}': estimated {h['estimated_minutes']}m, took {h['actual_minutes']}m"
            for h in history
        ]) if history else "No completion history yet."

        prompt = f"""You are an executive workload manager AI. Estimate the required duration and priority for this task based on user history.

Task Title: "{task.title}"
Task Notes: "{task.notes}"
Priority (Raw): {task.priority_raw}

User Task Completion History:
{history_summary}

Respond ONLY with a valid JSON object matching this exact schema:
{{
  "estimated_minutes": <int, e.g. 15, 30, 45, 60, 90, 120>,
  "priority_score": <int 1-5 where 1=ASAP, 2=High, 3=Regular, 4=Next Week, 5=Tracking>,
  "energy_level": <string, "high" | "medium" | "low">,
  "manager_directive": <string, 1 brief sentence justifying the estimate>,
  "flexible": <boolean, true if can be rescheduled>
}}
"""

        if not self.client:
            task.estimated_minutes = task.estimated_minutes or config.ai.default_duration_minutes
            prio = task.priority_score or config.ai.default_priority
            if prio > 5:
                prio = 3
            task.priority_score = max(1, min(5, prio))
            return task

        try:
            response = self.client.models.generate_content(
                model=config.ai.model_name,
                contents=prompt,
            )
            data = json.loads(response.text)
            
            prio = int(data.get("priority_score", 3))
            if prio > 5:
                prio = 3
            prio = max(1, min(5, prio))

            res_dict = {
                "estimated_minutes": int(data.get("estimated_minutes", 30)),
                "priority_score": prio,
                "energy_level": str(data.get("energy_level", "medium")).lower(),
                "manager_directive": str(data.get("manager_directive", "AI estimated task parameters.")),
                "reasoning": "AI estimated"
            }

            self.db.save_cached_estimate(content_hash, res_dict)

            task.estimated_minutes = res_dict["estimated_minutes"]
            task.priority_score = res_dict["priority_score"]
            task.energy = res_dict["energy_level"]
            task.manager_directive = res_dict["manager_directive"]
            task.flexible = bool(data.get("flexible", True))
            return task

        except Exception as e:
            logger.error(f"Gemini API estimation error for task '{task.title}': {e}. Using fallback values.")
            task.estimated_minutes = task.estimated_minutes or config.ai.default_duration_minutes
            prio = task.priority_score or config.ai.default_priority
            if prio > 5:
                prio = 3
            task.priority_score = max(1, min(5, prio))
            return task
