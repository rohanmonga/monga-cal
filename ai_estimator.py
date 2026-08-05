import os
import hashlib
import json
import logging
from typing import Optional, List, Dict, Any
from google import genai
from google.genai import types
from models import Task, EstimationResult
from db import Database
from config import config

logger = logging.getLogger(__name__)

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
        data = f"{task.title}|{task.notes or ''}|{task.list_name}|{task.priority_raw}"
        return hashlib.sha256(data.encode("utf-8")).hexdigest()

    def estimate_task(self, task: Task) -> Task:
        """
        Acts as your AI Executive Manager: assigns duration, priority score,
        energy level, and a manager's directive using Gemini API and historical completion velocity.
        Check for user priority overrides first.
        """
        content_hash = self._get_content_hash(task)
        cached = self.db.get_cached_estimate(content_hash)
        
        if cached and "manager_directive" in cached:
            task.estimated_minutes = cached["estimated_minutes"]
            task.priority_score = cached["priority_score"]
            task.energy = cached["energy_level"]
            task.manager_directive = cached["manager_directive"]
        elif self.client:
            try:
                history = self.db.get_recent_completion_history(config.ai.history_limit)
                history_text = "\n".join(
                    [
                        f"- Task '{h['title']}': Manager assigned {h['estimated_minutes']}m, actually took {h['actual_minutes']}m"
                        for h in history
                    ]
                ) if history else "No past task completion history logged yet."

                due_str = task.due.strftime("%Y-%m-%d %H:%M") if task.due else "No due date"

                prompt = f"""
You are an elite, highly organized AI Executive Manager.
Your job is to manage the user's workload by evaluating their pending task and assigning:
1. Exact duration in minutes (estimated_minutes, between 15 and 240).
2. Priority score from 1 (lowest) to 10 (highest/urgent) (priority_score).
3. Required energy level: 'high' (deep focus/complex), 'medium' (standard work), or 'low' (quick admin/errands) (energy_level).
4. Direct Manager Coaching Note (manager_directive): A 1-2 sentence directive telling the user WHY this task is assigned this length and how to tackle it efficiently.

Task Title: "{task.title}"
Notes: "{task.notes or ''}"
Due Date: {due_str}

User's Past Completion Velocity:
{history_text}
"""
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
                    manager_directive = str(parsed_json.get("manager_directive", "Focus on completing this task in one uninterrupted block."))

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
            except Exception as e:
                logger.error(f"Gemini AI Manager error for '{task.title}': {e}")
                self._apply_fallback(task)
        else:
            self._apply_fallback(task)

        # Apply user custom priority override if present
        override_prio = self.db.get_priority_override(task.id)
        if override_prio is not None:
            task.priority_score = override_prio

        return task

    def _apply_fallback(self, task: Task):
        title_lower = task.title.lower()
        if any(w in title_lower for w in ["call", "email", "buy", "order", "clean"]):
            task.estimated_minutes = 20
            task.energy = "low"
            task.manager_directive = "Quick administrative task. Batch this with light errands."
        elif any(w in title_lower for w in ["tax", "code", "report", "write", "design", "study"]):
            task.estimated_minutes = 60
            task.energy = "high"
            task.manager_directive = "High cognitive effort required. Work in a single deep focus block."
        else:
            task.estimated_minutes = 30
            task.energy = "medium"
            task.manager_directive = "Standard priority work block. Stay focused until completion."

        task.priority_score = 5
