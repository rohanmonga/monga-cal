const API_BASE = '';

let currentTasks = [];
let currentSchedule = { blocks: [], fixed_events: [], unscheduled_task_ids: [], solver_stats: {} };
let currentConfig = { active_days: [0, 1, 2, 3, 4], work_start_hour: 10, work_end_hour: 17, buffer_minutes: 10, max_tasks_per_day: 3 };
let currentKidsData = { kids: [], recent_history: [] };
let completingTaskId = null;
let selectedChoreKid = 'Vivaan';
let choreStarDelta = 1;
let selectedGanttDate = new Date().toISOString().split('T')[0];

document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initEventListeners();
  fetchPlan();
  fetchKidsStars();
  fetchHistory();

  // Auto-refresh every 30 seconds
  setInterval(() => {
    fetchPlan();
    fetchKidsStars();
  }, 30000);
});

function initClock() {
  const clockTime = document.getElementById('clockTime');
  const clockDate = document.getElementById('clockDate');
  const scheduleNowTime = document.getElementById('scheduleNowTime');

  function updateClock() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHour = hours % 12 || 12;
    const timeFormatted = `${displayHour}:${minutes} ${ampm}`;

    if (clockTime) clockTime.textContent = timeFormatted;
    if (scheduleNowTime) scheduleNowTime.textContent = `NOW ${timeFormatted}`;

    const options = { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' };
    if (clockDate) clockDate.textContent = now.toLocaleDateString('en-US', options);
  }

  updateClock();
  setInterval(updateClock, 1000);
}

function initEventListeners() {
  // Add Task Modal
  const openAddTaskBtn = document.getElementById('openAddTaskBtn');
  const cancelAddTaskBtn = document.getElementById('cancelAddTaskBtn');
  const saveAddTaskBtn = document.getElementById('saveAddTaskBtn');
  const addTaskModal = document.getElementById('addTaskModal');

  if (openAddTaskBtn) openAddTaskBtn.addEventListener('click', () => addTaskModal.classList.add('active'));
  if (cancelAddTaskBtn) cancelAddTaskBtn.addEventListener('click', () => addTaskModal.classList.remove('active'));
  if (saveAddTaskBtn) saveAddTaskBtn.addEventListener('click', saveAddTask);

  // Settings Modal
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsModal = document.getElementById('settingsModal');

  if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => {
    populateSettingsForm();
    settingsModal.classList.add('active');
  });
  if (cancelSettingsBtn) cancelSettingsBtn.addEventListener('click', () => settingsModal.classList.remove('active'));
  if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);

  const dayChips = document.querySelectorAll('.day-chip:not(.quick-chip)');
  dayChips.forEach(chip => chip.addEventListener('click', () => chip.classList.toggle('active')));

  // Reschedule
  const rescheduleBtn = document.getElementById('rescheduleBtn');
  if (rescheduleBtn) rescheduleBtn.addEventListener('click', triggerReschedule);

  // History Log Modal Toggle
  const tabHistoryToggleBtn = document.getElementById('tabHistoryToggleBtn');
  const closeHistoryViewBtn = document.getElementById('closeHistoryViewBtn');
  const tabHistoryView = document.getElementById('tabHistoryView');

  if (tabHistoryToggleBtn) tabHistoryToggleBtn.addEventListener('click', () => {
    fetchHistory();
    tabHistoryView.classList.add('active');
  });
  if (closeHistoryViewBtn) closeHistoryViewBtn.addEventListener('click', () => tabHistoryView.classList.remove('active'));

  // Task Completion Modal
  const cancelModalBtn = document.getElementById('cancelModalBtn');
  const confirmCompleteBtn = document.getElementById('confirmCompleteBtn');
  const completionModal = document.getElementById('completionModal');

  if (cancelModalBtn) cancelModalBtn.addEventListener('click', () => {
    completionModal.classList.remove('active');
    completingTaskId = null;
  });
  if (confirmCompleteBtn) confirmCompleteBtn.addEventListener('click', submitCompletion);

  const quickChips = document.querySelectorAll('.quick-chip');
  quickChips.forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('actualMinutesInput').value = chip.dataset.min;
    });
  });

  // Award Chore Star Modal
  const openLogChoreBtn = document.getElementById('openLogChoreBtn');
  const btnQuickRewardModal = document.getElementById('btnQuickRewardModal');
  const logChoreModal = document.getElementById('logChoreModal');
  const cancelChoreModalBtn = document.getElementById('cancelChoreModalBtn');
  const submitChoreStarBtn = document.getElementById('submitChoreStarBtn');
  const btnMinusStar = document.getElementById('btnMinusStar');
  const btnPlusStar = document.getElementById('btnPlusStar');

  const openChoreModal = () => {
    choreStarDelta = 1;
    updateStarDeltaDisplay();
    document.getElementById('choreDescriptionInput').value = '';
    logChoreModal.classList.add('active');
  };

  if (openLogChoreBtn) openLogChoreBtn.addEventListener('click', openChoreModal);
  if (btnQuickRewardModal) btnQuickRewardModal.addEventListener('click', openChoreModal);
  if (cancelChoreModalBtn) cancelChoreModalBtn.addEventListener('click', () => logChoreModal.classList.remove('active'));

  // Kid select chips in modal
  const kidChips = document.querySelectorAll('.kid-chip');
  kidChips.forEach(chip => {
    chip.addEventListener('click', () => {
      kidChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedChoreKid = chip.dataset.kid;
    });
  });

  // Quick chore descriptions
  const choreChips = document.querySelectorAll('.chore-chip');
  choreChips.forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('choreDescriptionInput').value = chip.dataset.text;
    });
  });

  if (btnMinusStar) {
    btnMinusStar.addEventListener('click', () => {
      if (choreStarDelta > 1) {
        choreStarDelta--;
        updateStarDeltaDisplay();
      }
    });
  }

  if (btnPlusStar) {
    btnPlusStar.addEventListener('click', () => {
      choreStarDelta++;
      updateStarDeltaDisplay();
    });
  }

  if (submitChoreStarBtn) submitChoreStarBtn.addEventListener('click', submitChoreStarModal);

  // OAuth Modal Listeners
  const bannerAuthBtn = document.getElementById('bannerAuthBtn');
  const cancelAuthBtn = document.getElementById('cancelAuthBtn');
  const btnLaunchOAuth = document.getElementById('btnLaunchOAuth');
  const submitAuthCodeBtn = document.getElementById('submitAuthCodeBtn');
  const authModal = document.getElementById('authModal');

  if (bannerAuthBtn) bannerAuthBtn.addEventListener('click', () => authModal.classList.add('active'));
  if (cancelAuthBtn) cancelAuthBtn.addEventListener('click', () => authModal.classList.remove('active'));
  if (btnLaunchOAuth) btnLaunchOAuth.addEventListener('click', handleLaunchOAuth);
  if (submitAuthCodeBtn) submitAuthCodeBtn.addEventListener('click', handleSubmitAuthCode);

  // Close modals on dark overlay click
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
        if (modal.id === 'completionModal') completingTaskId = null;
      }
    });
  });
}

function updateStarDeltaDisplay() {
  const el = document.getElementById('starDeltaValue');
  if (el) el.textContent = `+${choreStarDelta} ⭐`;
}

async function submitChoreStarModal() {
  const choreInput = document.getElementById('choreDescriptionInput');
  const chore = choreInput ? choreInput.value.trim() : '';
  const submitBtn = document.getElementById('submitChoreStarBtn');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Awarding...';
  }

  try {
    await awardStar(selectedChoreKid, choreStarDelta, chore);
    const modal = document.getElementById('logChoreModal');
    if (modal) modal.classList.remove('active');
  } catch (err) {
    alert(err.message || 'Failed to award star');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '⭐ Award Stars!';
    }
  }
}

async function awardStar(kidName, delta = 1, chore = '') {
  try {
    const res = await fetch(`${API_BASE}/api/kids/stars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kid_name: kidName, delta, chore })
    });
    if (!res.ok) throw new Error('Failed to award stars');
    const data = await res.json();
    currentKidsData = data;
    renderKidsStarWidget();
  } catch (err) {
    console.error('Error awarding star:', err);
    throw err;
  }
}

async function fetchKidsStars() {
  try {
    const res = await fetch(`${API_BASE}/api/kids/stars`);
    if (!res.ok) return;
    currentKidsData = await res.json();
    renderKidsStarWidget();
  } catch (err) {
    console.error('Error fetching kids stars:', err);
  }
}

function renderKidsStarWidget() {
  const kidsProfilesGrid = document.getElementById('kidsProfilesGrid');
  const kidsTimeseriesChart = document.getElementById('kidsTimeseriesChart');
  const recentChoresTicker = document.getElementById('recentChoresTicker');

  if (!kidsProfilesGrid || !currentKidsData.kids) return;

  // 1. Render Kid Cards
  kidsProfilesGrid.innerHTML = '';
  currentKidsData.kids.forEach(kid => {
    const card = document.createElement('div');
    card.className = 'kid-profile-card';
    const isVivaan = kid.kid_name.toLowerCase().includes('vivaan');

    card.innerHTML = `
      <div class="kid-avatar ${isVivaan ? 'vivaan' : 'vrihaan'}">👦</div>
      <div class="kid-name">${escapeHtml(kid.kid_name)}</div>
      <div class="kid-stars-count">${kid.total_stars} <span>⭐</span></div>
      <div class="kid-today-stars">+${kid.today_stars} today</div>
      <button class="btn-instant-star" data-kid="${escapeHtml(kid.kid_name)}">
        <span>+1</span> ⭐
      </button>
    `;

    const instantBtn = card.querySelector('.btn-instant-star');
    if (instantBtn) {
      instantBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        awardStar(kid.kid_name, 1, 'Quick Star Reward');
      });
    }

    kidsProfilesGrid.appendChild(card);
  });

  // 2. Render 7-Day Timeseries Bars
  if (kidsTimeseriesChart && currentKidsData.kids.length > 0) {
    kidsTimeseriesChart.innerHTML = '';
    const dayKeys = currentKidsData.kids[0].timeseries_days || [];
    const v1 = currentKidsData.kids.find(k => k.kid_name.toLowerCase().includes('vivaan')) || currentKidsData.kids[0];
    const v2 = currentKidsData.kids.find(k => !k.kid_name.toLowerCase().includes('vivaan')) || currentKidsData.kids[1];

    let maxDayStars = 1;
    dayKeys.forEach((_, idx) => {
      const s1 = v1 && v1.timeseries_values ? v1.timeseries_values[idx] || 0 : 0;
      const s2 = v2 && v2.timeseries_values ? v2.timeseries_values[idx] || 0 : 0;
      if (s1 + s2 > maxDayStars) maxDayStars = s1 + s2;
    });

    dayKeys.forEach((dayLabel, idx) => {
      const s1 = v1 && v1.timeseries_values ? v1.timeseries_values[idx] || 0 : 0;
      const s2 = v2 && v2.timeseries_values ? v2.timeseries_values[idx] || 0 : 0;
      const totalDay = s1 + s2;

      const col = document.createElement('div');
      col.className = 'day-bar-col';
      const heightPercent = totalDay === 0 ? 8 : Math.max(12, Math.round((totalDay / maxDayStars) * 100));

      const h1Percent = totalDay > 0 ? (s1 / totalDay) * 100 : 0;
      const h2Percent = totalDay > 0 ? (s2 / totalDay) * 100 : 0;

      const shortDay = dayLabel.split(' ')[0]; // 'Mon', 'Tue', etc.

      col.innerHTML = `
        <div class="bar-stack" style="height: ${heightPercent}%;" title="${dayLabel}: Vivaan (${s1}), Vrihaan (${s2})">
          ${s1 > 0 ? `<div class="bar-segment-v1" style="height:${h1Percent}%;"></div>` : ''}
          ${s2 > 0 ? `<div class="bar-segment-v2" style="height:${h2Percent}%;"></div>` : ''}
        </div>
        <span class="day-bar-label">${shortDay}</span>
      `;


      kidsTimeseriesChart.appendChild(col);
    });
  }

  // 3. Render Recent Chores
  if (recentChoresTicker && currentKidsData.recent_history) {
    if (currentKidsData.recent_history.length === 0) {
      recentChoresTicker.innerHTML = `<span style="color:var(--text-subtle); font-size:11px;">No stars logged yet. Tap + Reward above!</span>`;
    } else {
      const rec = currentKidsData.recent_history.slice(0, 3).map(h => {
        const desc = h.chore_description ? `: ${h.chore_description}` : '';
        return `<div>⭐ <strong>${escapeHtml(h.kid_name)}</strong> +${h.stars_delta}${escapeHtml(desc)}</div>`;
      }).join('');
      recentChoresTicker.innerHTML = rec;
    }
  }
}

async function fetchPlan() {
  try {
    const res = await fetch(`${API_BASE}/api/plan`);
    if (!res.ok) throw new Error('Failed to fetch plan');
    const data = await res.json();
    currentTasks = data.tasks || [];
    currentSchedule = data.schedule || { blocks: [], fixed_events: [], unscheduled_task_ids: [], solver_stats: {} };
    currentConfig = data.config || currentConfig;

    updateAuthStatus(data.status);
    renderCurrentFocusHero();
    renderCapacityMeter();
    renderScheduleStream();
    renderFamilyWeekAhead();
    renderGanttChart();
  } catch (err) {
    console.error('Error fetching plan:', err);
  }
}

function updateAuthStatus(statusData) {
  const googleAuthBanner = document.getElementById('googleAuthBanner');
  const headerStatusPill = document.getElementById('headerStatusPill');
  const headerStatusText = document.getElementById('headerStatusText');
  if (!googleAuthBanner) return;

  const isConnected = statusData && statusData.google_connected;
  const authError = statusData && statusData.google_auth_error;

  if (!isConnected || authError) {
    googleAuthBanner.classList.remove('hidden');
    if (headerStatusPill) {
      headerStatusPill.innerHTML = `<span class="status-dot" style="background:#ef4444;"></span><span>Disconnected</span>`;
    }
    const authModalMessage = document.getElementById('authModalMessage');
    if (authModalMessage && authError) {
      authModalMessage.textContent = authError;
    }
  } else {
    googleAuthBanner.classList.add('hidden');
    if (headerStatusPill) {
      headerStatusPill.innerHTML = `<span class="status-dot online"></span><span>Live Google Sync</span>`;
    }
  }
}

/* ===================================================
   HERO: CURRENT FOCUS SPOTLIGHT
=================================================== */
function renderCurrentFocusHero() {
  const heroBadge = document.getElementById('heroFocusBadgeText');
  const heroTimeRemaining = document.getElementById('heroTimeRemaining');
  const heroTimeRange = document.getElementById('heroTimeRange');
  const heroTaskTitle = document.getElementById('heroTaskTitle');
  const heroTaskDirective = document.getElementById('heroTaskDirective');
  const heroActionsGroup = document.getElementById('heroActionsGroup');
  const heroCompleteBtn = document.getElementById('heroCompleteBtn');
  const heroSnoozeBtn = document.getElementById('heroSnoozeBtn');

  if (!heroTaskTitle) return;

  const blocks = currentSchedule.blocks || [];
  const fixedEvents = currentSchedule.fixed_events || [];
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));
  const todayStr = new Date().toISOString().split('T')[0];

  // Interleave today's items
  const todayBlocks = blocks.filter(b => b.start.startsWith(todayStr)).map(b => ({
    is_fixed: false,
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
    title: b.task_title,
    directive: b.manager_directive || 'Priority task block.',
    task_id: b.task_id,
    startStr: b.start,
    endStr: b.end
  }));

  const todayMeetings = fixedEvents.filter(e => e.start.startsWith(todayStr)).map(e => ({
    is_fixed: true,
    start: new Date(e.start).getTime(),
    end: new Date(e.end).getTime(),
    title: e.title || 'Google Calendar Event',
    directive: 'Fixed meeting on Google Calendar (Time locked)',
    startStr: e.start,
    endStr: e.end
  }));

  const allTodayItems = [...todayBlocks, ...todayMeetings].sort((a, b) => a.start - b.start);
  const nowMs = new Date().getTime();

  // Find active item (now is between start and end)
  let activeItem = allTodayItems.find(item => item.start <= nowMs && nowMs <= item.end);
  let isUpcoming = false;

  // If not currently in an item, find the very next upcoming item today
  if (!activeItem) {
    activeItem = allTodayItems.find(item => item.start > nowMs);
    isUpcoming = true;
  }

  const fmtTime = (d) => {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  };

  if (activeItem) {
    const dtStart = new Date(activeItem.start);
    const dtEnd = new Date(activeItem.end);

    if (isUpcoming) {
      if (heroBadge) heroBadge.textContent = 'UP NEXT';
      const minsUntil = Math.max(1, Math.round((activeItem.start - nowMs) / 60000));
      if (heroTimeRemaining) heroTimeRemaining.textContent = `Starts in ${minsUntil}m`;
    } else {
      if (heroBadge) heroBadge.textContent = 'CURRENT FOCUS';
      const minsLeft = Math.max(1, Math.round((activeItem.end - nowMs) / 60000));
      if (heroTimeRemaining) heroTimeRemaining.textContent = `${minsLeft}m left`;
    }

    if (heroTimeRange) heroTimeRange.textContent = `${fmtTime(dtStart)} - ${fmtTime(dtEnd)}`;
    if (heroTaskTitle) heroTaskTitle.textContent = activeItem.title;
    if (heroTaskDirective) heroTaskDirective.textContent = activeItem.directive;

    if (heroActionsGroup) {
      if (activeItem.is_fixed) {
        heroActionsGroup.innerHTML = `
          <button class="btn-hero-complete" style="background:#7c3aed;" onclick="window.open('https://calendar.google.com','_blank')">
            <span>📅</span> View in Google Calendar
          </button>
        `;
      } else {
        heroActionsGroup.innerHTML = `
          <button class="btn-hero-complete" id="heroCompleteBtn">
            <span>✅</span> Mark Complete
          </button>
          <button class="btn-hero-snooze" id="heroSnoozeBtn">
            <span>🌙</span> Snooze 1h
          </button>
        `;
        const cBtn = document.getElementById('heroCompleteBtn');
        const sBtn = document.getElementById('heroSnoozeBtn');
        if (cBtn) cBtn.addEventListener('click', () => openCompleteModal(activeItem.task_id, activeItem.title));
        if (sBtn) sBtn.addEventListener('click', () => snoozeTask(activeItem.task_id, 1));
      }
    }
  } else {
    // All scheduled tasks done or none today
    if (heroBadge) heroBadge.textContent = 'ALL CLEAR';
    if (heroTimeRemaining) heroTimeRemaining.textContent = 'Done today';
    if (heroTimeRange) heroTimeRange.textContent = 'Free Time';
    if (heroTaskTitle) heroTaskTitle.textContent = 'All Done For Today!';
    if (heroTaskDirective) heroTaskDirective.textContent = 'Great job! You have completed your scheduled focus tasks for today.';
    if (heroActionsGroup) {
      heroActionsGroup.innerHTML = `
        <button class="btn-hero-complete" id="heroAddTaskFastBtn">
          <span>+</span> Add Another Task
        </button>
      `;
      const addBtn = document.getElementById('heroAddTaskFastBtn');
      if (addBtn) addBtn.addEventListener('click', () => document.getElementById('addTaskModal').classList.add('active'));
    }
  }
}

/* ===================================================
   CAPACITY METER
=================================================== */
function renderCapacityMeter() {
  const ratioTag = document.getElementById('capacityRatioTag');
  const meterFill = document.getElementById('capacityMeterFill');
  const metaDetail = document.getElementById('capacityMetaDetail');
  const slotsLeft = document.getElementById('capacitySlotsLeft');

  const solverStats = currentSchedule.solver_stats || {};
  const completedToday = solverStats.completed_today_count || 0;
  const maxPerDay = currentConfig.max_tasks_per_day || 3;

  const todayStr = new Date().toISOString().split('T')[0];
  const scheduledToday = (currentSchedule.blocks || []).filter(b => b.start.startsWith(todayStr)).length;

  const percent = Math.min(100, Math.round((completedToday / maxPerDay) * 100));
  const remaining = Math.max(0, maxPerDay - completedToday);

  if (ratioTag) ratioTag.textContent = `${completedToday} / ${maxPerDay} Tasks`;
  if (meterFill) meterFill.style.width = `${percent}%`;
  if (metaDetail) metaDetail.textContent = `${completedToday} completed today • ${scheduledToday} active`;
  if (slotsLeft) slotsLeft.textContent = `${remaining} slots remaining today`;
}

/* ===================================================
   TODAY'S CHRONOLOGICAL SCHEDULE STREAM
=================================================== */
function renderScheduleStream() {
  const timeline = document.getElementById('agendaTimeline');
  const subtitle = document.getElementById('agendaTodaySubtitle');
  if (!timeline) return;

  const blocks = currentSchedule.blocks || [];
  const fixedEvents = currentSchedule.fixed_events || [];
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));
  const todayStr = new Date().toISOString().split('T')[0];

  const todayBlocks = blocks.filter(b => b.start.startsWith(todayStr)).map(b => ({
    is_fixed: false,
    start: new Date(b.start),
    end: new Date(b.end),
    block: b,
    task: taskMap.get(b.task_id) || { id: b.task_id, title: b.task_title, priority_score: b.priority_score, manager_directive: b.manager_directive, category: b.category, category_icon: b.category_icon, color_preset: b.color_preset }
  }));

  const todayFixed = fixedEvents.filter(e => e.start.startsWith(todayStr)).map(e => ({
    is_fixed: true,
    start: new Date(e.start),
    end: new Date(e.end),
    event: e
  }));

  const allStream = [...todayBlocks, ...todayFixed].sort((a, b) => a.start.getTime() - b.start.getTime());

  if (subtitle) {
    subtitle.textContent = `${todayBlocks.length} focus tasks • ${todayFixed.length} calendar meetings`;
  }

  timeline.innerHTML = '';

  if (allStream.length === 0) {
    timeline.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">
        <div style="font-size: 28px; margin-bottom: 8px;">🏖️</div>
        <div style="font-size: 15px; font-weight: 700; color: var(--text-main);">No tasks or meetings scheduled today</div>
        <div style="font-size: 13px; margin-top: 4px;">Tap <strong>+ Add Task</strong> above to schedule an item.</div>
      </div>
    `;
    return;
  }

  const fmtTime = (d) => {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  };

  allStream.forEach(item => {
    const card = document.createElement('div');

    if (item.is_fixed) {
      card.className = 'stream-card preset-fixed';
      card.innerHTML = `
        <div class="stream-card-left">
          <div class="stream-card-time">${fmtTime(item.start)}<br>${fmtTime(item.end)}</div>
          <div class="stream-card-info">
            <div class="stream-card-title-row">
              <span style="font-size: 15px;">📅</span>
              <span class="stream-card-title">${escapeHtml(item.event.title || 'Google Calendar Event')}</span>
              <span class="stream-card-badge badge-gcal">Google Calendar</span>
            </div>
            <div class="stream-card-directive">🔒 Fixed Meeting • Time locked & collision-free</div>
          </div>
        </div>
        <div class="stream-card-controls">
          <span style="font-size: 11px; font-weight: 700; color: var(--gcal-purple); padding: 4px 8px; background: var(--gcal-purple-soft); border-radius: 6px;">Fixed</span>
        </div>
      `;
    } else {
      card.className = 'stream-card';
      const t = item.task;
      const b = item.block;
      const prioScore = t.priority_score || b.priority_score || 3;
      const prioLabel = prioScore === 1 ? 'P1 Urgent' : (prioScore === 2 ? 'P2 High' : 'P3 Focus');

      card.innerHTML = `
        <div class="stream-card-left">
          <div class="stream-card-time">${fmtTime(item.start)}<br>${fmtTime(item.end)}</div>
          <div class="stream-card-info">
            <div class="stream-card-title-row">
              <span style="font-size: 15px;">${t.category_icon || '📌'}</span>
              <span class="stream-card-title">${escapeHtml(t.title)}</span>
              <span class="stream-card-badge badge-focus">${escapeHtml(t.category || 'Focus')}</span>
              <span class="stream-card-badge badge-prio">${prioLabel}</span>
            </div>
            <div class="stream-card-directive">${escapeHtml(t.manager_directive || b.manager_directive || 'Scheduled focus block')}</div>
          </div>
        </div>
        <div class="stream-card-controls">
          <button class="btn-card-done" data-task-id="${t.id}" data-task-title="${escapeHtml(t.title)}">Done</button>
          <button class="btn-card-icon snooze-btn" data-task-id="${t.id}" title="Snooze 1 day">🌙</button>
        </div>
      `;

      const doneBtn = card.querySelector('.btn-card-done');
      const sBtn = card.querySelector('.snooze-btn');
      if (doneBtn) doneBtn.addEventListener('click', () => openCompleteModal(t.id, t.title));
      if (sBtn) sBtn.addEventListener('click', () => snoozeTask(t.id, 1));
    }

    timeline.appendChild(card);
  });
}

/* ===================================================
   KIDS & FAMILY WEEK AHEAD RADAR
=================================================== */
function renderFamilyWeekAhead() {
  const radarList = document.getElementById('familyRadarList');
  const countBadge = document.getElementById('familyWeekCount');
  if (!radarList) return;

  const fixedEvents = currentSchedule.fixed_events || [];
  const todayStr = new Date().toISOString().split('T')[0];

  // Upcoming meetings from tomorrow onwards
  const upcomingMeetings = fixedEvents.filter(e => !e.start.startsWith(todayStr)).sort((a, b) => new Date(a.start) - new Date(b.start));

  if (countBadge) countBadge.textContent = `${upcomingMeetings.length} Events`;
  radarList.innerHTML = '';

  if (upcomingMeetings.length === 0) {
    radarList.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-muted); font-size: 12px;">No upcoming Google Calendar meetings this week.</div>`;
    return;
  }

  const fmtTime = (d) => {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  };

  upcomingMeetings.slice(0, 10).forEach(ev => {
    const dtStart = new Date(ev.start);
    const dayStr = dtStart.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

    const card = document.createElement('div');
    card.className = 'radar-item-card';
    card.innerHTML = `
      <div class="radar-item-left">
        <span class="radar-day-chip">${dayStr}</span>
        <span class="radar-item-title">${escapeHtml(ev.title || 'Meeting')}</span>
      </div>
      <span class="radar-item-time">${fmtTime(dtStart)}</span>
    `;

    radarList.appendChild(card);
  });
}

/* ===================================================
   7-DAY GANTT TIMELINE SCRUB
=================================================== */
function renderGanttChart(targetDateStr = null) {
  const ganttTracks = document.getElementById('ganttTracks');
  const ganttTimeScale = document.getElementById('ganttTimeScale');
  const ganttDayTabs = document.getElementById('ganttDayTabs');
  const ganttDateSubtitle = document.getElementById('ganttDateSubtitle');
  if (!ganttTracks || !ganttTimeScale) return;

  if (targetDateStr) selectedGanttDate = targetDateStr;

  const allBlocks = currentSchedule.blocks || [];
  const fixedEvents = currentSchedule.fixed_events || [];
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));

  // Setup Next 7 Days Navigation Tabs
  if (ganttDayTabs) {
    ganttDayTabs.innerHTML = '';
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      const dStr = d.toISOString().split('T')[0];
      const isToday = i === 0;
      const dayLabel = isToday ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

      const tabBtn = document.createElement('button');
      tabBtn.className = `gantt-day-tab ${dStr === selectedGanttDate ? 'active' : ''}`;
      tabBtn.textContent = dayLabel;
      tabBtn.addEventListener('click', () => {
        selectedGanttDate = dStr;
        renderGanttChart(dStr);
      });
      ganttDayTabs.appendChild(tabBtn);
    }
  }

  const dayBlocks = allBlocks.filter(b => b.start.startsWith(selectedGanttDate));
  const dayFixedEvents = fixedEvents.filter(e => e.start.startsWith(selectedGanttDate)).map(e => ({
    is_fixed_event: true,
    start: e.start,
    end: e.end,
    task_title: e.title || 'Google Calendar Event',
    color_preset: 'fixed',
    category_icon: '📅'
  }));

  const allDayItems = [...dayBlocks, ...dayFixedEvents];

  if (ganttDateSubtitle) {
    const selDateObj = new Date(selectedGanttDate + 'T00:00:00');
    const label = selectedGanttDate === new Date().toISOString().split('T')[0]
      ? 'Today'
      : selDateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    ganttDateSubtitle.textContent = `${label} (${dayBlocks.length} tasks, ${dayFixedEvents.length} meetings)`;
  }

  ganttTracks.innerHTML = '';
  ganttTimeScale.innerHTML = '';

  if (allDayItems.length === 0) {
    ganttTracks.innerHTML = `<div style="text-align:center; padding: 16px; color: var(--text-muted); font-size: 12.5px;">No tasks or calendar events scheduled for this day.</div>`;
    ganttTracks.style.height = '48px';
    return;
  }

  let minStart = Math.min(...allDayItems.map(b => new Date(b.start).getTime()));
  let maxEnd = Math.max(...allDayItems.map(b => new Date(b.end).getTime()));

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
  allDayItems.forEach(b => {
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

  const trackHeight = 52;
  ganttTracks.style.height = `${tracks.length * trackHeight + 8}px`;

  tracks.forEach((trackBlocks, tIdx) => {
    trackBlocks.forEach(b => {
      const dtStart = new Date(b.start);
      const dtEnd = new Date(b.end);

      const startMinutes = (dtStart.getHours() - startHour) * 60 + dtStart.getMinutes();
      const durationMinutes = (dtEnd - dtStart) / (1000 * 60);

      const leftPercent = Math.max(0, Math.min(96, (startMinutes / totalMinutes) * 100));
      const widthPercent = Math.max(12, Math.min(100 - leftPercent, (durationMinutes / totalMinutes) * 100));

      const parentTask = b.task_id ? taskMap.get(b.task_id) : null;
      const preset = (b.color_preset || (parentTask ? parentTask.color_preset : 'neutral')).toLowerCase();
      const icon = b.category_icon || (parentTask ? parentTask.category_icon : '📌');

      const card = document.createElement('div');
      card.className = `gantt-block-card preset-${preset}`;
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
        <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${icon} ${escapeHtml(b.task_title)}</div>
      `;

      ganttTracks.appendChild(card);
    });
  });
}

/* ===================================================
   ACTION HANDLERS: ADD, SNOOZE, COMPLETE
=================================================== */
function openCompleteModal(taskId, taskTitle) {
  completingTaskId = taskId;
  const titleEl = document.getElementById('modalTaskTitle');
  if (titleEl) titleEl.textContent = taskTitle;
  const modal = document.getElementById('completionModal');
  if (modal) modal.classList.add('active');
}

async function submitCompletion() {
  if (!completingTaskId) return;
  const actualMinutes = parseInt(document.getElementById('actualMinutesInput').value, 10) || 30;
  const btn = document.getElementById('confirmCompleteBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch(`${API_BASE}/api/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: completingTaskId, actual_minutes: actualMinutes })
    });

    if (!res.ok) throw new Error('Failed to complete task');

    document.getElementById('completionModal').classList.remove('active');
    completingTaskId = null;
    fetchPlan();
  } catch (err) {
    alert(err.message || 'Error completing task');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log & Complete';
  }
}

async function snoozeTask(taskId, days = 1) {
  try {
    const res = await fetch(`${API_BASE}/api/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, days })
    });
    if (!res.ok) throw new Error('Failed to snooze task');
    fetchPlan();
  } catch (err) {
    alert(err.message || 'Failed to snooze task');
  }
}

async function saveAddTask() {
  const titleInput = document.getElementById('newTaskTitleInput');
  const notesInput = document.getElementById('newTaskNotesInput');
  const title = titleInput.value.trim();
  const notes = notesInput.value.trim();

  if (!title) {
    alert('Please enter a task title.');
    return;
  }

  const saveBtn = document.getElementById('saveAddTaskBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Creating...';

  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, notes, priority_raw: 0 })
    });
    if (!res.ok) throw new Error('Failed to add task');

    titleInput.value = '';
    notesInput.value = '';
    document.getElementById('addTaskModal').classList.remove('active');
    fetchPlan();
  } catch (err) {
    alert(err.message || 'Error adding task');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Create Task';
  }
}

async function triggerReschedule() {
  const rescheduleBtn = document.getElementById('rescheduleBtn');
  if (rescheduleBtn) {
    rescheduleBtn.disabled = true;
    rescheduleBtn.textContent = '⚡ Solving...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/reschedule`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to reschedule');
    fetchPlan();
  } catch (err) {
    alert(err.message || 'Error rescheduling');
  } finally {
    if (rescheduleBtn) {
      rescheduleBtn.disabled = false;
      rescheduleBtn.textContent = '⚡ Re-Solve';
    }
  }
}

/* ===================================================
   HISTORY AUDIT LOG
=================================================== */
async function fetchHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/history`);
    if (!res.ok) return;
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
    card.className = 'stream-card';

    const dtComp = item.completed_at ? new Date(item.completed_at) : new Date();
    const dateFormatted = dtComp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    card.innerHTML = `
      <div class="stream-card-left">
        <div class="stream-card-time" style="background:#dcfce7; color:#166534;">✓<br>${dateFormatted.split(',')[0]}</div>
        <div class="stream-card-info">
          <div class="stream-card-title">${escapeHtml(item.title)}</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
            Completed at ${dateFormatted} • Est: ${item.estimated_minutes}m
          </div>
        </div>
      </div>
      <div class="stream-card-controls">
        <span style="font-size: 12px; font-weight: 700; color: var(--text-muted);">Logged:</span>
        <input type="number" id="logInput_${item.id}" value="${item.actual_minutes}" min="0" style="width: 55px; padding: 4px; border-radius: 6px; border: 1px solid var(--border-card); font-weight: 700; text-align: center;">
        <span style="font-size: 12px; color: var(--text-muted);">m</span>
        <button class="btn-card-done" id="saveLogBtn_${item.id}">Save</button>
      </div>
    `;

    const saveBtn = card.querySelector(`#saveLogBtn_${item.id}`);
    if (saveBtn) {
      saveBtn.addEventListener('click', () => updateLoggedTime(item.id, saveBtn));
    }

    historyCardsGrid.appendChild(card);
  });
}

async function updateLoggedTime(recordId, buttonEl) {
  const inputEl = document.getElementById(`logInput_${recordId}`);
  if (!inputEl) return;
  const actualMinutes = parseInt(inputEl.value, 10);
  if (isNaN(actualMinutes) || actualMinutes < 0) {
    alert('Please enter valid minutes.');
    return;
  }

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = '...';
  }

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
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Save';
    }
  }
}

/* ===================================================
   SETTINGS
=================================================== */
function populateSettingsForm() {
  const activeDays = currentConfig.active_days || [0, 1, 2, 3, 4];
  const dayChips = document.querySelectorAll('#activeDaysSelector .day-chip');
  dayChips.forEach(chip => {
    const day = parseInt(chip.dataset.day, 10);
    if (activeDays.includes(day)) chip.classList.add('active');
    else chip.classList.remove('active');
  });

  document.getElementById('workStartHourInput').value = currentConfig.work_start_hour || 10;
  document.getElementById('workEndHourInput').value = currentConfig.work_end_hour || 17;
  document.getElementById('bufferMinutesInput').value = currentConfig.buffer_minutes || 10;
  document.getElementById('maxTasksPerDayInput').value = currentConfig.max_tasks_per_day || 3;
}

async function saveSettings() {
  const activeDays = [];
  document.querySelectorAll('#activeDaysSelector .day-chip.active').forEach(chip => {
    activeDays.push(parseInt(chip.dataset.day, 10));
  });

  const payload = {
    active_days: activeDays,
    work_start_hour: parseInt(document.getElementById('workStartHourInput').value, 10),
    work_end_hour: parseInt(document.getElementById('workEndHourInput').value, 10),
    buffer_minutes: parseInt(document.getElementById('bufferMinutesInput').value, 10),
    max_tasks_per_day: parseInt(document.getElementById('maxTasksPerDayInput').value, 10),
    high_energy_start_hour: 9,
    high_energy_end_hour: 12
  };

  try {
    const res = await fetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to save settings');
    currentConfig = payload;
    document.getElementById('settingsModal').classList.remove('active');
    fetchPlan();
  } catch (err) {
    alert(err.message || 'Error saving settings');
  }
}

/* ===================================================
   OAUTH RE-AUTH
=================================================== */
async function handleLaunchOAuth() {
  const launchBtn = document.getElementById('btnLaunchOAuth');
  const redirectUri = 'http://localhost:8000/api/auth/callback';
  if (launchBtn) {
    launchBtn.disabled = true;
    launchBtn.textContent = 'Generating Link...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/url?redirect_uri=${encodeURIComponent(redirectUri)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to get auth URL');

    if (data.auth_url) {
      window.open(data.auth_url, '_blank');
    }
  } catch (err) {
    alert(err.message || 'Failed to generate authorization URL');
  } finally {
    if (launchBtn) {
      launchBtn.disabled = false;
      launchBtn.innerHTML = `<span>🌐</span> Authorize with Google Account`;
    }
  }
}

async function handleSubmitAuthCode() {
  const input = document.getElementById('authCodeInput');
  const submitBtn = document.getElementById('submitAuthCodeBtn');
  let rawInput = input ? input.value.trim() : '';
  const redirectUri = 'http://localhost:8000/api/auth/callback';

  if (!rawInput) {
    alert('Please enter or paste the Google Authorization Code (or redirected URL).');
    return;
  }

  let code = rawInput;
  if (rawInput.includes('code=')) {
    try {
      const urlObj = new URL(rawInput.startsWith('http') ? rawInput : 'http://localhost/' + rawInput);
      code = urlObj.searchParams.get('code') || rawInput;
    } catch (e) {
      const match = rawInput.match(/code=([^&]+)/);
      if (match) code = decodeURIComponent(match[1]);
    }
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to exchange authorization code');

    alert('✅ Successfully re-authenticated with Google!');
    const authModal = document.getElementById('authModal');
    if (authModal) authModal.classList.remove('active');
    if (input) input.value = '';
    fetchPlan();
  } catch (err) {
    alert(err.message || 'OAuth code exchange failed.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Code & Connect';
    }
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
