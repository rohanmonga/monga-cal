document.addEventListener('DOMContentLoaded', () => {
  let appState = {
    planData: null,
    completingTask: null,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    workStartHour: 8,
    workEndHour: 21,
    bufferMinutes: 10,
    maxTasksPerDay: 5,
    highEnergyStart: 9,
    highEnergyEnd: 12,
  };

  // Clock Widget
  function updateClock() {
    const now = new Date();
    const clockTime = document.getElementById('clockTime');
    const clockDate = document.getElementById('clockDate');
    
    if (clockTime) {
      clockTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (clockDate) {
      clockDate.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
  }
  setInterval(updateClock, 1000);
  updateClock();

  // API Fetch
  async function fetchPlan() {
    try {
      const res = await fetch('/api/plan');
      if (!res.ok) throw new Error('API Error');
      const data = await res.json();
      appState.planData = data;
      
      if (data.config) {
        appState.activeDays = data.config.active_days || [0, 1, 2, 3, 4, 5, 6];
        appState.workStartHour = data.config.work_start_hour || 8;
        appState.workEndHour = data.config.work_end_hour || 21;
        appState.bufferMinutes = data.config.buffer_minutes || 10;
        appState.maxTasksPerDay = data.config.max_tasks_per_day || 5;
      }
      
      renderDashboard(data);
    } catch (err) {
      console.error('Failed to load plan:', err);
    }
  }

  function renderDashboard(data) {
    updateSolverFooter(data);
    renderGanttChart(data);
    renderAgenda(data);
  }

  function updateSolverFooter(data) {
    const stats = data.schedule?.solver_stats || {};
    const elEngine = document.getElementById('solverEngine');
    const elStatus = document.getElementById('solverStatus');
    const elTime = document.getElementById('solverTime');
    const elMax = document.getElementById('solverMaxTasks');
    const elHours = document.getElementById('solverHours');

    if (elEngine) elEngine.textContent = stats.engine || 'OR-Tools CP-SAT';
    if (elStatus) elStatus.textContent = stats.status || 'OPTIMAL';
    if (elTime) elTime.textContent = `${stats.solve_time_sec || 0.005}s`;
    if (elMax) elMax.textContent = data.config?.max_tasks_per_day || 5;
    if (elHours) elHours.textContent = `${data.config?.work_start_hour || 8}:00 - ${data.config?.work_end_hour || 21}:00`;
  }

  // PACKED GANTT TIMELINE (NO WATERFALL SLOP)
  function renderGanttChart(data) {
    const scaleContainer = document.getElementById('ganttTimeScale');
    const tracksContainer = document.getElementById('ganttTracks');
    if (!scaleContainer || !tracksContainer) return;

    scaleContainer.innerHTML = '';
    tracksContainer.innerHTML = '';

    const startH = appState.workStartHour;
    const endH = appState.workEndHour;
    const totalHours = Math.max(1, endH - startH);

    // Render Hour Ticks
    for (let h = startH; h <= endH; h++) {
      const tick = document.createElement('div');
      tick.className = 'gantt-hour-tick';
      tick.textContent = `${h.toString().padStart(2, '0')}:00`;
      scaleContainer.appendChild(tick);
    }

    const blocks = data.schedule?.blocks || [];
    if (blocks.length === 0) {
      tracksContainer.innerHTML = '<div style="padding:15px; text-align:center; color:#64748b;">No scheduled blocks for today</div>';
      return;
    }

    // Convert blocks to timeline minutes relative to startH
    const parsedBlocks = blocks.map(b => {
      const s = new Date(b.start);
      const e = new Date(b.end);
      const startMin = (s.getHours() - startH) * 60 + s.getMinutes();
      const endMin = (e.getHours() - startH) * 60 + e.getMinutes();
      return { ...b, startMin, endMin };
    });

    // Pack non-overlapping blocks into horizontal lane tracks
    const lanes = [];
    parsedBlocks.forEach(block => {
      let placed = false;
      for (let l = 0; l < lanes.length; l++) {
        const lastInLane = lanes[l][lanes[l].length - 1];
        if (block.startMin >= lastInLane.endMin) {
          lanes[l].push(block);
          placed = true;
          break;
        }
      }
      if (!placed) {
        lanes.push([block]);
      }
    });

    const totalWindowMin = totalHours * 60;

    // Render packed lane tracks
    lanes.forEach(lane => {
      const trackLane = document.createElement('div');
      trackLane.className = 'gantt-track-lane';

      lane.forEach(b => {
        const leftPct = Math.max(0, (b.startMin / totalWindowMin) * 100);
        const widthPct = Math.min(100 - leftPct, ((b.endMin - b.startMin) / totalWindowMin) * 100);

        const el = document.createElement('div');
        el.className = 'gantt-block';
        el.style.left = `${leftPct}%`;
        el.style.width = `${widthPct}%`;

        const sTime = new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        el.textContent = `${sTime} ${b.task_title}`;
        el.title = `${b.task_title} (${b.estimated_minutes}m) [P${b.priority_score}]`;

        el.addEventListener('click', () => {
          openCompleteModal({
            id: b.task_id,
            title: b.task_title,
            estimated_minutes: b.estimated_minutes,
          });
        });

        trackLane.appendChild(el);
      });

      tracksContainer.appendChild(trackLane);
    });

    // Add Live Red "NOW" Line Indicator
    const now = new Date();
    const nowHour = now.getHours();
    if (nowHour >= startH && nowHour < endH) {
      const nowMin = (nowHour - startH) * 60 + now.getMinutes();
      const nowPct = (nowMin / totalWindowMin) * 100;
      const nowLine = document.createElement('div');
      nowLine.className = 'gantt-now-line';
      nowLine.style.left = `${nowPct}%`;
      tracksContainer.appendChild(nowLine);
    }
  }

  // WORKLOAD AGENDA — SHOW EVERYTHING ACROSS ALL CATEGORIES
  function renderAgenda(data) {
    const agendaTimeline = document.getElementById('agendaTimeline');
    const badgeCounter = document.getElementById('scheduleCountBadge');
    if (!agendaTimeline) return;

    agendaTimeline.innerHTML = '';

    const allTasks = data.tasks || [];
    const scheduledBlocks = data.schedule?.blocks || [];
    const scheduledTaskIds = new Set(scheduledBlocks.map(b => b.task_id));

    if (badgeCounter) {
      badgeCounter.innerHTML = `<span class="dot-live"></span> ${allTasks.length} Total Tasks`;
    }

    if (allTasks.length === 0) {
      agendaTimeline.innerHTML = '<div style="padding:20px; text-align:center; color:#64748b;">No pending tasks in Google Tasks!</div>';
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // Categorize tasks
    const activeTodayTasks = [];
    const queuedTasks = [];
    const deferredTasks = [];

    allTasks.forEach(t => {
      if (t.deferred_until && t.deferred_until >= todayStr) {
        deferredTasks.push(t);
      } else if (scheduledTaskIds.has(t.id)) {
        const block = scheduledBlocks.find(b => b.task_id === t.id);
        activeTodayTasks.push({ ...t, block });
      } else {
        queuedTasks.push(t);
      }
    });

    // Render Section 1: Today's Active Schedule
    if (activeTodayTasks.length > 0) {
      renderCategoryHeader(agendaTimeline, '⚡ SCHEDULED TODAY', activeTodayTasks.length, 'var(--cyan)');
      activeTodayTasks.forEach(item => {
        agendaTimeline.appendChild(createTaskCard(item, 'active'));
      });
    }

    // Render Section 2: Upcoming / Queued Tasks
    if (queuedTasks.length > 0) {
      renderCategoryHeader(agendaTimeline, '📋 QUEUED / UPCOMING', queuedTasks.length, 'var(--text-secondary)');
      queuedTasks.forEach(item => {
        agendaTimeline.appendChild(createTaskCard(item, 'queued'));
      });
    }

    // Render Section 3: Snoozed / Deferred Tasks
    if (deferredTasks.length > 0) {
      renderCategoryHeader(agendaTimeline, '🌙 SNOOZED / DEFERRED', deferredTasks.length, 'var(--amber)');
      deferredTasks.forEach(item => {
        agendaTimeline.appendChild(createTaskCard(item, 'deferred'));
      });
    }
  }

  function renderCategoryHeader(container, title, count, color) {
    const div = document.createElement('div');
    div.className = 'agenda-category-title';
    div.style.color = color;
    div.innerHTML = `${title} <span class="count-pill">${count}</span>`;
    container.appendChild(div);
  }

  function createTaskCard(t, category) {
    const card = document.createElement('div');
    card.className = `card-item ${category === 'active' ? 'active-card' : ''} ${category === 'deferred' ? 'deferred-card' : ''}`;

    let statusPill = '';
    if (category === 'active' && t.block) {
      const s = new Date(t.block.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const e = new Date(t.block.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statusPill = `<span class="time-pill">${s} - ${e}</span>`;
    } else if (category === 'deferred') {
      const dDate = new Date(t.deferred_until + 'T00:00:00');
      const formattedDate = dDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
      statusPill = `<span class="badge-deferred-pill">🌙 Deferred until ${formattedDate}</span>`;
    } else {
      statusPill = `<span class="badge-queued-pill">Queued</span>`;
    }

    const prioVal = t.priority_score || 5;

    let actionButtons = '';
    if (category === 'deferred') {
      actionButtons = `<button class="btn-unsnooze" data-id="${t.id}">☀️ Un-snooze</button>`;
    } else {
      actionButtons = `
        <button class="btn-direct-snooze" data-id="${t.id}" data-days="1">🌙 Tomorrow</button>
        <button class="btn-direct-snooze" data-id="${t.id}" data-days="7">📅 Next Week</button>
      `;
    }

    card.innerHTML = `
      <div class="card-main-row">
        <div class="card-left-group">
          ${statusPill}
          <div class="card-task-title">${t.title}</div>
        </div>

        <div class="controls-group">
          ${actionButtons}
          <select class="prio-select-pill" data-id="${t.id}">
            ${[1,2,3,4,5,6,7,8,9,10].map(p => `<option value="${p}" ${p === prioVal ? 'selected' : ''}>P${p}</option>`).join('')}
          </select>
          <span class="badge-tag badge-duration">⏱️ ${t.estimated_minutes || 30}m</span>
          <button class="btn-complete-task" data-id="${t.id}" data-title="${t.title}" data-min="${t.estimated_minutes || 30}">✓ Complete</button>
        </div>
      </div>
    `;

    card.querySelectorAll('.btn-direct-snooze').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const days = btn.dataset.days;
        await deferTask(id, days);
      });
    });

    const unsnoozeBtn = card.querySelector('.btn-unsnooze');
    if (unsnoozeBtn) {
      unsnoozeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deferTask(unsnoozeBtn.dataset.id, -1);
      });
    }

    const prioSelect = card.querySelector('.prio-select-pill');
    if (prioSelect) {
      prioSelect.addEventListener('change', async (e) => {
        const id = prioSelect.dataset.id;
        const newPrio = parseInt(e.target.value);
        await updatePriority(id, newPrio);
      });
    }

    const completeBtn = card.querySelector('.btn-complete-task');
    if (completeBtn) {
      completeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openCompleteModal({
          id: completeBtn.dataset.id,
          title: completeBtn.dataset.title,
          estimated_minutes: parseInt(completeBtn.dataset.min),
        });
      });
    }

    return card;
  }

  // SNOOZE / DEFER TASK
  async function deferTask(taskId, days) {
    try {
      const res = await fetch(`/api/tasks/${taskId}/defer?days=${days}`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to snooze task');
      await fetchPlan();
    } catch (err) {
      alert('Error snoozing task: ' + err.message);
    }
  }

  // PRIORITY OVERRIDE
  async function updatePriority(taskId, prio) {
    try {
      const res = await fetch(`/api/tasks/${taskId}/priority`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority_score: prio }),
      });
      if (!res.ok) throw new Error('Failed to update priority');
      await fetchPlan();
    } catch (err) {
      alert('Error updating priority: ' + err.message);
    }
  }

  // ADD TASK
  const addTaskModal = document.getElementById('addTaskModal');
  document.getElementById('openAddTaskBtn')?.addEventListener('click', () => {
    addTaskModal?.classList.add('active');
  });
  document.getElementById('cancelAddTaskBtn')?.addEventListener('click', () => {
    addTaskModal?.classList.remove('active');
  });
  document.getElementById('saveAddTaskBtn')?.addEventListener('click', async () => {
    const titleInput = document.getElementById('newTaskTitleInput');
    const notesInput = document.getElementById('newTaskNotesInput');
    if (!titleInput?.value.trim()) return;

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titleInput.value.trim(), notes: notesInput?.value || '' }),
      });
      if (res.ok) {
        titleInput.value = '';
        if (notesInput) notesInput.value = '';
        addTaskModal.classList.remove('active');
        await fetchPlan();
      }
    } catch (err) {
      alert('Error adding task: ' + err.message);
    }
  });

  // COMPLETE TASK MODAL
  const completionModal = document.getElementById('completionModal');
  function openCompleteModal(task) {
    appState.completingTask = task;
    const titleEl = document.getElementById('modalTaskTitle');
    const minInput = document.getElementById('actualMinutesInput');
    if (titleEl) titleEl.textContent = task.title;
    if (minInput) minInput.value = task.estimated_minutes || 30;
    completionModal?.classList.add('active');
  }

  document.getElementById('cancelModalBtn')?.addEventListener('click', () => {
    completionModal?.classList.remove('active');
  });

  document.querySelectorAll('.quick-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const minInput = document.getElementById('actualMinutesInput');
      if (minInput) minInput.value = chip.dataset.min;
    });
  });

  document.getElementById('confirmCompleteBtn')?.addEventListener('click', async () => {
    if (!appState.completingTask) return;
    const minInput = document.getElementById('actualMinutesInput');
    const actual = parseInt(minInput?.value || 30);

    try {
      const res = await fetch('/api/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: appState.completingTask.id,
          title: appState.completingTask.title,
          estimated_minutes: appState.completingTask.estimated_minutes || 30,
          actual_minutes: actual,
        }),
      });
      if (res.ok) {
        completionModal.classList.remove('active');
        await fetchPlan();
      }
    } catch (err) {
      alert('Error logging task completion: ' + err.message);
    }
  });

  // RE-SOLVE BUTTON
  document.getElementById('rescheduleBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('rescheduleBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⚡ Solving...';
    }
    try {
      await fetch('/api/reschedule', { method: 'POST' });
      await fetchPlan();
    } catch (err) {
      alert('Reschedule error: ' + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Re-Solve';
      }
    }
  });

  // SETTINGS MODAL (SAFE NULL-CHECKED)
  const settingsModal = document.getElementById('settingsModal');
  document.getElementById('openSettingsBtn')?.addEventListener('click', () => {
    const elStart = document.getElementById('workStartHourInput');
    const elEnd = document.getElementById('workEndHourInput');
    const elBuf = document.getElementById('bufferMinutesInput');
    const elMax = document.getElementById('maxTasksPerDayInput');

    if (elStart) elStart.value = appState.workStartHour;
    if (elEnd) elEnd.value = appState.workEndHour;
    if (elBuf) elBuf.value = appState.bufferMinutes;
    if (elMax) elMax.value = appState.maxTasksPerDay;

    document.querySelectorAll('.day-chip').forEach(chip => {
      const d = parseInt(chip.dataset.day);
      if (appState.activeDays.includes(d)) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });

    settingsModal?.classList.add('active');
  });

  document.querySelectorAll('.day-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
    });
  });

  document.getElementById('cancelSettingsBtn')?.addEventListener('click', () => {
    settingsModal?.classList.remove('active');
  });

  document.getElementById('saveSettingsBtn')?.addEventListener('click', async () => {
    const activeDays = Array.from(document.querySelectorAll('.day-chip.active')).map(c => parseInt(c.dataset.day));
    const startH = parseInt(document.getElementById('workStartHourInput')?.value || 8);
    const endH = parseInt(document.getElementById('workEndHourInput')?.value || 21);
    const buf = parseInt(document.getElementById('bufferMinutesInput')?.value || 10);
    const maxTasks = parseInt(document.getElementById('maxTasksPerDayInput')?.value || 5);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          active_days: activeDays,
          work_start_hour: startH,
          work_end_hour: endH,
          buffer_minutes: buf,
          max_tasks_per_day: maxTasks,
          high_energy_start_hour: appState.highEnergyStart,
          high_energy_end_hour: appState.highEnergyEnd,
        }),
      });
      if (res.ok) {
        settingsModal.classList.remove('active');
        await fetchPlan();
      }
    } catch (err) {
      alert('Error saving settings: ' + err.message);
    }
  });

  // Initial load
  fetchPlan();
});
