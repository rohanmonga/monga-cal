const API_BASE = '';

let currentTasks = [];
let currentSchedule = { blocks: [], unscheduled_task_ids: [], solver_stats: {} };
let currentConfig = { active_days: [0, 1, 2, 3, 4], work_start_hour: 10, work_end_hour: 17, buffer_minutes: 10, max_tasks_per_day: 3 };
let completingTaskId = null;
let currentTab = 'schedule';

document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initEventListeners();
  fetchPlan();
  fetchHistory();
  setInterval(() => {
    if (currentTab === 'schedule') fetchPlan();
    else if (currentTab === 'history') fetchHistory();
  }, 30000);
});

function switchTab(tabName) {
  currentTab = tabName;
  const scheduleBtn = document.getElementById('tabScheduleBtn');
  const historyBtn = document.getElementById('tabHistoryBtn');
  const scheduleView = document.getElementById('tabScheduleView');
  const historyView = document.getElementById('tabHistoryView');

  if (tabName === 'schedule') {
    scheduleBtn.classList.add('active');
    historyBtn.classList.remove('active');
    scheduleView.classList.add('active');
    historyView.classList.remove('active');
    fetchPlan();
  } else if (tabName === 'history') {
    historyBtn.classList.add('active');
    scheduleBtn.classList.remove('active');
    historyView.classList.add('active');
    scheduleView.classList.remove('active');
    fetchHistory();
  }
}

function initClock() {
  const clockTime = document.getElementById('clockTime');
  const clockDate = document.getElementById('clockDate');

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

async function fetchHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/history`);
    if (!res.ok) throw new Error('Failed to fetch history');
    const data = await res.json();
    renderHistoryView(data.history || [], data.summary || {});
  } catch (err) {
    console.error('Error fetching history:', err);
  }
}

function renderHistoryView(historyItems, summary) {
  const metricCompleted = document.getElementById('metricTotalCompleted');
  const metricLogged = document.getElementById('metricTotalLogged');
  const metricEstimated = document.getElementById('metricTotalEstimated');
  const metricVariance = document.getElementById('metricVariance');
  const historyCardsGrid = document.getElementById('historyCardsGrid');

  if (metricCompleted) metricCompleted.textContent = summary.total_completed || 0;
  if (metricLogged) metricLogged.textContent = `${summary.total_actual_hours || 0}h`;
  if (metricEstimated) metricEstimated.textContent = `${summary.total_estimated_hours || 0}h`;
  if (metricVariance) {
    const varH = summary.variance_hours || 0;
    metricVariance.textContent = varH >= 0 ? `+${varH}h` : `${varH}h`;
    metricVariance.style.color = varH > 0 ? '#dc2626' : (varH < 0 ? '#10b981' : 'inherit');
  }

  if (!historyCardsGrid) return;
  historyCardsGrid.innerHTML = '';

  if (historyItems.length === 0) {
    historyCardsGrid.innerHTML = `<div style="text-align:center; padding: 30px; color: var(--text-muted); font-size: 13.5px;">No completed task records logged yet.</div>`;
    return;
  }

  historyItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'card-item';

    const dtComp = item.completed_at ? new Date(item.completed_at) : new Date();
    const dateFormatted = dtComp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    card.innerHTML = `
      <div class="card-left-time" style="min-width: 80px;">✓<br>${dateFormatted.split(',')[0]}</div>
      <div class="card-title-text">
        <div class="card-title-main">${escapeHtml(item.title)}</div>
        <div style="font-size: 11.5px; font-weight: 500; color: var(--text-muted); margin-top: 2px;">
          Completed at ${dateFormatted} • Est: ${item.estimated_minutes}m
        </div>
      </div>
      <div class="card-right-controls">
        <span style="font-size: 12px; font-weight: 700; color: var(--text-muted);">Logged:</span>
        <input type="number" class="log-hours-input" id="logInput_${item.id}" value="${item.actual_minutes}" min="0">
        <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">m</span>
        <button class="btn-save-log" onclick="updateLoggedTime(${item.id})">Save</button>
      </div>
    `;

    historyCardsGrid.appendChild(card);
  });
}

async function updateLoggedTime(recordId) {
  const inputEl = document.getElementById(`logInput_${recordId}`);
  if (!inputEl) return;
  const actualMinutes = parseInt(inputEl.value, 10) || 0;

  try {
    const res = await fetch(`${API_BASE}/api/history/${recordId}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actual_minutes: actualMinutes })
    });
    if (!res.ok) throw new Error('Failed to update logged time');
    fetchHistory();
  } catch (err) {
    console.error('Error updating logged time:', err);
  }
}

function renderGanttChart() {
  const ganttTracks = document.getElementById('ganttTracks');
  const ganttTimeScale = document.getElementById('ganttTimeScale');
  if (!ganttTracks || !ganttTimeScale) return;

  const allBlocks = currentSchedule.blocks || [];
  const todayStr = new Date().toISOString().split('T')[0];
  const todayBlocks = allBlocks.filter(b => b.start.startsWith(todayStr));

  ganttTracks.innerHTML = '';
  ganttTimeScale.innerHTML = '';

  if (todayBlocks.length === 0) {
    ganttTracks.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-muted); font-size: 13px;">No task blocks scheduled for today.</div>`;
    ganttTracks.style.height = '60px';
    return;
  }

  let minStart = Math.min(...todayBlocks.map(b => new Date(b.start).getTime()));
  let maxEnd = Math.max(...todayBlocks.map(b => new Date(b.end).getTime()));

  const dtMin = new Date(minStart);
  const dtMax = new Date(maxEnd);

  let startHour = Math.max(0, dtMin.getHours() - 1);
  let endHour = Math.min(24, dtMax.getHours() + 2);
  if (endHour - startHour < 4) endHour = Math.min(24, startHour + 4);

  const totalMinutes = (endHour - startHour) * 60;

  for (let h = startHour; h <= endHour; h += 1) {
    const timeLabel = document.createElement('span');
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    timeLabel.textContent = `${displayHour}:00 ${ampm}`;
    ganttTimeScale.appendChild(timeLabel);
  }

  const tracks = [];
  todayBlocks.forEach(b => {
    const bStart = new Date(b.start).getTime();
    let placedTrack = -1;
    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
      const lastInTrack = tracks[tIdx][tracks[tIdx].length - 1];
      if (new Date(lastInTrack.end).getTime() <= bStart) {
        placedTrack = tIdx;
        tracks[tIdx].push(b);
        break;
      }
    }

    if (placedTrack === -1) {
      tracks.push([b]);
    }
  });

  const trackHeight = 56;
  ganttTracks.style.height = `${tracks.length * trackHeight + 10}px`;

  const pastels = ['pastel-blue', 'pastel-peach', 'pastel-sage'];
  let colorIdx = 0;

  tracks.forEach((trackBlocks, tIdx) => {
    trackBlocks.forEach(b => {
      const dtStart = new Date(b.start);
      const dtEnd = new Date(b.end);

      const startMinutes = (dtStart.getHours() - startHour) * 60 + dtStart.getMinutes();
      const durationMinutes = (dtEnd - dtStart) / (1000 * 60);

      const leftPercent = Math.max(0, Math.min(96, (startMinutes / totalMinutes) * 100));
      const widthPercent = Math.max(12, Math.min(100 - leftPercent, (durationMinutes / totalMinutes) * 100));

      const pastelClass = pastels[colorIdx % pastels.length];
      colorIdx++;

      const card = document.createElement('div');
      card.className = `gantt-block-card ${pastelClass}`;
      card.style.left = `${leftPercent}%`;
      card.style.width = `${widthPercent}%`;
      card.style.top = `${tIdx * trackHeight}px`;

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
  });
}

function renderWorkloadAgenda() {
  const agendaTimeline = document.getElementById('agendaTimeline');
  const agendaTaskCount = document.getElementById('agendaTaskCount');
  if (!agendaTimeline) return;

  const blocks = currentSchedule.blocks || [];
  const unscheduledIds = currentSchedule.unscheduled_task_ids || [];
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));

  const todayStr = new Date().toISOString().split('T')[0];

  // 1. Today's scheduled blocks
  const todayBlocks = blocks.filter(b => b.start.startsWith(todayStr));
  const scheduledToday = todayBlocks.map(b => ({
    block: b,
    task: taskMap.get(b.task_id) || { id: b.task_id, title: b.task_title, priority_score: b.priority_score, manager_directive: b.manager_directive, category: b.category }
  }));

  // 2. Scheduled blocks for future days
  const futureBlocks = blocks.filter(b => !b.start.startsWith(todayStr));
  const upcomingScheduled = futureBlocks.map(b => ({
    block: b,
    task: taskMap.get(b.task_id) || { id: b.task_id, title: b.task_title, priority_score: b.priority_score, manager_directive: b.manager_directive, category: b.category }
  }));

  // 3. Unscheduled or snoozed tasks
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
    agendaTaskCount.textContent = `${scheduledToday.length} tasks scheduled today (Max: ${currentConfig.max_tasks_per_day || 3})`;
  }

  agendaTimeline.innerHTML = '';

  // Render Today's Scheduled Tasks
  scheduledToday.forEach(item => {
    const card = createAgendaCard(item.task, item.block);
    agendaTimeline.appendChild(card);
  });

  // Render Upcoming Scheduled Queue
  if (upcomingScheduled.length > 0) {
    const catTitle = document.createElement('div');
    catTitle.className = 'agenda-category-title';
    catTitle.innerHTML = `<span>🗓️</span> Upcoming Scheduled Queue (${upcomingScheduled.length})`;
    agendaTimeline.appendChild(catTitle);

    upcomingScheduled.forEach(item => {
      const card = createAgendaCard(item.task, item.block);
      agendaTimeline.appendChild(card);
    });
  }

  // Render Deferred Queued Tasks
  if (queuedTasks.length > 0) {
    const catTitle = document.createElement('div');
    catTitle.className = 'agenda-category-title';
    catTitle.innerHTML = `<span>⏳</span> Queued / Deferred (${queuedTasks.length})`;
    agendaTimeline.appendChild(catTitle);

    queuedTasks.forEach(t => {
      const card = createAgendaCard(t, null);
      agendaTimeline.appendChild(card);
    });
  }

  // Render Snoozed Tasks
  if (snoozedTasks.length > 0) {
    const catTitle = document.createElement('div');
    catTitle.className = 'agenda-category-title';
    catTitle.innerHTML = `<span>🌙</span> Snoozed (${snoozedTasks.length})`;
    agendaTimeline.appendChild(catTitle);

    snoozedTasks.forEach(t => {
      const card = createAgendaCard(t, null);
      agendaTimeline.appendChild(card);
    });
  }
}

function getCategoryIcon(catName) {
  catName = (catName || 'general').toLowerCase();
  const icons = {
    urgent: '🚨',
    errands: '🚗',
    car: '🔧',
    admin: '📋',
    tech: '💻',
    general: '📌',
  };
  return icons[catName] || icons.general;
}

function createAgendaCard(task, block) {
  const card = document.createElement('div');
  const catName = (task.category || (block ? block.category : 'general')).toLowerCase();
  card.className = `card-item category-${catName}`;

  let timeHtml = `<div class="card-left-time">--:--<br>--:--</div>`;
  if (block) {
    const dtStart = new Date(block.start);
    const dtEnd = new Date(block.end);
    const dateFormatted = dtStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const fmtTime = (d) => {
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      h = h % 12 || 12;
      return `${h}:${m}`;
    };

    const isToday = dtStart.toDateString() === new Date().toDateString();
    if (isToday) {
      timeHtml = `<div class="card-left-time">${fmtTime(dtStart)}<br>${fmtTime(dtEnd)}</div>`;
    } else {
      timeHtml = `<div class="card-left-time" style="font-size:10.5px;">${dateFormatted}<br>${fmtTime(dtStart)}-${fmtTime(dtEnd)}</div>`;
    }
  } else if (task.deferred_until) {
    timeHtml = `<div class="card-left-time">🌙<br>${task.deferred_until}</div>`;
  }

  let rawPrio = task.priority_score || 3;
  if (rawPrio > 5) {
    rawPrio = 3;
  }
  rawPrio = Math.max(1, Math.min(5, rawPrio));
  let prioClass = `p${rawPrio}`;

  const directiveText = task.manager_directive || (block ? block.manager_directive : '');
  const directiveSubHtml = directiveText && directiveText !== 'Standard priority focus block.' 
    ? `<div class="card-subtitle-directive">💡 ${escapeHtml(directiveText)}</div>`
    : '';

  const catIcon = getCategoryIcon(catName);

  card.innerHTML = `
    ${timeHtml}
    <div class="card-title-text">
      <div class="card-title-main">
        <span class="title-icon-prefix">${catIcon}</span>
        <span>${escapeHtml(task.title)}</span>
      </div>
      ${directiveSubHtml}
    </div>
    <div class="card-right-controls">
      <button class="btn-direct-snooze" onclick="deferTaskDirect('${task.id}', 1)" title="Snooze Tomorrow">🌙 Tomorrow</button>
      
      <select class="prio-select-dropdown ${prioClass}" onchange="updateTaskPriority('${task.id}', this.value)">
        <option value="1" ${rawPrio === 1 ? 'selected' : ''}>P1 (ASAP)</option>
        <option value="2" ${rawPrio === 2 ? 'selected' : ''}>P2 (High)</option>
        <option value="3" ${rawPrio === 3 ? 'selected' : ''}>P3 (Regular)</option>
        <option value="4" ${rawPrio === 4 ? 'selected' : ''}>P4 (Next Week)</option>
        <option value="5" ${rawPrio === 5 ? 'selected' : ''}>P5 (Tracking)</option>
      </select>

      <button class="btn-complete-circle" onclick="openCompletionModal('${task.id}', '${escapeHtml(task.title)}', ${task.estimated_minutes || 30})" title="Complete Task">✓</button>
    </div>
  `;

  return card;
}

async function updateTaskPriority(taskId, prio) {
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${taskId}/priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority_score: parseInt(prio, 10) })
    });
    if (!res.ok) throw new Error('Failed to update priority');
    fetchPlan();
  } catch (err) {
    console.error('Error updating priority:', err);
  }
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
    fetchHistory();
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
  document.getElementById('workStartHourInput').value = currentConfig.work_start_hour || 10;
  document.getElementById('workEndHourInput').value = currentConfig.work_end_hour || 17;
  document.getElementById('bufferMinutesInput').value = currentConfig.buffer_minutes || 10;
  document.getElementById('maxTasksPerDayInput').value = currentConfig.max_tasks_per_day || 3;

  const activeDays = currentConfig.active_days || [0, 1, 2, 3, 4];
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
