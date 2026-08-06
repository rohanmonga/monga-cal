const API_BASE = '';

let currentTasks = [];
let currentSchedule = { blocks: [], unscheduled_task_ids: [], solver_stats: {} };
let currentConfig = { active_days: [0, 1, 2, 3, 4, 5, 6], work_start_hour: 8, work_end_hour: 21, buffer_minutes: 10, max_tasks_per_day: 5 };
let completingTaskId = null;

document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initEventListeners();
  fetchPlan();
  setInterval(fetchPlan, 30000);
});

function initClock() {
  const clockTime = document.getElementById('clockTime');
  const clockDate = document.getElementById('clockDate');
  const flowDateSub = document.getElementById('flowDateSub');

  function updateClock() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    
    if (clockTime) {
      clockTime.innerHTML = `${hours}:${minutes} <span class="clock-ampm">${ampm}</span>`;
    }

    const options = { weekday: 'long', month: 'short', day: 'numeric' };
    const dateStr = now.toLocaleDateString('en-US', options);
    
    let period = 'Morning';
    const h = now.getHours();
    if (h >= 12 && h < 17) period = 'Afternoon';
    else if (h >= 17 && h < 22) period = 'Evening';
    else if (h >= 22 || h < 5) period = 'Night';

    if (clockDate) {
      clockDate.textContent = `${dateStr} • ${period}`;
    }
    if (flowDateSub) {
      flowDateSub.textContent = dateStr;
    }
  }

  updateClock();
  setInterval(updateClock, 1000);
}

function initEventListeners() {
  const rescheduleBtn = document.getElementById('rescheduleBtn');
  const reSolveBottomBtn = document.getElementById('reSolveBottomBtn');
  if (rescheduleBtn) rescheduleBtn.addEventListener('click', triggerReschedule);
  if (reSolveBottomBtn) reSolveBottomBtn.addEventListener('click', triggerReschedule);

  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsModal = document.getElementById('settingsModal');

  if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => {
    populateSettingsForm();
    settingsModal.classList.add('active');
  });

  if (cancelSettingsBtn) cancelSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
  });

  if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);

  const dayChips = document.querySelectorAll('.day-chip');
  dayChips.forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  const openAddTaskBtn = document.getElementById('openAddTaskBtn');
  const cancelAddTaskBtn = document.getElementById('cancelAddTaskBtn');
  const saveAddTaskBtn = document.getElementById('saveAddTaskBtn');
  const addTaskModal = document.getElementById('addTaskModal');

  if (openAddTaskBtn) openAddTaskBtn.addEventListener('click', () => addTaskModal.classList.add('active'));
  if (cancelAddTaskBtn) cancelAddTaskBtn.addEventListener('click', () => addTaskModal.classList.remove('active'));
  if (saveAddTaskBtn) saveAddTaskBtn.addEventListener('click', saveAddTask);

  const cancelModalBtn = document.getElementById('cancelModalBtn');
  const confirmCompleteBtn = document.getElementById('confirmCompleteBtn');
  const completionModal = document.getElementById('completionModal');

  if (cancelModalBtn) cancelModalBtn.addEventListener('click', () => completionModal.classList.remove('active'));
  if (confirmCompleteBtn) confirmCompleteBtn.addEventListener('click', submitCompletion);

  const quickChips = document.querySelectorAll('.quick-chip');
  quickChips.forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('actualMinutesInput').value = chip.dataset.min;
    });
  });
}

async function fetchPlan() {
  try {
    const res = await fetch(`${API_BASE}/api/plan`);
    if (!res.ok) throw new Error('Failed to fetch plan');
    const data = await res.json();
    currentTasks = data.tasks || [];
    currentSchedule = data.schedule || { blocks: [], unscheduled_task_ids: [], solver_stats: {} };
    currentConfig = data.config || currentConfig;

    renderGanttChart();
    renderWorkloadAgenda();
  } catch (err) {
    console.error('Error fetching plan:', err);
  }
}

function renderGanttChart() {
  const ganttTracks = document.getElementById('ganttTracks');
  const ganttTimeScale = document.getElementById('ganttTimeScale');
  if (!ganttTracks || !ganttTimeScale) return;

  const blocks = currentSchedule.blocks || [];
  const startHour = currentConfig.work_start_hour || 8;
  const endHour = currentConfig.work_end_hour || 21;
  const totalMinutes = (endHour - startHour) * 60;

  ganttTimeScale.innerHTML = '';
  for (let h = startHour; h <= endHour; h += 2) {
    const timeLabel = document.createElement('span');
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    timeLabel.textContent = `${displayHour}:00 ${ampm}`;
    ganttTimeScale.appendChild(timeLabel);
  }

  ganttTracks.innerHTML = '';
  if (blocks.length === 0) {
    ganttTracks.innerHTML = `<div style="text-align:center; padding: 24px; color: var(--text-muted); font-size: 13px;">No task blocks scheduled for today.</div>`;
    return;
  }

  const pastels = ['pastel-blue', 'pastel-peach', 'pastel-sage'];

  blocks.forEach((b, idx) => {
    const dtStart = new Date(b.start);
    const dtEnd = new Date(b.end);

    const startMinutes = (dtStart.getHours() - startHour) * 60 + dtStart.getMinutes();
    const durationMinutes = (dtEnd - dtStart) / (1000 * 60);

    const leftPercent = Math.max(0, Math.min(100, (startMinutes / totalMinutes) * 100));
    const widthPercent = Math.max(8, Math.min(100 - leftPercent, (durationMinutes / totalMinutes) * 100));

    const pastelClass = pastels[idx % pastels.length];

    const card = document.createElement('div');
    card.className = `gantt-block-card ${pastelClass}`;
    card.style.left = `${leftPercent}%`;
    card.style.width = `${widthPercent}%`;
    card.style.top = '10px';

    const formatTime = (d) => {
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${m} ${ampm}`;
    };

    card.innerHTML = `
      <div class="block-time">${formatTime(dtStart)}</div>
      <div class="block-title">${escapeHtml(b.task_title)}</div>
    `;

    ganttTracks.appendChild(card);
  });
}

function renderWorkloadAgenda() {
  const agendaTimeline = document.getElementById('agendaTimeline');
  const agendaTaskCount = document.getElementById('agendaTaskCount');
  if (!agendaTimeline) return;

  const blocks = currentSchedule.blocks || [];
  const unscheduledIds = currentSchedule.unscheduled_task_ids || [];
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));

  const scheduledToday = blocks.map(b => ({
    block: b,
    task: taskMap.get(b.task_id) || { id: b.task_id, title: b.task_title, priority_score: b.priority_score }
  }));

  const queuedTasks = [];
  const snoozedTasks = [];

  unscheduledIds.forEach(id => {
    const t = taskMap.get(id);
    if (t) {
      if (t.deferred_until) snoozedTasks.push(t);
      else queuedTasks.push(t);
    }
  });

  if (agendaTaskCount) {
    agendaTaskCount.textContent = `${scheduledToday.length} tasks scheduled today`;
  }

  agendaTimeline.innerHTML = '';

  scheduledToday.forEach(item => {
    const card = createAgendaCard(item.task, item.block);
    agendaTimeline.appendChild(card);
  });

  if (queuedTasks.length > 0) {
    const catTitle = document.createElement('div');
    catTitle.className = 'agenda-category-title';
    catTitle.textContent = `Queued (${queuedTasks.length})`;
    agendaTimeline.appendChild(catTitle);

    queuedTasks.forEach(t => {
      const card = createAgendaCard(t, null);
      agendaTimeline.appendChild(card);
    });
  }

  if (snoozedTasks.length > 0) {
    const catTitle = document.createElement('div');
    catTitle.className = 'agenda-category-title';
    catTitle.textContent = `Snoozed (${snoozedTasks.length})`;
    agendaTimeline.appendChild(catTitle);

    snoozedTasks.forEach(t => {
      const card = createAgendaCard(t, null);
      agendaTimeline.appendChild(card);
    });
  }
}

function createAgendaCard(task, block) {
  const card = document.createElement('div');
  card.className = 'card-item';

  let timeHtml = `<div class="card-left-time">--:--<br>--:--</div>`;
  if (block) {
    const dtStart = new Date(block.start);
    const dtEnd = new Date(block.end);
    const fmt = (d) => {
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      h = h % 12 || 12;
      return `${h}:${m}`;
    };
    timeHtml = `<div class="card-left-time">${fmt(dtStart)}<br>${fmt(dtEnd)}</div>`;
  } else if (task.deferred_until) {
    timeHtml = `<div class="card-left-time">🌙<br>${task.deferred_until}</div>`;
  }

  let prioClass = 'p5';
  if (task.priority_score === 1) prioClass = 'p1';
  else if (task.priority_score >= 10) prioClass = 'p10';

  card.innerHTML = `
    ${timeHtml}
    <div class="card-title-text">${escapeHtml(task.title)}</div>
    <div class="card-right-controls">
      <button class="btn-direct-snooze" onclick="deferTaskDirect('${task.id}', 1)" title="Snooze Tomorrow">🌙 Tomorrow</button>
      <div class="prio-dot ${prioClass}" title="Priority P${task.priority_score}"></div>
      <button class="btn-complete-circle" onclick="openCompletionModal('${task.id}', '${escapeHtml(task.title)}', ${task.estimated_minutes || 30})" title="Complete Task">✓</button>
    </div>
  `;

  return card;
}

function openCompletionModal(taskId, title, estMin) {
  completingTaskId = taskId;
  document.getElementById('modalTaskTitle').textContent = title;
  document.getElementById('actualMinutesInput').value = estMin || 30;
  document.getElementById('completionModal').classList.add('active');
}

async function submitCompletion() {
  if (!completingTaskId) return;
  const actualMinutes = parseInt(document.getElementById('actualMinutesInput').value, 10) || 30;

  try {
    const res = await fetch(`${API_BASE}/api/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: completingTaskId,
        title: document.getElementById('modalTaskTitle').textContent,
        estimated_minutes: 30,
        actual_minutes: actualMinutes
      })
    });
    if (!res.ok) throw new Error('Failed to complete task');
    document.getElementById('completionModal').classList.remove('active');
    fetchPlan();
  } catch (err) {
    console.error('Error completing task:', err);
  }
}

async function deferTaskDirect(taskId, days) {
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}/defer?days=${days}`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to defer task');
    fetchPlan();
  } catch (err) {
    console.error('Error deferring task:', err);
  }
}

async function triggerReschedule() {
  try {
    const res = await fetch(`${API_BASE}/api/reschedule`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to reschedule');
    fetchPlan();
  } catch (err) {
    console.error('Error rescheduling:', err);
  }
}

async function saveAddTask() {
  const title = document.getElementById('newTaskTitleInput').value.trim();
  const notes = document.getElementById('newTaskNotesInput').value.trim();
  if (!title) return;

  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, notes })
    });
    if (!res.ok) throw new Error('Failed to add task');
    document.getElementById('newTaskTitleInput').value = '';
    document.getElementById('newTaskNotesInput').value = '';
    document.getElementById('addTaskModal').classList.remove('active');
    fetchPlan();
  } catch (err) {
    console.error('Error adding task:', err);
  }
}

function populateSettingsForm() {
  document.getElementById('workStartHourInput').value = currentConfig.work_start_hour || 8;
  document.getElementById('workEndHourInput').value = currentConfig.work_end_hour || 21;
  document.getElementById('bufferMinutesInput').value = currentConfig.buffer_minutes || 10;
  document.getElementById('maxTasksPerDayInput').value = currentConfig.max_tasks_per_day || 5;

  const activeDays = currentConfig.active_days || [0,1,2,3,4,5,6];
  document.querySelectorAll('.day-chip').forEach(chip => {
    const day = parseInt(chip.dataset.day, 10);
    if (activeDays.includes(day)) chip.classList.add('active');
    else chip.classList.remove('active');
  });
}

async function saveSettings() {
  const active_days = [];
  document.querySelectorAll('.day-chip.active').forEach(chip => {
    active_days.push(parseInt(chip.dataset.day, 10));
  });

  const payload = {
    active_days,
    work_start_hour: parseInt(document.getElementById('workStartHourInput').value, 10),
    work_end_hour: parseInt(document.getElementById('workEndHourInput').value, 10),
    buffer_minutes: parseInt(document.getElementById('bufferMinutesInput').value, 10),
    max_tasks_per_day: parseInt(document.getElementById('maxTasksPerDayInput').value, 10),
    high_energy_start_hour: 9,
    high_energy_end_hour: 12
  };

  try {
    const res = await fetch(`${API_BASE}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to save settings');
    document.getElementById('settingsModal').classList.remove('active');
    fetchPlan();
  } catch (err) {
    console.error('Error saving settings:', err);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, function(m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m];
  });
}
