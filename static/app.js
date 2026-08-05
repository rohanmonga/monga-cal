let activeTaskToComplete = null;
let currentConfig = {
  active_days: [0, 1, 2, 3, 4, 5, 6],
  work_start_hour: 8,
  work_end_hour: 21,
  buffer_minutes: 10,
  high_energy_start_hour: 9,
  high_energy_end_hour: 12
};

// Clock updates
function updateClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('clockTime').textContent = `${hours}:${minutes}`;

  const options = { weekday: 'short', month: 'short', day: 'numeric' };
  document.getElementById('clockDate').textContent = now.toLocaleDateString('en-US', options);
}
setInterval(updateClock, 1000);
updateClock();

// API calls
async function fetchPlan() {
  try {
    const res = await fetch('/api/plan');
    if (!res.ok) throw new Error('Failed to fetch plan');
    const data = await res.json();
    if (data.config) {
      currentConfig = data.config;
    }
    renderGanttChart(data.schedule);
    renderSchedule(data.schedule);
  } catch (err) {
    console.error(err);
    document.getElementById('agendaTimeline').innerHTML = '<div class="loading-state">Error connecting to Monga Cal server.</div>';
    document.getElementById('ganttTracks').innerHTML = '<div class="gantt-loading">Error connecting to Gantt Engine.</div>';
  }
}

// RENDER COMPACT GANTT CHART TIMELINE VIEW
function renderGanttChart(schedule) {
  const timeScaleEl = document.getElementById('ganttTimeScale');
  const tracksEl = document.getElementById('ganttTracks');
  const blocks = schedule?.blocks || [];

  const startHour = currentConfig.work_start_hour || 8;
  const endHour = currentConfig.work_end_hour || 21;
  const totalWorkMins = (endHour - startHour) * 60;

  // 1. Render Time Scale Ticks
  let timeScaleHtml = '';
  for (let h = startHour; h <= endHour; h++) {
    const timeLabel = `${String(h).padStart(2, '0')}:00`;
    timeScaleHtml += `<div class="gantt-hour-tick">${timeLabel}</div>`;
  }
  timeScaleEl.innerHTML = timeScaleHtml;

  if (blocks.length === 0) {
    tracksEl.innerHTML = '<div class="gantt-loading">No tasks scheduled on Gantt timeline today.</div>';
    return;
  }

  // 2. Render Current Time Red Indicator Bar
  const now = new Date();
  let nowIndicatorHtml = '';
  const nowHour = now.getHours() + (now.getMinutes() / 60);
  if (nowHour >= startHour && nowHour <= endHour) {
    const nowMinsFromStart = (nowHour - startHour) * 60;
    const nowPercent = Math.min(100, Math.max(0, (nowMinsFromStart / totalWorkMins) * 100));
    nowIndicatorHtml = `<div class="gantt-now-line" style="left: ${nowPercent}%;"></div>`;
  }

  // 3. Render Gantt Rows & Bars
  let tracksHtml = nowIndicatorHtml;

  blocks.forEach(b => {
    const dtStart = new Date(b.start);
    const dtEnd = new Date(b.end);

    const startMinsFromWork = ((dtStart.getHours() * 60) + dtStart.getMinutes()) - (startHour * 60);
    const durationMins = b.estimated_minutes || 30;

    const leftPercent = Math.min(100, Math.max(0, (startMinsFromWork / totalWorkMins) * 100));
    const widthPercent = Math.min(100 - leftPercent, Math.max(2, (durationMins / totalWorkMins) * 100));

    const timeRangeStr = `${dtStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${dtEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    tracksHtml += `
      <div class="gantt-row">
        <div class="gantt-row-label" title="${escapeHtml(b.task_title)}">${escapeHtml(b.task_title)}</div>
        <div class="gantt-track-area">
          <div class="gantt-block" style="left: ${leftPercent}%; width: ${widthPercent}%;" title="${escapeHtml(b.task_title)} (${timeRangeStr}) - P${b.priority_score}">
            <span>${escapeHtml(b.task_title)}</span>
            <span style="opacity: 0.85; font-size: 10.5px;">P${b.priority_score} | ${timeRangeStr}</span>
          </div>
        </div>
      </div>
    `;
  });

  tracksEl.innerHTML = tracksHtml;
}

// RENDER COMPACT AGENDA CARDS
function renderSchedule(schedule) {
  const timelineEl = document.getElementById('agendaTimeline');
  const blocks = schedule?.blocks || [];
  const stats = schedule?.solver_stats || {};

  document.getElementById('scheduleCountBadge').innerHTML = `<span class="dot-live"></span> ${blocks.length} Tasks Scheduled`;

  if (stats.engine) document.getElementById('solverEngine').textContent = stats.engine;
  if (stats.status) {
    const statusEl = document.getElementById('solverStatus');
    statusEl.textContent = stats.status;
    statusEl.className = stats.status === 'OPTIMAL' ? 'badge-status-green' : '';
  }
  if (stats.solve_time_sec !== undefined) {
    document.getElementById('solverTime').textContent = `${stats.solve_time_sec}s`;
  }
  if (stats.work_hours) {
    document.getElementById('solverHours').textContent = stats.work_hours;
  } else {
    document.getElementById('solverHours').textContent = `${currentConfig.work_start_hour}:00 - ${currentConfig.work_end_hour}:00`;
  }

  if (blocks.length === 0) {
    timelineEl.innerHTML = '<div class="loading-state">No tasks scheduled for today. Click <strong>+ Add Task</strong> above to add a task.</div>';
    return;
  }

  timelineEl.innerHTML = blocks.map(b => {
    const start = new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const end = new Date(b.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const prioOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p => `
      <option value="${p}" ${p === b.priority_score ? 'selected' : ''}>Priority P${p}</option>
    `).join('');

    return `
      <div class="card-item">
        <div class="card-main-row">
          <div class="card-left-group">
            <span class="time-pill">${start} - ${end}</span>
            <span class="card-task-title" title="${escapeHtml(b.task_title)}">${escapeHtml(b.task_title)}</span>
          </div>

          <div class="controls-group">
            <button class="btn-direct-snooze" onclick="deferTask('${b.task_id}', 1)">
              🌙 Tomorrow
            </button>
            <button class="btn-direct-snooze" onclick="deferTask('${b.task_id}', 7)">
              📅 Next Week
            </button>
            
            <select class="prio-select-pill" onchange="updatePriority('${b.task_id}', this.value)">
              ${prioOptions}
            </select>

            <span class="badge-tag badge-duration">⏱️ ${b.estimated_minutes}m</span>

            <button class="btn-complete-task" onclick="openCompletionModal('${b.task_id}', '${escapeJsStr(b.task_title)}', ${b.estimated_minutes})">
              ✓ Complete
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// VIEW TOGGLE LOGIC
document.getElementById('ganttViewBtn').addEventListener('click', () => {
  document.getElementById('ganttViewBtn').classList.add('active');
  document.getElementById('listViewBtn').classList.remove('active');
  document.querySelector('.gantt-section').style.display = 'block';
});

document.getElementById('listViewBtn').addEventListener('click', () => {
  document.getElementById('listViewBtn').classList.add('active');
  document.getElementById('ganttViewBtn').classList.remove('active');
  document.querySelector('.gantt-section').style.display = 'none';
});

// EDITABLE PRIORITY LOGIC
async function updatePriority(taskId, newPriority) {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority_score: parseInt(newPriority, 10) })
    });
    if (!res.ok) throw new Error('Failed to update priority');
    await fetchPlan();
  } catch (err) {
    alert('Error updating priority: ' + err.message);
  }
}

// DIRECT SNOOZE LOGIC
async function deferTask(taskId, days) {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/defer?days=${days}`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Failed to snooze task');
    await fetchPlan();
  } catch (err) {
    alert('Error snoozing task: ' + err.message);
  }
}

// SETTINGS MODAL LOGIC
document.getElementById('openSettingsBtn').addEventListener('click', () => {
  document.getElementById('workStartHourInput').value = currentConfig.work_start_hour;
  document.getElementById('workEndHourInput').value = currentConfig.work_end_hour;
  document.getElementById('bufferMinutesInput').value = currentConfig.buffer_minutes;
  document.getElementById('highEnergyStartInput').value = currentConfig.high_energy_start_hour;

  document.querySelectorAll('.day-chip').forEach(chip => {
    const day = parseInt(chip.dataset.day, 10);
    if (currentConfig.active_days.includes(day)) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  document.getElementById('settingsModal').classList.add('active');
});

document.querySelectorAll('.day-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('active');
  });
});

document.getElementById('cancelSettingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.remove('active');
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const active_days = [];
  document.querySelectorAll('.day-chip.active').forEach(chip => {
    active_days.push(parseInt(chip.dataset.day, 10));
  });

  const work_start_hour = parseInt(document.getElementById('workStartHourInput').value, 10) || 8;
  const work_end_hour = parseInt(document.getElementById('workEndHourInput').value, 10) || 21;
  const buffer_minutes = parseInt(document.getElementById('bufferMinutesInput').value, 10) || 10;
  const high_energy_start_hour = parseInt(document.getElementById('highEnergyStartInput').value, 10) || 9;

  const btn = document.getElementById('saveSettingsBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active_days,
        work_start_hour,
        work_end_hour,
        buffer_minutes,
        high_energy_start_hour,
        high_energy_end_hour: high_energy_start_hour + 3
      })
    });
    if (!res.ok) throw new Error('Failed to save settings');
    const data = await res.json();
    currentConfig = data.config;
    document.getElementById('settingsModal').classList.remove('active');
    await fetchPlan();
  } catch (err) {
    alert('Error saving settings: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Solve';
  }
});

// ADD TASK MODAL LOGIC
document.getElementById('openAddTaskBtn').addEventListener('click', () => {
  document.getElementById('newTaskTitleInput').value = '';
  document.getElementById('newTaskNotesInput').value = '';
  document.getElementById('addTaskModal').classList.add('active');
});

document.getElementById('cancelAddTaskBtn').addEventListener('click', () => {
  document.getElementById('addTaskModal').classList.remove('active');
});

document.getElementById('saveAddTaskBtn').addEventListener('click', async () => {
  const title = document.getElementById('newTaskTitleInput').value.trim();
  const notes = document.getElementById('newTaskNotesInput').value.trim();
  if (!title) {
    alert('Please enter a task title');
    return;
  }

  const btn = document.getElementById('saveAddTaskBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, notes })
    });
    document.getElementById('addTaskModal').classList.remove('active');
    await fetchPlan();
  } catch (err) {
    alert('Failed to add task: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Task';
  }
});

// RESHUFFLE BUTTON LOGIC
document.getElementById('rescheduleBtn').addEventListener('click', async () => {
  const btn = document.getElementById('rescheduleBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="icon">⚡</span> Solving...';
  try {
    await fetch('/api/reschedule', { method: 'POST' });
    await fetchPlan();
  } catch (err) {
    alert('Reshuffle failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="icon">⚡</span> Re-Solve';
  }
});

// COMPLETION MODAL LOGIC
function openCompletionModal(taskId, title, estMin) {
  activeTaskToComplete = { taskId, title, estMin };
  document.getElementById('modalTaskTitle').textContent = title;
  document.getElementById('actualMinutesInput').value = estMin;
  document.getElementById('completionModal').classList.add('active');
}

document.querySelectorAll('.quick-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('actualMinutesInput').value = btn.dataset.min;
  });
});

document.getElementById('cancelModalBtn').addEventListener('click', () => {
  document.getElementById('completionModal').classList.remove('active');
  activeTaskToComplete = null;
});

document.getElementById('confirmCompleteBtn').addEventListener('click', async () => {
  if (!activeTaskToComplete) return;
  const actualMin = parseInt(document.getElementById('actualMinutesInput').value, 10) || 30;

  try {
    await fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: activeTaskToComplete.taskId,
        title: activeTaskToComplete.title,
        estimated_minutes: activeTaskToComplete.estMin,
        actual_minutes: actualMin,
      })
    });
    document.getElementById('completionModal').classList.remove('active');
    activeTaskToComplete = null;
    await fetchPlan();
  } catch (err) {
    alert('Failed to log completion: ' + err.message);
  }
});

// UTILITIES
function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeJsStr(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// Refresh every 30 seconds
setInterval(fetchPlan, 30000);
fetchPlan();
