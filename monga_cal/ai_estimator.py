import os
import hashlib
import json
import logging
import time
from typing import Optional, List, Dict, Any
from google import genai
from google.genai import types
from monga_cal.models import Task, EstimationResult
from monga_cal.db import Database
from monga_cal.config import config

logger = logging.getLogger(__name__)

_last_gemini_rate_limit_time = 0.0
GEMINI_BACKOFF_SECONDS = 300

class AIEstimator:
    def __init__(self, db: Optional[Database] = None):
        self.db = db or Database(config.daemon.db_path)
        self.api_key = config.ai.api_key
        self.model_name = config.ai.model_name
        self.client = None
        if self.api_key:
            try:
                self.client = genai.Client(api_key=self.api_key)
            except Exception as e:
                logger.warning(f"Could not initialize Gemini Client: {e}")

    def _get_content_hash(self, task: Task) -> str:
        data = f"{task.id}|{task.title}|{task.notes or ''}|{task.priority_raw}"
        return hashlib.sha256(data.encode("utf-8")).hexdigest()

    def estimate_task(self, task: Task) -> Task:
        global _last_gemini_rate_limit_time
        
        content_hash = self._get_content_hash(task)
        cached = self.db.get_cached_estimate(content_hash)
        
        if cached and "estimated_minutes" in cached:
            task.estimated_minutes = cached["estimated_minutes"]
            task.priority_score = cached["priority_score"]
            task.energy = cached.get("energy_level", "medium")
            task.manager_directive = cached.get("manager_directive", "Standard priority work block.")
            
            override_prio = self.db.get_priority_override(task.id)
            if override_prio is not None:
                task.priority_score = override_prio
            return task

        now_time = time.time()
        in_backoff = (now_time - _last_gemini_rate_limit_time) < GEMINI_BACKOFF_SECONDS

        if self.client and not in_backoff:
            try:
                history = self.db.get_recent_completion_history(config.ai.history_limit)
                history_text = "\n".join(
                    [
                        f"- Task '{h['title']}': Manager assigned {h['estimated_minutes']}m, actually took {h['actual_minutes']}m"
                        for h in history
                    ]
                ) if history else "No past completion history."

                due_str = task.due.strftime("%Y-%m-%d %H:%M") if task.due else "No due date"

                prompt = f"""
You are an AI Executive Workload Manager.
Evaluate this pending user task and assign:
1. Exact duration in minutes (estimated_minutes, between 15 and 240).
2. Priority score from 1 (highest/urgent) to 10 (lowest priority) (priority_score). Note: P1 is urgent/top priority, P10 is lowest.
3. Required energy level: 'high' (deep focus), 'medium' (standard work), or 'low' (quick admin/errands) (energy_level).
4. Coaching Note (manager_directive): A 1 sentence directive for completing this task.

Task Title: "{task.title}"
Notes: "{task.notes or ''}"
Due Date: {due_str}

User Past Completion Velocity:
{history_text}
"""
                logger.info(f"Hitting Gemini API for NEW task '{task.title}' (Content Hash: {content_hash[:8]})...")
                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=EstimationResult,
                        temperature=0.2,
                    ),
                )

                if response.text:
                    parsed_json = json.loads(response.text)
                    estimated_min = int(parsed_json.get("estimated_minutes", config.ai.default_duration_minutes))
                    priority_score = int(parsed_json.get("priority_score", config.ai.default_priority))
                    energy = str(parsed_json.get("energy_level", "medium")).lower()
                    manager_directive = str(parsed_json.get("manager_directive", "Standard priority work block."))

                    estimate_dict = {
                        "estimated_minutes": estimated_min,
                        "priority_score": priority_score,
                        "energy_level": energy,
                        "manager_directive": manager_directive,
                    }
                    self.db.save_cached_estimate(content_hash, estimate_dict)

                    task.estimated_minutes = estimated_min
                    task.priority_score = priority_score
                    task.energy = energy
                    task.manager_directive = manager_directive
                    
                    override_prio = self.db.get_priority_override(task.id)
                    if override_prio is not None:
                        task.priority_score = override_prio
                    return task

            except Exception as e:
                err_str = str(e)
                if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                    logger.warning(f"Gemini API 429 Rate Limit hit. Entering {GEMINI_BACKOFF_SECONDS}s backoff period.")
                    _last_gemini_rate_limit_time = now_time
                else:
                    logger.error(f"Gemini AI Manager error for '{task.title}': {e}")

        logger.info(f"Applying & caching heuristic estimate for task '{task.title}'")
        self._apply_fallback(task)
        
        estimate_dict = {
            "estimated_minutes": task.estimated_minutes,
            "priority_score": task.priority_score,
            "energy_level": task.energy,
            "manager_directive": task.manager_directive,
        }
        self.db.save_cached_estimate(content_hash, estimate_dict)

        override_prio = self.db.get_priority_override(task.id)
        if override_prio is not None:
            task.priority_score = override_prio

        return task

    def _apply_fallback(self, task: Task):
        title_lower = task.title.lower()
        if any(w in title_lower for w in ["call", "email", "buy", "order", "clean", "pay"]):
            task.estimated_minutes = 20
            task.energy = "low"
            task.manager_directive = "Quick administrative task."
            task.priority_score = 3
        elif any(w in title_lower for w in ["tax", "code", "report", "write", "design", "study", "passport"]):
            task.estimated_minutes = 60
            task.energy = "high"
            task.manager_directive = "High cognitive effort required."
            task.priority_score = 1
        else:
            task.estimated_minutes = 30
            task.energy = "medium"
            task.manager_directive = "Standard priority work block."
            task.priority_score = 5
