const API_BASE = '';

let currentTasks = [];
let currentSchedule = { blocks: [], fixed_events: [], unscheduled_task_ids: [], solver_stats: {} };
let currentConfig = { active_days: [0, 1, 2, 3, 4], work_start_hour: 10, work_end_hour: 17, buffer_minutes: 10, max_tasks_per_day: 3 };
let currentKidsData = { kids: [], recent_history: [] };

let completingTaskId = null;
let completingTaskTitle = '';
let completingTaskEst = 30;

let selectedChoreKid = 'Vivaan';
let choreStarDelta = 1;
let selectedNewTaskPrio = 2;
let quickCapturePrio = 2;
let currentStreamView = 'board'; // 'board' | 'today' | 'upcoming' | 'backlog'

// Focus Sprint Timer State
let sprintTimerSeconds = 25 * 60;
let sprintTimerDefaultSeconds = 25 * 60;
let sprintTimerInterval = null;
let isSprintRunning = false;

/**
 * Returns YYYY-MM-DD in America/Los_Angeles local timezone (never UTC!)
 */
function getLocalDateStr(dateObj = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(dateObj);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch (e) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

let selectedGanttDate = getLocalDateStr();
let hasUserSelectedGanttDate = false;

/**
 * Non-blocking toast notification helper
 */
function showToast(message, type = 'info', actionLabel = null, onAction = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  if (actionLabel && typeof onAction === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action-btn';
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', () => {
      onAction();
      toast.remove();
    });
    toast.appendChild(actionBtn);
  }

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, 4500);
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initClock();
  initTabletPreferences();
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
    let timeFormatted = '';
    let dateFormatted = '';

    try {
      timeFormatted = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).format(now);

      dateFormatted = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }).format(now);
    } catch (e) {
      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHour = hours % 12 || 12;
      timeFormatted = `${displayHour}:${minutes} ${ampm}`;
      dateFormatted = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    }

    if (clockTime) clockTime.textContent = timeFormatted;
    if (scheduleNowTime) scheduleNowTime.textContent = `NOW ${timeFormatted}`;
    if (clockDate) clockDate.textContent = dateFormatted;

    // Live update hero countdown & progress every 15 seconds
    if (now.getSeconds() % 15 === 0 && currentTasks.length > 0) {
      renderCurrentFocusHero();
    }

    // Check day/night transition in auto theme mode when minute ticks
    if (now.getSeconds() === 0) {
      checkAutoThemeTransition();
    }
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

  if (openAddTaskBtn) {
    openAddTaskBtn.addEventListener('click', () => {
      addTaskModal.classList.add('active');
      const titleInput = document.getElementById('newTaskTitleInput');
      if (titleInput) setTimeout(() => titleInput.focus(), 60);
    });
  }
  if (cancelAddTaskBtn) cancelAddTaskBtn.addEventListener('click', () => addTaskModal.classList.remove('active'));
  if (saveAddTaskBtn) saveAddTaskBtn.addEventListener('click', saveAddTask);

  // Add Task Priority Selector Chips
  const prioChips = document.querySelectorAll('#newTaskPriorityGroup .prio-select-chip');
  prioChips.forEach(chip => {
    chip.addEventListener('click', () => {
      prioChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedNewTaskPrio = parseInt(chip.dataset.prio, 10) || 2;
    });
  });

  // Add Task Quick Due Date Chips
  const quickDueChips = document.querySelectorAll('.quick-due-chip');
  quickDueChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const dueInput = document.getElementById('newTaskDueInput');
      if (!dueInput) return;
      const offset = chip.dataset.dueOffset;
      if (offset === 'clear') {
        dueInput.value = '';
      } else {
        const d = new Date();
        d.setDate(d.getDate() + (parseInt(offset, 10) || 0));
        dueInput.value = getLocalDateStr(d);
      }
    });
  });

  // Stream View Tabs (Today | Upcoming | Unscheduled)
  const streamTabBtns = document.querySelectorAll('#streamViewTabs .stream-tab-btn');
  streamTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      streamTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentStreamView = btn.dataset.view || 'today';
      renderScheduleStream();
    });
  });

  // Fullscreen / Kiosk Toggle for Wall Tablets
  const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
  if (toggleFullscreenBtn) {
    toggleFullscreenBtn.addEventListener('click', toggleKioskFullscreen);
  }
  document.addEventListener('fullscreenchange', updateFullscreenButtonState);

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

  const dayChips = document.querySelectorAll('#activeDaysSelector .day-chip');
  dayChips.forEach(chip => chip.addEventListener('click', () => chip.classList.toggle('active')));

  // Theme Toggle Button in Header
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', toggleThemeCycle);
  }

  // Tablet Screen Sleep Button in Header + Full-Screen Pitch-Black Sleep Curtain
  const toggleScreenBtn = document.getElementById('toggleScreenBtn');
  const screenSleepOverlay = document.getElementById('screenSleepOverlay');
  let sleepEnteredAt = 0;

  async function enterScreenSleepMode() {
    sleepEnteredAt = Date.now();
    document.body.classList.add('screen-is-sleeping');
    if (screenSleepOverlay) {
      screenSleepOverlay.classList.remove('hidden');
    }
    try {
      await fetch('/api/tablet/screen/sleep', { method: 'POST' });
    } catch (err) {
      console.error('Failed to trigger screen sleep:', err);
    }
  }

  async function exitScreenSleepMode(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    // Guard against synthetic touch/click bounce right after entering sleep
    if (Date.now() - sleepEnteredAt < 450) return;
    if (!document.body.classList.contains('screen-is-sleeping')) return;

    document.body.classList.remove('screen-is-sleeping');
    if (screenSleepOverlay) {
      screenSleepOverlay.classList.add('hidden');
    }
    try {
      await fetch('/api/tablet/screen/wake', { method: 'POST' });
      fetchPlan();
      fetchKidsStars();
    } catch (err) {
      console.error('Failed to trigger screen wake:', err);
    }
  }

  if (toggleScreenBtn) {
    toggleScreenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterScreenSleepMode();
    });
  }

  if (screenSleepOverlay) {
    screenSleepOverlay.addEventListener('click', exitScreenSleepMode);
    screenSleepOverlay.addEventListener('touchstart', exitScreenSleepMode, { passive: false });
  }

  // Theme Preference Chips in Settings Modal
  const themeChips = document.querySelectorAll('#themePreferenceGroup .theme-chip');
  themeChips.forEach(chip => {
    chip.addEventListener('click', () => {
      setThemePreference(chip.dataset.themePref);
    });
  });

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
  const dismissAuthBannerBtn = document.getElementById('dismissAuthBannerBtn');
  const headerStatusPill = document.getElementById('headerStatusPill');
  const cancelAuthBtn = document.getElementById('cancelAuthBtn');
  const btnLaunchOAuth = document.getElementById('btnLaunchOAuth');
  const submitAuthCodeBtn = document.getElementById('submitAuthCodeBtn');
  const authModal = document.getElementById('authModal');

  if (bannerAuthBtn) bannerAuthBtn.addEventListener('click', () => authModal.classList.add('active'));
  if (headerStatusPill) headerStatusPill.addEventListener('click', () => authModal.classList.add('active'));
  if (dismissAuthBannerBtn) {
    dismissAuthBannerBtn.addEventListener('click', () => {
      window.isAuthBannerDismissed = true;
      const banner = document.getElementById('googleAuthBanner');
      if (banner) banner.classList.add('hidden');
    });
  }
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

  // Inline AI Quick-Capture Omnibar
  const quickCaptureForm = document.getElementById('quickCaptureForm');
  const quickCaptureInput = document.getElementById('quickCaptureInput');
  const quickCapturePrioBtn = document.getElementById('quickCapturePrioBtn');

  if (quickCapturePrioBtn) {
    quickCapturePrioBtn.addEventListener('click', () => {
      quickCapturePrio = quickCapturePrio === 1 ? 2 : (quickCapturePrio === 2 ? 3 : 1);
      const labels = { 1: 'P1 Urgent', 2: 'P2 High', 3: 'P3 Focus' };
      quickCapturePrioBtn.textContent = labels[quickCapturePrio];
      quickCapturePrioBtn.className = `omnibar-prio-pill prio-${quickCapturePrio}`;
    });
  }

  if (quickCaptureForm) {
    quickCaptureForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!quickCaptureInput) return;
      const rawTitle = quickCaptureInput.value.trim();
      if (!rawTitle) {
        quickCaptureInput.focus();
        return;
      }
      const submitBtn = document.getElementById('quickCaptureSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: rawTitle,
            notes: '',
            priority_score: quickCapturePrio,
            due: null
          })
        });
        if (!res.ok) throw new Error('Failed to create task');
        quickCaptureInput.value = '';
        quickCaptureInput.blur();
        showToast(`⚡ AI scheduled "${rawTitle}" (P${quickCapturePrio})`, 'success');
        fetchPlan();
      } catch (err) {
        showToast(err.message || 'Quick capture failed', 'error');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // Live Focus Sprint Timer Controls
  const heroTimerToggleBtn = document.getElementById('heroTimerToggleBtn');
  const heroTimerResetBtn = document.getElementById('heroTimerResetBtn');
  if (heroTimerToggleBtn) {
    heroTimerToggleBtn.addEventListener('click', toggleFocusSprintTimer);
  }
  if (heroTimerResetBtn) {
    heroTimerResetBtn.addEventListener('click', () => resetFocusSprintTimer(sprintTimerDefaultSeconds));
  }

  // Keyboard shortcuts (Escape, Enter, Cmd+K / '/' for Omnibar, N for New Task Modal)
  document.addEventListener('keydown', (e) => {
    const activeModal = document.querySelector('.modal-overlay.active');
    if (e.key === 'Escape') {
      if (activeModal) {
        activeModal.classList.remove('active');
        if (activeModal.id === 'completionModal') completingTaskId = null;
        return;
      }
      if (document.activeElement === quickCaptureInput) {
        quickCaptureInput.blur();
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (quickCaptureInput) {
        quickCaptureInput.focus();
        quickCaptureInput.select();
      }
      return;
    }

    if (e.key === 'Enter' && activeModal && e.target.tagName !== 'TEXTAREA') {
      if (activeModal.id === 'addTaskModal') {
        e.preventDefault();
        saveAddTask();
      } else if (activeModal.id === 'completionModal') {
        e.preventDefault();
        submitCompletion();
      }
      return;
    }

    const isInputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (!activeModal && !isInputFocused && e.key === '/' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (quickCaptureInput) quickCaptureInput.focus();
      return;
    }

    if (!activeModal && !isInputFocused && (e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (addTaskModal) {
        addTaskModal.classList.add('active');
        const titleInput = document.getElementById('newTaskTitleInput');
        if (titleInput) setTimeout(() => titleInput.focus(), 50);
      }
    }
  });
}

function formatSprintSeconds(sec) {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateSprintTimerUI() {
  const display = document.getElementById('heroTimerDisplay');
  const toggleBtn = document.getElementById('heroTimerToggleBtn');
  const bar = document.getElementById('heroTimerBar');
  if (display) display.textContent = formatSprintSeconds(sprintTimerSeconds);
  if (toggleBtn) toggleBtn.textContent = isSprintRunning ? '⏸ Pause' : '▶ Start';
  if (bar) bar.classList.toggle('timer-running', isSprintRunning);
}

function toggleFocusSprintTimer() {
  if (isSprintRunning) {
    clearInterval(sprintTimerInterval);
    sprintTimerInterval = null;
    isSprintRunning = false;
    updateSprintTimerUI();
  } else {
    isSprintRunning = true;
    updateSprintTimerUI();
    sprintTimerInterval = setInterval(() => {
      if (sprintTimerSeconds > 0) {
        sprintTimerSeconds--;
        updateSprintTimerUI();
      } else {
        clearInterval(sprintTimerInterval);
        sprintTimerInterval = null;
        isSprintRunning = false;
        updateSprintTimerUI();
        showToast('🎯 Focus sprint complete! Ready to log completion.', 'success');
      }
    }, 1000);
  }
}

function resetFocusSprintTimer(newDurationSec = 25 * 60) {
  if (sprintTimerInterval) {
    clearInterval(sprintTimerInterval);
    sprintTimerInterval = null;
  }
  isSprintRunning = false;
  sprintTimerDefaultSeconds = newDurationSec;
  sprintTimerSeconds = newDurationSec;
  updateSprintTimerUI();
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
    showToast(err.message || 'Failed to award star', 'error');
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

    const newestRecord = (data.recent_history && data.recent_history[0]) ? data.recent_history[0] : null;
    showToast(
      `⭐ Awarded +${delta} star${delta > 1 ? 's' : ''} to ${kidName}!`,
      'success',
      newestRecord ? 'Undo' : null,
      newestRecord ? () => deleteStarRecord(newestRecord.id) : null
    );
  } catch (err) {
    console.error('Error awarding star:', err);
    throw err;
  }
}

async function deleteStarRecord(recordId) {
  try {
    const res = await fetch(`${API_BASE}/api/kids/stars/${recordId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to undo star');
    currentKidsData = await res.json();
    renderKidsStarWidget();
    showToast('Removed star entry', 'info');
  } catch (err) {
    showToast(err.message || 'Could not undo star', 'error');
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

function getKidRankInfo(totalStars) {
  const level = Math.floor((totalStars || 0) / 10) + 1;
  if (level <= 1) return { level, title: 'Star Cadet', icon: '🚀' };
  if (level === 2) return { level, title: 'Chore Ninja', icon: '🥷' };
  if (level === 3) return { level, title: 'Galaxy Hero', icon: '🦸' };
  return { level, title: 'Supernova Legend', icon: '👑' };
}

function renderKidsStarWidget() {
  const kidsProfilesGrid = document.getElementById('kidsProfilesGrid');
  const kidsTimeseriesChart = document.getElementById('kidsTimeseriesChart');
  const recentChoresTicker = document.getElementById('recentChoresTicker');
  const kidsArenaTotalBadge = document.getElementById('kidsArenaTotalBadge');

  if (!kidsProfilesGrid || !currentKidsData.kids) return;

  const MILESTONE_STEP = 10;
  const totalFamilyStars = currentKidsData.kids.reduce((sum, k) => sum + (k.total_stars || 0), 0);
  if (kidsArenaTotalBadge) {
    kidsArenaTotalBadge.textContent = `🏆 ${totalFamilyStars} Family Star${totalFamilyStars === 1 ? '' : 's'}`;
  }

  const maxKidStars = Math.max(0, ...currentKidsData.kids.map(k => k.total_stars || 0));
  const QUICK_MISSIONS = [
    { icon: '🛏️', label: 'Bed', desc: 'Made Bed' },
    { icon: '🧹', label: 'Room', desc: 'Cleaned Room' },
    { icon: '📚', label: 'Study', desc: 'Homework & Reading' },
    { icon: '🍽️', label: 'Dishes', desc: 'Helped with Dishes' }
  ];

  // 1. Render Full-Stage Kid Hero Cards
  kidsProfilesGrid.innerHTML = '';
  currentKidsData.kids.forEach(kid => {
    const card = document.createElement('div');
    const isVivaan = kid.kid_name.toLowerCase().includes('vivaan');
    card.className = `kid-profile-card ${isVivaan ? 'kid-card-vivaan' : 'kid-card-vrihaan'}`;

    const total = kid.total_stars || 0;
    const rank = getKidRankInfo(total);
    const starsInTier = total % MILESTONE_STEP;
    const filledSlots = total > 0 && starsInTier === 0 ? MILESTONE_STEP : starsInTier;
    const nextTierTarget = (Math.floor(total / MILESTONE_STEP) + 1) * MILESTONE_STEP;
    const starsToNext = nextTierTarget - total;
    const goalPct = Math.min(100, Math.round((filledSlots / MILESTONE_STEP) * 100));
    const isLeading = total > 0 && total === maxKidStars;

    let starSlotsHtml = '';
    for (let i = 1; i <= MILESTONE_STEP; i++) {
      const isEarned = i <= filledSlots;
      starSlotsHtml += `<span class="kid-star-slot ${isEarned ? 'earned' : 'empty'}" title="Star ${i} of ${MILESTONE_STEP}">${isEarned ? '★' : '☆'}</span>`;
    }

    const missionsHtml = QUICK_MISSIONS.map(m => `
      <button type="button" class="btn-kid-mission" data-chore="${escapeHtml(m.desc)}" title="Award +1 Star for ${escapeHtml(m.desc)}">
        <span class="mission-emoji">${m.icon}</span>
        <span class="mission-name">${escapeHtml(m.label)}</span>
        <span class="mission-plus">+1★</span>
      </button>
    `).join('');

    card.innerHTML = `
      <div class="kid-card-top-bar">
        <span class="kid-level-badge">${rank.icon} LVL ${rank.level} · ${rank.title}</span>
        ${isLeading ? `<span class="kid-leader-pill">👑 Leader</span>` : `<span class="kid-today-stars">+${kid.today_stars} today</span>`}
      </div>

      <div class="kid-hero-identity">
        <div class="kid-avatar ${isVivaan ? 'vivaan' : 'vrihaan'}">${isVivaan ? '🚀' : '⚡'}</div>
        <div class="kid-identity-text">
          <div class="kid-name">${escapeHtml(kid.kid_name)}</div>
          <div class="kid-streak-sub">+${kid.today_stars} earned today</div>
        </div>
        <div class="kid-stars-count" title="${total} Total Stars">
          <span>${total}</span>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="#f59e0b" stroke="#d97706" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        </div>
      </div>

      <div class="kid-goal-wrapper">
        <div class="kid-goal-label">
          <span>Next Milestone (${nextTierTarget}★ Prize)</span>
          <span>${starsToNext}★ to go</span>
        </div>
        <div class="kid-star-slots-grid" aria-label="${filledSlots} of ${MILESTONE_STEP} stars toward next reward">
          ${starSlotsHtml}
        </div>
        <div class="kid-goal-track">
          <div class="kid-goal-fill" style="width:${goalPct}%;"></div>
        </div>
      </div>

      <div class="kid-missions-section">
        <div class="kid-missions-heading">1-TAP CHORE MISSIONS</div>
        <div class="kid-mission-grid">
          ${missionsHtml}
        </div>
      </div>

      <button class="btn-instant-star" data-kid="${escapeHtml(kid.kid_name)}">
        <span>⚡ Quick +1 Star Bonus</span>
      </button>
    `;

    card.querySelectorAll('.btn-kid-mission').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const choreDesc = btn.getAttribute('data-chore') || 'Chore Completed';
        card.classList.add('star-reward-active');
        setTimeout(() => card.classList.remove('star-reward-active'), 450);
        awardStar(kid.kid_name, 1, choreDesc);
      });
    });

    const instantBtn = card.querySelector('.btn-instant-star');
    if (instantBtn) {
      instantBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.add('star-reward-active');
        setTimeout(() => card.classList.remove('star-reward-active'), 450);
        awardStar(kid.kid_name, 1, 'Quick Star Reward');
      });
    }

    kidsProfilesGrid.appendChild(card);
  });

  // 2. Render 7-Day Timeseries Bars with Numeric Labels
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
      const heightPercent = totalDay === 0 ? 12 : Math.max(22, Math.round((totalDay / maxDayStars) * 80));

      const h1Percent = totalDay > 0 ? (s1 / totalDay) * 100 : 0;
      const h2Percent = totalDay > 0 ? (s2 / totalDay) * 100 : 0;

      const shortDay = dayLabel.split(' ')[0];

      col.innerHTML = `
        <span class="day-bar-val">${totalDay > 0 ? `+${totalDay}` : ''}</span>
        <div class="bar-stack" style="height: ${heightPercent}%;" title="${dayLabel}: Vivaan (${s1}), Vrihaan (${s2})">
          ${s1 > 0 ? `<div class="bar-segment-v1" style="height:${h1Percent}%;"></div>` : ''}
          ${s2 > 0 ? `<div class="bar-segment-v2" style="height:${h2Percent}%;"></div>` : ''}
        </div>
        <span class="day-bar-label">${shortDay}</span>
      `;

      kidsTimeseriesChart.appendChild(col);
    });
  }

  // 3. Render Recent Chores Trophy Feed with Undo Button
  if (recentChoresTicker && currentKidsData.recent_history) {
    if (currentKidsData.recent_history.length === 0) {
      recentChoresTicker.innerHTML = `<span style="color:var(--text-subtle); font-size:12px;">No stars logged yet. Tap any chore mission above!</span>`;
    } else {
      recentChoresTicker.innerHTML = '';
      currentKidsData.recent_history.slice(0, 5).forEach(h => {
        const row = document.createElement('div');
        row.className = 'chore-ticker-row';
        const desc = h.chore_description ? ` · ${h.chore_description}` : '';
        row.innerHTML = `
          <span class="chore-ticker-text">⭐ <strong>${escapeHtml(h.kid_name)}</strong> <span class="chore-delta-badge">+${h.stars_delta}★</span>${escapeHtml(desc)}</span>
          <button class="btn-undo-star" title="Undo this star entry">✕</button>
        `;
        const undoBtn = row.querySelector('.btn-undo-star');
        if (undoBtn && h.id) {
          undoBtn.addEventListener('click', () => deleteStarRecord(h.id));
        }
        recentChoresTicker.appendChild(row);
      });
    }
  }
}

let isFetchingPlan = false;
async function fetchPlan() {
  if (isFetchingPlan) return;
  isFetchingPlan = true;
  try {
    const res = await fetch(`${API_BASE}/api/plan`);
    if (!res.ok) throw new Error('Failed to fetch plan');
    const data = await res.json();
    currentTasks = data.tasks || [];
    currentSchedule = data.schedule || { blocks: [], fixed_events: [], unscheduled_task_ids: [], solver_stats: {} };
    currentConfig = data.config || currentConfig;

    const solverBadge = document.getElementById('solverTelemetryBadge');
    if (solverBadge && currentSchedule.solver_stats) {
      const ms = Math.max(1, Math.round((currentSchedule.solver_stats.time_sec || 0.004) * 1000));
      solverBadge.textContent = `CP-SAT · ${ms}ms`;
    }

    updateAuthStatus(data.status);
    renderCurrentFocusHero();
    renderCapacityMeter();
    renderScheduleStream();
    renderGanttChart();
  } catch (err) {
    console.error('Error fetching plan:', err);
  } finally {
    isFetchingPlan = false;
  }
}

function updateAuthStatus(statusData) {
  const googleAuthBanner = document.getElementById('googleAuthBanner');
  const headerStatusPill = document.getElementById('headerStatusPill');
  if (!googleAuthBanner) return;

  const isConnected = statusData && statusData.google_connected;
  const authError = statusData && statusData.google_auth_error;

  if (!isConnected || authError) {
    if (!window.isAuthBannerDismissed) {
      googleAuthBanner.classList.remove('hidden');
    }
    if (headerStatusPill) {
      headerStatusPill.innerHTML = `<span class="status-dot" style="background:#ef4444;"></span><span>Disconnected · Reconnect</span>`;
    }
    const authModalMessage = document.getElementById('authModalMessage');
    if (authModalMessage && authError) {
      authModalMessage.textContent = authError;
    }
  } else {
    window.isAuthBannerDismissed = false;
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
  const heroProgressFill = document.getElementById('heroProgressFill');

  if (!heroTaskTitle) return;

  const blocks = currentSchedule.blocks || [];
  const fixedEvents = currentSchedule.fixed_events || [];
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));
  const todayStr = getLocalDateStr();

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
      if (heroProgressFill) heroProgressFill.style.width = '0%';
    } else {
      if (heroBadge) heroBadge.textContent = 'CURRENT FOCUS';
      const minsLeft = Math.max(1, Math.round((activeItem.end - nowMs) / 60000));
      if (heroTimeRemaining) heroTimeRemaining.textContent = `${minsLeft}m left`;
      if (heroProgressFill) {
        const totalDuration = Math.max(1, activeItem.end - activeItem.start);
        const elapsedPct = Math.min(100, Math.max(2, Math.round(((nowMs - activeItem.start) / totalDuration) * 100)));
        heroProgressFill.style.width = `${elapsedPct}%`;
      }
    }

    const activeTask = taskMap.get(activeItem.task_id);
    const estMins = activeTask ? (activeTask.estimated_minutes || 30) : Math.round((activeItem.end - activeItem.start) / 60000);
    let dueInfo = '';
    if (activeTask && activeTask.due) {
      try {
        const dueDateOnly = activeTask.due.slice(0, 10);
        const dueDt = new Date(dueDateOnly + 'T12:00:00');
        const dueStr = dueDt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const isOverdue = dueDateOnly < todayStr;
        dueInfo = ` <span style="font-size: 13px; color:${isOverdue ? '#f87171' : '#60a5fa'}; font-weight:700;">📅 Due ${dueStr}</span>`;
      } catch (e) {}
    }

    if (heroTimeRange) heroTimeRange.textContent = `${fmtTime(dtStart)} - ${fmtTime(dtEnd)}`;
    if (heroTaskTitle) heroTaskTitle.innerHTML = `${escapeHtml(activeItem.title)}${dueInfo}`;
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
            <span>🌙</span> Snooze 1 Day
          </button>
        `;
        const cBtn = document.getElementById('heroCompleteBtn');
        const sBtn = document.getElementById('heroSnoozeBtn');
        if (cBtn) cBtn.addEventListener('click', () => openCompleteModal(activeItem.task_id, activeItem.title, estMins));
        if (sBtn) sBtn.addEventListener('click', () => snoozeTask(activeItem.task_id, 1, activeItem.title));
      }
    }
  } else {
    // Check if there are upcoming blocks on the next workday vs genuinely all done today
    const solverStats = currentSchedule.solver_stats || {};
    const completedToday = solverStats.completed_today_count || 0;
    const futureBlocks = blocks
      .filter(b => b.start.slice(0, 10) > todayStr)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    if (completedToday === 0 && futureBlocks.length > 0) {
      const nextBlock = futureBlocks[0];
      const nextTask = taskMap.get(nextBlock.task_id);
      const nextStart = new Date(nextBlock.start);
      const nextEnd = new Date(nextBlock.end);
      const dayLabel = nextStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const estMins = nextTask ? (nextTask.estimated_minutes || 30) : Math.round((nextEnd - nextStart) / 60000);

      if (heroBadge) heroBadge.textContent = 'NEXT WORKDAY SPOTLIGHT';
      if (heroTimeRemaining) heroTimeRemaining.textContent = `Scheduled ${dayLabel}`;
      if (heroTimeRange) heroTimeRange.textContent = `${dayLabel} • ${fmtTime(nextStart)} - ${fmtTime(nextEnd)}`;
      if (heroTaskTitle) heroTaskTitle.textContent = nextBlock.task_title;
      if (heroTaskDirective) {
        heroTaskDirective.textContent = `Today's schedule is clear (${completedToday}/${currentConfig.max_tasks_per_day || 3} slots used). Pull this #1 priority task into Today if you want to get ahead.`;
      }
      if (heroProgressFill) heroProgressFill.style.width = '0%';
      if (heroActionsGroup) {
        heroActionsGroup.innerHTML = `
          <button class="btn-hero-complete" id="heroPullTodayBtn" style="background: linear-gradient(135deg, #6366f1, #4f46e5);">
            <span>⚡</span> Pull into Today
          </button>
          <button class="btn-hero-snooze" id="heroCompleteEarlyBtn">
            <span>✓</span> Complete Now
          </button>
        `;
        const pullBtn = document.getElementById('heroPullTodayBtn');
        const compBtn = document.getElementById('heroCompleteEarlyBtn');
        if (pullBtn) pullBtn.addEventListener('click', () => pullTaskToToday(nextBlock.task_id, nextBlock.task_title));
        if (compBtn) compBtn.addEventListener('click', () => openCompleteModal(nextBlock.task_id, nextBlock.task_title, estMins));
      }
    } else {
      // Genuinely finished today's quota or zero tasks in queue
      if (heroBadge) heroBadge.textContent = 'ALL CLEAR';
      if (heroTimeRemaining) heroTimeRemaining.textContent = completedToday > 0 ? `${completedToday} done today` : 'Schedule clear';
      if (heroTimeRange) heroTimeRange.textContent = 'Free Time';
      if (heroTaskTitle) heroTaskTitle.textContent = completedToday > 0 ? 'All Done For Today!' : 'No Tasks Scheduled Today';
      if (heroTaskDirective) {
        heroTaskDirective.textContent = completedToday > 0
          ? `Great job! You completed ${completedToday} focus ${completedToday === 1 ? 'task' : 'tasks'} today.`
          : 'Your schedule is wide open today. Add a task or pull one from Upcoming.';
      }
      if (heroProgressFill) heroProgressFill.style.width = completedToday > 0 ? '100%' : '0%';
      if (heroActionsGroup) {
        heroActionsGroup.innerHTML = `
          <button class="btn-hero-complete" id="heroAddTaskFastBtn">
            <span>+</span> Add Task
          </button>
        `;
        const addBtn = document.getElementById('heroAddTaskFastBtn');
        if (addBtn) addBtn.addEventListener('click', () => document.getElementById('addTaskModal').classList.add('active'));
      }
    }
  }
}

/* ===================================================
   TACTILE 3-SLOT DAILY CAPACITY LOADOUT (Completed + Scheduled <= Max)
=================================================== */
function renderCapacityMeter() {
  const ratioTag = document.getElementById('capacityRatioTag');
  const meterFill = document.getElementById('capacityMeterFill');
  const meterScheduled = document.getElementById('capacityMeterScheduled');
  const slotsGrid = document.getElementById('capacitySlotsGrid');
  const metaDetail = document.getElementById('capacityMetaDetail');
  const slotsLeft = document.getElementById('capacitySlotsLeft');

  const solverStats = currentSchedule.solver_stats || {};
  const completedToday = solverStats.completed_today_count || 0;
  const maxPerDay = currentConfig.max_tasks_per_day || 3;

  const todayStr = getLocalDateStr();
  const blocks = currentSchedule.blocks || [];
  const todayScheduledBlocks = blocks
    .filter(b => b.start.startsWith(todayStr))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  const futureBlocks = blocks
    .filter(b => b.start.slice(0, 10) > todayStr)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const scheduledToday = todayScheduledBlocks.length;
  const totalCommitted = completedToday + scheduledToday;
  const openSlots = Math.max(0, maxPerDay - totalCommitted);

  const completedPct = Math.min(100, Math.round((completedToday / maxPerDay) * 100));
  const scheduledPct = Math.min(100 - completedPct, Math.round((scheduledToday / maxPerDay) * 100));

  if (ratioTag) ratioTag.textContent = `${totalCommitted}/${maxPerDay} Slots`;
  if (meterFill) meterFill.style.width = `${completedPct}%`;
  if (meterScheduled) meterScheduled.style.width = `${scheduledPct}%`;

  const fmtShortTime = (isoStr) => {
    try {
      const d = new Date(isoStr);
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${m} ${ampm}`;
    } catch (e) {
      return '';
    }
  };

  if (slotsGrid) {
    slotsGrid.innerHTML = '';
    const slotCount = Math.max(maxPerDay, totalCommitted);
    for (let i = 0; i < slotCount; i++) {
      const bay = document.createElement('div');
      const slotNum = String(i + 1).padStart(2, '0');

      if (i < completedToday) {
        bay.className = 'capacity-slot-bay slot-done';
        bay.innerHTML = `
          <div class="slot-bay-left">
            <span class="slot-bay-index">SLOT ${slotNum}</span>
            <span class="slot-bay-title">✓ Completed focus block</span>
          </div>
          <span class="slot-bay-meta">DONE</span>
        `;
      } else if (i < completedToday + scheduledToday) {
        const blk = todayScheduledBlocks[i - completedToday];
        bay.className = 'capacity-slot-bay slot-scheduled';
        bay.title = 'Click to complete this focus block';
        bay.innerHTML = `
          <div class="slot-bay-left">
            <span class="slot-bay-index">SLOT ${slotNum}</span>
            <span class="slot-bay-title">${escapeHtml(blk.task_title)}</span>
          </div>
          <span class="slot-bay-meta">${fmtShortTime(blk.start)}</span>
        `;
        bay.addEventListener('click', () => {
          const est = Math.max(15, Math.round((new Date(blk.end) - new Date(blk.start)) / 60000));
          openCompleteModal(blk.task_id, blk.task_title, est);
        });
      } else {
        const nextCandidate = futureBlocks[i - (completedToday + scheduledToday)] || futureBlocks[0];
        bay.className = 'capacity-slot-bay slot-open';
        if (nextCandidate) {
          bay.title = `Click to pull "${nextCandidate.task_title}" into Slot ${slotNum} today`;
          bay.innerHTML = `
            <div class="slot-bay-left">
              <span class="slot-bay-index">SLOT ${slotNum}</span>
              <span class="slot-bay-title">Open — Pull "${escapeHtml(nextCandidate.task_title)}"</span>
            </div>
            <span class="slot-bay-meta">⚡ PULL</span>
          `;
          bay.addEventListener('click', () => pullTaskToToday(nextCandidate.task_id, nextCandidate.task_title));
        } else {
          bay.innerHTML = `
            <div class="slot-bay-left">
              <span class="slot-bay-index">SLOT ${slotNum}</span>
              <span class="slot-bay-title">Open capacity slot</span>
            </div>
            <span class="slot-bay-meta">+ ADD</span>
          `;
          bay.addEventListener('click', () => document.getElementById('addTaskModal').classList.add('active'));
        }
      }
      slotsGrid.appendChild(bay);
    }
  }

  if (metaDetail) metaDetail.textContent = `${completedToday} done • ${scheduledToday} active`;
  if (slotsLeft) {
    slotsLeft.textContent = openSlots === 0
      ? 'Capacity full'
      : `${openSlots} ${openSlots === 1 ? 'slot' : 'slots'} open`;
  }
}

/* ===================================================
   MULTI-VIEW HORIZON STUDIO (5-Day Board | Today | 14-Day | Queue)
=================================================== */
function renderScheduleStream() {
  const timeline = document.getElementById('agendaTimeline');
  const subtitle = document.getElementById('agendaTodaySubtitle');
  const heading = document.getElementById('streamMainHeading');
  const countBoardEl = document.getElementById('tabCountBoard');
  const countTodayEl = document.getElementById('tabCountToday');
  const countUpcomingEl = document.getElementById('tabCountUpcoming');
  const countBacklogEl = document.getElementById('tabCountBacklog');

  if (!timeline) return;

  const blocks = currentSchedule.blocks || [];
  const fixedEvents = currentSchedule.fixed_events || [];
  const unscheduledIds = new Set(currentSchedule.unscheduled_task_ids || []);
  const scheduledTaskIds = new Set(blocks.map(b => b.task_id));
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));
  const todayStr = getLocalDateStr();

  const todayBlocks = blocks.filter(b => b.start.startsWith(todayStr)).map(b => ({
    is_fixed: false,
    start: new Date(b.start),
    end: new Date(b.end),
    block: b,
    task: taskMap.get(b.task_id) || {
      id: b.task_id,
      title: b.task_title,
      priority_score: b.priority_score,
      manager_directive: b.manager_directive,
      category: b.category,
      category_icon: b.category_icon,
      color_preset: b.color_preset,
      estimated_minutes: 30
    }
  }));

  const todayFixed = fixedEvents.filter(e => e.start.startsWith(todayStr)).map(e => ({
    is_fixed: true,
    start: new Date(e.start),
    end: new Date(e.end),
    event: e
  }));

  const upcomingBlocks = blocks
    .filter(b => b.start.slice(0, 10) > todayStr)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .map(b => ({
      is_fixed: false,
      start: new Date(b.start),
      end: new Date(b.end),
      dateStr: b.start.slice(0, 10),
      block: b,
      task: taskMap.get(b.task_id) || {
        id: b.task_id,
        title: b.task_title,
        priority_score: b.priority_score,
        manager_directive: b.manager_directive,
        category: b.category,
        category_icon: b.category_icon,
        color_preset: b.color_preset,
        estimated_minutes: 30
      }
    }));

  const backlogTasks = currentTasks.filter(t => unscheduledIds.has(t.id) || !scheduledTaskIds.has(t.id) || Boolean(t.deferred_until || t.snoozed_until));

  // Update tab badges
  if (countBoardEl) countBoardEl.textContent = '5d';
  if (countTodayEl) countTodayEl.textContent = todayBlocks.length + todayFixed.length;
  if (countUpcomingEl) countUpcomingEl.textContent = upcomingBlocks.length;
  if (countBacklogEl) countBacklogEl.textContent = backlogTasks.length;

  const fmtTime = (d) => {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  };

  timeline.innerHTML = '';

  // VIEW 0: 5-DAY HORIZON BOARD (Linear / Cron Multi-Column Week Planner)
  if (currentStreamView === 'board') {
    if (heading) heading.textContent = '5-Day Horizon Board';
    if (subtitle) {
      subtitle.textContent = `${blocks.length} AI time-blocked tasks across your active horizon • Click any day header to scrub timeline`;
    }

    const activeDaysSet = new Set(currentConfig.active_days || [0, 1, 2, 3, 4]);
    const boardDates = [];
    const now = new Date();

    // Always include Today first, then the next 4 days that have items or are active workdays
    for (let offset = 0; offset < 14 && boardDates.length < 5; offset++) {
      const d = new Date(now);
      d.setDate(now.getDate() + offset);
      const dStr = getLocalDateStr(d);
      const jsDay = d.getDay(); // 0=Sun..6=Sat
      const pyWeekday = (jsDay + 6) % 7; // 0=Mon..6=Sun
      const hasItemsOnDay = blocks.some(b => b.start.startsWith(dStr)) || fixedEvents.some(e => e.start.startsWith(dStr));
      if (offset === 0 || hasItemsOnDay || activeDaysSet.has(pyWeekday)) {
        boardDates.push({ dStr, dateObj: d, isToday: offset === 0 });
      }
    }

    const boardGrid = document.createElement('div');
    boardGrid.className = 'horizon-board-grid';
    const maxPerDay = currentConfig.max_tasks_per_day || 3;

    boardDates.forEach(({ dStr, dateObj, isToday }) => {
      const col = document.createElement('div');
      col.className = `horizon-day-col ${isToday ? 'is-today-col' : ''} ${dStr === selectedGanttDate ? 'is-selected-gantt-col' : ''}`;

      const dayBlocks = blocks
        .filter(b => b.start.startsWith(dStr))
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      const dayFixed = fixedEvents
        .filter(e => e.start.startsWith(dStr))
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

      const dayTitle = isToday
        ? 'TODAY'
        : dateObj.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      const daySub = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const totalItems = dayBlocks.length + dayFixed.length;

      const colHeader = document.createElement('div');
      colHeader.className = 'horizon-day-header';
      colHeader.title = 'Click to inspect this day in the bottom Time-Block Scrubber';
      colHeader.innerHTML = `
        <div>
          <div class="horizon-day-title">${escapeHtml(dayTitle)}</div>
          <span class="horizon-day-sub">${escapeHtml(daySub)}</span>
        </div>
        <span class="horizon-slot-badge ${totalItems > 0 ? 'has-items' : ''}">${dayBlocks.length}/${maxPerDay} Slots</span>
      `;
      colHeader.addEventListener('click', () => {
        selectedGanttDate = dStr;
        hasUserSelectedGanttDate = true;
        renderGanttChart(dStr);
        document.querySelectorAll('.horizon-day-col').forEach(c => c.classList.remove('is-selected-gantt-col'));
        col.classList.add('is-selected-gantt-col');
      });
      col.appendChild(colHeader);

      const colBody = document.createElement('div');
      colBody.className = 'horizon-day-body';

      const combined = [
        ...dayBlocks.map(b => ({ is_fixed: false, start: new Date(b.start), end: new Date(b.end), block: b, task: taskMap.get(b.task_id) || {} })),
        ...dayFixed.map(e => ({ is_fixed: true, start: new Date(e.start), end: new Date(e.end), event: e }))
      ].sort((a, b) => a.start.getTime() - b.start.getTime());

      if (combined.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'horizon-empty-day';
        if (isToday && upcomingBlocks.length > 0) {
          const topNext = upcomingBlocks[0];
          emptyDiv.innerHTML = `
            <span style="font-size: 18px;">🏖️</span>
            <div style="font-weight:700; color:var(--text-main);">Off-Day / Clear</div>
            <div>0 tasks scheduled today</div>
            <button class="hb-btn-pull" style="margin-top:4px; padding:5px 10px;">⚡ Pull #1 Task Here</button>
          `;
          const pBtn = emptyDiv.querySelector('.hb-btn-pull');
          if (pBtn) pBtn.addEventListener('click', () => pullTaskToToday(topNext.block.task_id, topNext.block.task_title));
        } else {
          emptyDiv.innerHTML = `
            <span>✨</span>
            <div>Open Horizon</div>
          `;
        }
        colBody.appendChild(emptyDiv);
      } else {
        combined.forEach(item => {
          const card = document.createElement('div');
          if (item.is_fixed) {
            card.className = 'horizon-board-card is-fixed';
            card.innerHTML = `
              <div class="hb-card-top">
                <span class="hb-time">${fmtTime(item.start)} - ${fmtTime(item.end)}</span>
                <span class="hb-prio-btn">GCAL</span>
              </div>
              <div class="hb-title">📅 ${escapeHtml(item.event.title || 'Calendar Event')}</div>
              <div class="hb-footer">
                <span class="hb-dur">Fixed Meeting</span>
              </div>
            `;
          } else {
            const b = item.block;
            const t = item.task;
            const prio = t.priority_score || b.priority_score || 3;
            const estMins = t.estimated_minutes || Math.max(15, Math.round((item.end - item.start) / 60000));
            const icon = t.category_icon || b.category_icon || '📌';

            card.className = `horizon-board-card prio-${prio}`;
            card.innerHTML = `
              <div class="hb-card-top">
                <span class="hb-time">${fmtTime(item.start)}</span>
                <button class="hb-prio-btn p-${prio}" title="Click to cycle priority">P${prio}</button>
              </div>
              <div class="hb-title" title="${escapeHtml(b.task_title)}">${escapeHtml(icon)} ${escapeHtml(b.task_title)}</div>
              <div class="hb-footer">
                <span class="hb-dur">${estMins}m</span>
                <div class="hb-actions">
                  ${!isToday ? `<button class="hb-btn-pull" title="Pull into Today's schedule">⚡ Today</button>` : ''}
                  <button class="hb-btn-done" title="Mark Complete">✓ Done</button>
                </div>
              </div>
            `;

            const prioBtn = card.querySelector('.hb-prio-btn');
            const pullBtn = card.querySelector('.hb-btn-pull');
            const doneBtn = card.querySelector('.hb-btn-done');
            if (prioBtn) prioBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              cycleTaskPriority(b.task_id, prio);
            });
            if (pullBtn) pullBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              pullTaskToToday(b.task_id, b.task_title);
            });
            if (doneBtn) doneBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              openCompleteModal(b.task_id, b.task_title, estMins);
            });
          }
          colBody.appendChild(card);
        });
      }

      col.appendChild(colBody);
      boardGrid.appendChild(col);
    });

    timeline.appendChild(boardGrid);
    return;
  }

  // VIEW 1: TODAY'S STREAM (With Smart Horizon Peek when Today is empty!)
  if (currentStreamView === 'today') {
    if (heading) heading.textContent = "Today's Schedule Stream";
    if (subtitle) {
      subtitle.textContent = `${todayBlocks.length} focus tasks • ${todayFixed.length} calendar meetings`;
    }

    const allStream = [...todayBlocks, ...todayFixed].sort((a, b) => a.start.getTime() - b.start.getTime());

    if (allStream.length === 0) {
      if (upcomingBlocks.length > 0) {
        const nextDateStr = upcomingBlocks[0].dateStr;
        const nextDayObj = new Date(nextDateStr + 'T12:00:00');
        const nextDayFormatted = nextDayObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const nextWorkdayItems = upcomingBlocks.filter(b => b.dateStr === nextDateStr);

        const banner = document.createElement('div');
        banner.className = 'weekend-clear-banner';
        banner.innerHTML = `
          <div class="weekend-clear-banner-left">
            <span style="font-size: 18px;">🏖️</span>
            <div>
              <div class="weekend-clear-banner-title">Today's schedule is clear — Next Workday Preview (${escapeHtml(nextDayFormatted)})</div>
              <div class="weekend-clear-banner-sub">Click <strong>⚡ Pull to Today</strong> on any task below to work on it right now, or view all ${upcomingBlocks.length} upcoming blocks.</div>
            </div>
          </div>
          <button class="btn-secondary" style="padding: 5px 10px; font-size: 11.5px; white-space: nowrap;" id="peekViewAllUpcomingBtn">View All (${upcomingBlocks.length}) →</button>
        `;
        timeline.appendChild(banner);
        const viewAllBtn = banner.querySelector('#peekViewAllUpcomingBtn');
        if (viewAllBtn) {
          viewAllBtn.addEventListener('click', () => {
            currentStreamView = 'upcoming';
            document.querySelectorAll('#streamViewTabs .stream-tab-btn').forEach(b => {
              b.classList.toggle('active', b.dataset.view === 'upcoming');
            });
            renderScheduleStream();
          });
        }

        const groupHeader = document.createElement('div');
        groupHeader.className = 'stream-day-group-header';
        groupHeader.textContent = `UP NEXT • ${nextDayFormatted.toUpperCase()}`;
        timeline.appendChild(groupHeader);

        nextWorkdayItems.forEach(item => {
          const card = buildStreamCardElement(item, fmtTime, todayStr, Date.now(), true);
          timeline.appendChild(card);
        });
        return;
      }

      timeline.innerHTML = `
        <div style="text-align:center; padding: 36px 20px; color: var(--text-muted);">
          <div style="font-size: 26px; margin-bottom: 8px;">🏖️</div>
          <div style="font-size: 14.5px; font-weight: 700; color: var(--text-main);">No tasks or meetings left on Today's schedule</div>
          <div style="font-size: 12.5px; margin-top: 4px;">Check the <strong>Upcoming (${upcomingBlocks.length})</strong> or <strong>Unscheduled (${backlogTasks.length})</strong> tabs above, or tap <strong>+ Add Task</strong>.</div>
        </div>
      `;
      return;
    }

    const nowMs = Date.now();
    let insertedNowDivider = false;

    allStream.forEach(item => {
      const startMs = item.start.getTime();

      // Insert NOW horizontal line before the first item that starts in the future
      if (!insertedNowDivider && startMs > nowMs) {
        insertedNowDivider = true;
        const nowDivider = document.createElement('div');
        nowDivider.className = 'stream-now-divider';
        nowDivider.innerHTML = `
          <span class="stream-now-pill">NOW ${fmtTime(new Date(nowMs))}</span>
          <div class="stream-now-line"></div>
        `;
        timeline.appendChild(nowDivider);
      }

      const card = buildStreamCardElement(item, fmtTime, todayStr, nowMs, false);
      timeline.appendChild(card);
    });

    if (!insertedNowDivider) {
      const nowDivider = document.createElement('div');
      nowDivider.className = 'stream-now-divider';
      nowDivider.innerHTML = `
        <span class="stream-now-pill">NOW ${fmtTime(new Date(nowMs))}</span>
        <div class="stream-now-line"></div>
      `;
      timeline.appendChild(nowDivider);
    }
    return;
  }

  // VIEW 2: UPCOMING (14-DAY) STREAM
  if (currentStreamView === 'upcoming') {
    if (heading) heading.textContent = 'Upcoming 14-Day Schedule';
    if (subtitle) {
      subtitle.textContent = `${upcomingBlocks.length} focus tasks scheduled across upcoming workdays`;
    }

    if (upcomingBlocks.length === 0) {
      timeline.innerHTML = `
        <div style="text-align:center; padding: 36px 20px; color: var(--text-muted);">
          <div style="font-size: 26px; margin-bottom: 8px;">📆</div>
          <div style="font-size: 14.5px; font-weight: 700; color: var(--text-main);">No future blocks scheduled</div>
          <div style="font-size: 12.5px; margin-top: 4px;">All active tasks fit into today or are in Unscheduled.</div>
        </div>
      `;
      return;
    }

    let lastDateStr = '';
    upcomingBlocks.forEach(item => {
      if (item.dateStr !== lastDateStr) {
        lastDateStr = item.dateStr;
        const header = document.createElement('div');
        header.className = 'stream-day-group-header';
        const dObj = new Date(item.dateStr + 'T12:00:00');
        header.textContent = dObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        timeline.appendChild(header);
      }
      const card = buildStreamCardElement(item, fmtTime, todayStr, Date.now(), true);
      timeline.appendChild(card);
    });
    return;
  }

  // VIEW 3: UNSCHEDULED & SNOOZED BACKLOG
  if (currentStreamView === 'backlog') {
    if (heading) heading.textContent = 'Unscheduled & Snoozed Tasks';
    if (subtitle) {
      subtitle.textContent = `${backlogTasks.length} tasks waiting for capacity or snooze wake-up`;
    }

    if (backlogTasks.length === 0) {
      timeline.innerHTML = `
        <div style="text-align:center; padding: 36px 20px; color: var(--text-muted);">
          <div style="font-size: 26px; margin-bottom: 8px;">✨</div>
          <div style="font-size: 14.5px; font-weight: 700; color: var(--text-main);">Zero unscheduled tasks!</div>
          <div style="font-size: 12.5px; margin-top: 4px;">Every task in your queue is scheduled on the 14-day horizon.</div>
        </div>
      `;
      return;
    }

    backlogTasks.forEach(t => {
      const card = document.createElement('div');
      card.className = 'stream-card';
      const prioScore = t.priority_score || 3;
      const prioLabel = prioScore === 1 ? 'P1 Urgent' : (prioScore === 2 ? 'P2 High' : 'P3 Focus');
      const snoozeVal = t.deferred_until || t.snoozed_until;
      const isSnoozed = Boolean(snoozeVal);

      let statusReason = '⏳ Waiting for open daily slot';
      if (isSnoozed) {
        try {
          const snzDt = new Date(String(snoozeVal).slice(0, 10) + 'T12:00:00');
          statusReason = `🌙 Snoozed until ${snzDt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        } catch (e) {
          statusReason = '🌙 Snoozed';
        }
      }

      card.innerHTML = `
        <div class="stream-card-left">
          <div class="stream-card-time">${t.estimated_minutes || 30}m<br>Est.</div>
          <div class="stream-card-info">
            <div class="stream-card-title-row">
              <span style="font-size: 15px;">${escapeHtml(t.category_icon || '📌')}</span>
              <span class="stream-card-title">${escapeHtml(t.title)}</span>
              <button class="stream-card-badge badge-prio badge-prio-btn" title="Click to cycle priority">${prioLabel}</button>
            </div>
            <div class="stream-card-directive">${escapeHtml(statusReason)} • ${escapeHtml(t.manager_directive || 'Backlog item')}</div>
          </div>
        </div>
        <div class="stream-card-controls">
          ${isSnoozed ? `<button class="btn-card-done wake-btn" style="background:#3b82f6;">Wake Now</button>` : `<button class="btn-pull-today pull-btn" title="Schedule into Today">⚡ Pull to Today</button>`}
          <button class="btn-card-done done-btn">Done</button>
        </div>
      `;

      const prioBtn = card.querySelector('.badge-prio-btn');
      if (prioBtn) {
        prioBtn.addEventListener('click', () => cycleTaskPriority(t.id, prioScore));
      }
      const pullBtn = card.querySelector('.pull-btn');
      if (pullBtn) {
        pullBtn.addEventListener('click', () => pullTaskToToday(t.id, t.title));
      }
      const wakeBtn = card.querySelector('.wake-btn');
      if (wakeBtn) {
        wakeBtn.addEventListener('click', () => unsnoozeTask(t.id, t.title));
      }
      const doneBtn = card.querySelector('.done-btn');
      if (doneBtn) {
        doneBtn.addEventListener('click', () => openCompleteModal(t.id, t.title, t.estimated_minutes || 30));
      }

      timeline.appendChild(card);
    });
  }
}

function buildStreamCardElement(item, fmtTime, todayStr, nowMs, allowPullToToday = false) {
  const card = document.createElement('div');
  const startMs = item.start.getTime();
  const endMs = item.end.getTime();
  const isPast = endMs < nowMs;
  const isActiveNow = startMs <= nowMs && nowMs <= endMs;

  if (item.is_fixed) {
    card.className = `stream-card preset-fixed ${isPast ? 'is-past' : ''} ${isActiveNow ? 'is-active-now' : ''}`;
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
    const t = item.task;
    const b = item.block;
    const prioScore = t.priority_score || b.priority_score || 3;
    card.className = `stream-card prio-${prioScore} ${isPast ? 'is-past' : ''} ${isActiveNow ? 'is-active-now' : ''}`;
    const prioLabel = prioScore === 1 ? 'P1 Urgent' : (prioScore === 2 ? 'P2 High' : 'P3 Focus');
    const estMins = t.estimated_minutes || Math.round((endMs - startMs) / 60000) || 30;

    let dueBadge = `<button class="stream-card-badge badge-due badge-due-btn" title="Tap to set due date">+ Due</button>`;
    if (t.due) {
      try {
        const dueDateOnly = t.due.slice(0, 10);
        const dueDt = new Date(dueDateOnly + 'T12:00:00');
        const dueStr = dueDt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const isOverdue = dueDateOnly < todayStr;
        dueBadge = `<button class="stream-card-badge ${isOverdue ? 'badge-due-overdue' : 'badge-due'} badge-due-btn" title="Tap to change or clear due date">📅 Due ${dueStr}</button>`;
      } catch (e) {}
    }

    const rawDirective = (t.notes && t.notes.trim()) || t.manager_directive || b.manager_directive || '';
    const isGenericFiller = ['standard priority focus block.', 'priority task block.', 'scheduled focus block', 'general task'].includes(rawDirective.trim().toLowerCase());
    const directiveHtml = (!rawDirective || isGenericFiller)
      ? `<div class="stream-card-directive">${estMins}m focus block</div>`
      : `<div class="stream-card-directive">${escapeHtml(rawDirective)}</div>`;

    card.innerHTML = `
      <div class="stream-card-left">
        <div class="stream-card-time">${fmtTime(item.start)}<br>${fmtTime(item.end)}</div>
        <div class="stream-card-info">
          <div class="stream-card-title-row">
            <span style="font-size: 15px;">${escapeHtml(t.category_icon || '📌')}</span>
            <span class="stream-card-title">${escapeHtml(t.title)}</span>
            <span class="stream-card-badge badge-focus">${escapeHtml(t.category || 'Focus')}</span>
            <button class="stream-card-badge badge-prio badge-prio-btn" title="Tap to cycle priority (P1/P2/P3)">${prioLabel}</button>
            ${dueBadge}
          </div>
          ${directiveHtml}
        </div>
      </div>
      <div class="stream-card-controls">
        ${allowPullToToday ? `<button class="btn-pull-today" data-task-id="${t.id}" title="Pull this task into Today's schedule">⚡ Pull to Today</button>` : ''}
        <button class="btn-card-done" data-task-id="${t.id}">Done</button>
        <button class="btn-card-icon snooze-btn" data-task-id="${t.id}" title="Snooze 1 day">🌙</button>
      </div>
    `;

    const prioBtn = card.querySelector('.badge-prio-btn');
    const dueBtn = card.querySelector('.badge-due-btn');
    const pullBtn = card.querySelector('.btn-pull-today');
    const doneBtn = card.querySelector('.btn-card-done');
    const sBtn = card.querySelector('.snooze-btn');
    if (prioBtn) prioBtn.addEventListener('click', () => cycleTaskPriority(t.id, prioScore));
    if (dueBtn) dueBtn.addEventListener('click', () => cycleTaskDueDate(t.id, t.due));
    if (pullBtn) pullBtn.addEventListener('click', () => pullTaskToToday(t.id, t.title));
    if (doneBtn) doneBtn.addEventListener('click', () => openCompleteModal(t.id, t.title, estMins));
    if (sBtn) sBtn.addEventListener('click', () => snoozeTask(t.id, 1, t.title));
  }

  return card;
}

async function pullTaskToToday(taskId, taskTitle) {
  const todayStr = getLocalDateStr();
  try {
    const [dueRes, prioRes] = await Promise.all([
      fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/due`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due: todayStr })
      }),
      fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/priority`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority_score: 1 })
      })
    ]);

    if (!dueRes.ok || !prioRes.ok) throw new Error('Failed to pull task into Today');

    // Keep 'board' view if already on Week Board, otherwise switch to 'today'
    if (currentStreamView !== 'board') {
      currentStreamView = 'today';
    }
    selectedGanttDate = todayStr;
    hasUserSelectedGanttDate = true;
    document.querySelectorAll('#streamViewTabs .stream-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === currentStreamView);
    });

    showToast(`⚡ Pulled "${taskTitle}" into Today's schedule`, 'success');
    fetchPlan();
  } catch (err) {
    showToast(err.message || 'Could not pull task to Today', 'error');
  }
}

async function cycleTaskPriority(taskId, currentPrio) {
  const nextPrio = currentPrio === 1 ? 2 : (currentPrio === 2 ? 3 : 1);
  // Optimistic update
  currentTasks.forEach(t => { if (t.id === taskId) t.priority_score = nextPrio; });
  (currentSchedule.blocks || []).forEach(b => { if (b.task_id === taskId) b.priority_score = nextPrio; });
  renderScheduleStream();

  try {
    const res = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority_score: nextPrio })
    });
    if (!res.ok) throw new Error('Failed to update priority');
    showToast(`Updated priority to P${nextPrio}`, 'info');
    fetchPlan();
  } catch (err) {
    showToast(err.message || 'Could not update priority', 'error');
    fetchPlan();
  }
}

async function cycleTaskDueDate(taskId, currentDue) {
  const todayStr = getLocalDateStr();
  const tom = new Date();
  tom.setDate(tom.getDate() + 1);
  const tomorrowStr = getLocalDateStr(tom);
  const curDateOnly = currentDue ? String(currentDue).slice(0, 10) : null;

  // Cycle: None -> Today -> Tomorrow -> Clear
  let nextDue = todayStr;
  let label = 'Today';
  if (curDateOnly === todayStr) {
    nextDue = tomorrowStr;
    label = 'Tomorrow';
  } else if (curDateOnly) {
    nextDue = null;
    label = 'Cleared';
  }

  try {
    const res = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/due`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ due: nextDue })
    });
    if (!res.ok) throw new Error('Failed to update due date');
    showToast(nextDue ? `📅 Due date set to ${label}` : 'Cleared due date', 'info');
    fetchPlan();
  } catch (err) {
    showToast(err.message || 'Could not update due date', 'error');
  }
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

  if (targetDateStr) {
    selectedGanttDate = targetDateStr;
    hasUserSelectedGanttDate = true;
  }

  const allBlocks = currentSchedule.blocks || [];
  const fixedEvents = currentSchedule.fixed_events || [];
  const taskMap = new Map(currentTasks.map(t => [t.id, t]));
  const todayStr = getLocalDateStr();

  // Build 7-day window metadata and item counts
  const now = new Date();
  const sevenDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const dStr = getLocalDateStr(d);
    const isToday = dStr === todayStr;
    const count = allBlocks.filter(b => b.start.startsWith(dStr)).length +
                  fixedEvents.filter(e => e.start.startsWith(dStr)).length;
    const dayLabel = isToday ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    sevenDays.push({ dStr, dayLabel, count });
  }

  // Auto-advance to the first active day if Today has 0 items and user hasn't manually clicked a tab
  if (!hasUserSelectedGanttDate) {
    const selectedMeta = sevenDays.find(d => d.dStr === selectedGanttDate);
    if (!selectedMeta || selectedMeta.count === 0) {
      const firstActiveDay = sevenDays.find(d => d.count > 0);
      if (firstActiveDay) {
        selectedGanttDate = firstActiveDay.dStr;
      }
    }
  }

  // Render Next 7 Days Navigation Tabs with item count badges
  if (ganttDayTabs) {
    ganttDayTabs.innerHTML = '';
    sevenDays.forEach(({ dStr, dayLabel, count }) => {
      const tabBtn = document.createElement('button');
      tabBtn.className = `gantt-day-tab ${dStr === selectedGanttDate ? 'active' : ''}`;
      tabBtn.innerHTML = `${escapeHtml(dayLabel)} <span class="gantt-tab-count">${count}</span>`;
      tabBtn.addEventListener('click', () => {
        selectedGanttDate = dStr;
        hasUserSelectedGanttDate = true;
        renderGanttChart(dStr);
      });
      ganttDayTabs.appendChild(tabBtn);
    });
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
    const selDateObj = new Date(selectedGanttDate + 'T12:00:00');
    const label = selectedGanttDate === todayStr
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

  // Render live NOW cursor on Gantt when viewing Today
  if (selectedGanttDate === todayStr) {
    const now = new Date();
    const nowMinutes = (now.getHours() - startHour) * 60 + now.getMinutes();
    if (nowMinutes >= 0 && nowMinutes <= totalMinutes) {
      const nowPercent = (nowMinutes / totalMinutes) * 100;
      const nowLine = document.createElement('div');
      nowLine.className = 'gantt-now-line';
      nowLine.style.left = `${nowPercent}%`;
      nowLine.setAttribute('data-now-label', 'NOW');
      ganttTracks.appendChild(nowLine);
    }
  }

  tracks.forEach((trackBlocks, tIdx) => {
    trackBlocks.forEach(b => {
      const dtStart = new Date(b.start);
      const dtEnd = new Date(b.end);

      const startMinutes = (dtStart.getHours() - startHour) * 60 + dtStart.getMinutes();
      const durationMinutes = Math.round((dtEnd - dtStart) / (1000 * 60));

      const leftPercent = Math.max(0, Math.min(96, (startMinutes / totalMinutes) * 100));
      const widthPercent = Math.max(12, Math.min(100 - leftPercent, (durationMinutes / totalMinutes) * 100));

      const parentTask = b.task_id ? taskMap.get(b.task_id) : null;
      const preset = (b.color_preset || (parentTask ? parentTask.color_preset : 'neutral')).toLowerCase();
      const icon = b.category_icon || (parentTask ? parentTask.category_icon : '📌');

      const formatTime = (d) => {
        let h = d.getHours();
        const m = String(d.getMinutes()).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m} ${ampm}`;
      };

      const card = document.createElement('div');
      card.className = `gantt-block-card preset-${escapeHtml(preset)}`;
      card.style.left = `${leftPercent}%`;
      card.style.width = `${widthPercent}%`;
      card.style.top = `${tIdx * trackHeight}px`;
      card.title = `${b.task_title} (${formatTime(dtStart)} - ${formatTime(dtEnd)})`;

      card.innerHTML = `
        <div class="block-time">${formatTime(dtStart)} - ${formatTime(dtEnd)}</div>
        <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(icon)} ${escapeHtml(b.task_title)}</div>
      `;

      if (!b.is_fixed_event && b.task_id) {
        card.addEventListener('click', () => {
          openCompleteModal(b.task_id, b.task_title, parentTask ? parentTask.estimated_minutes : durationMinutes);
        });
      }

      ganttTracks.appendChild(card);
    });
  });
}

/* ===================================================
   ACTION HANDLERS: ADD, SNOOZE, UNSNOOZE, COMPLETE
=================================================== */
function openCompleteModal(taskId, taskTitle, estimatedMinutes = 30) {
  completingTaskId = taskId;
  completingTaskTitle = taskTitle || 'Completed Task';
  completingTaskEst = estimatedMinutes || 30;

  const titleEl = document.getElementById('modalTaskTitle');
  if (titleEl) titleEl.textContent = taskTitle;
  const minInput = document.getElementById('actualMinutesInput');
  if (minInput) minInput.value = completingTaskEst;

  const modal = document.getElementById('completionModal');
  if (modal) modal.classList.add('active');
}

async function submitCompletion() {
  if (!completingTaskId) return;
  const actualMinutes = parseInt(document.getElementById('actualMinutesInput').value, 10) || completingTaskEst || 30;
  const btn = document.getElementById('confirmCompleteBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const finishedId = completingTaskId;
  const finishedTitle = completingTaskTitle;

  // Optimistic UI removal
  currentTasks = currentTasks.filter(t => t.id !== finishedId);
  if (currentSchedule.blocks) {
    currentSchedule.blocks = currentSchedule.blocks.filter(b => b.task_id !== finishedId);
  }
  if (!currentSchedule.solver_stats) currentSchedule.solver_stats = {};
  currentSchedule.solver_stats.completed_today_count = (currentSchedule.solver_stats.completed_today_count || 0) + 1;
  renderCurrentFocusHero();
  renderCapacityMeter();
  renderScheduleStream();
  renderGanttChart();

  try {
    const res = await fetch(`${API_BASE}/api/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: finishedId,
        title: finishedTitle,
        estimated_minutes: completingTaskEst,
        actual_minutes: actualMinutes
      })
    });

    if (!res.ok) throw new Error('Failed to complete task');

    document.getElementById('completionModal').classList.remove('active');
    completingTaskId = null;
    showToast(`✅ Completed "${finishedTitle}" (${actualMinutes}m logged)`, 'success');
    fetchPlan();
    fetchHistory();
  } catch (err) {
    showToast(err.message || 'Error completing task', 'error');
    fetchPlan();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log & Complete';
  }
}

async function snoozeTask(taskId, days = 1, taskTitle = 'Task') {
  // Optimistic UI removal from today's active blocks
  if (currentSchedule.blocks) {
    currentSchedule.blocks = currentSchedule.blocks.filter(b => b.task_id !== taskId);
  }
  renderCurrentFocusHero();
  renderCapacityMeter();
  renderScheduleStream();
  renderGanttChart();

  try {
    const res = await fetch(`${API_BASE}/api/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, days })
    });
    if (!res.ok) throw new Error('Failed to snooze task');
    await fetchPlan();
    showToast(
      `🌙 Snoozed "${taskTitle}" for ${days} day${days > 1 ? 's' : ''}`,
      'info',
      'Undo',
      () => unsnoozeTask(taskId, taskTitle)
    );
  } catch (err) {
    showToast(err.message || 'Failed to snooze task', 'error');
    fetchPlan();
  }
}

async function unsnoozeTask(taskId, taskTitle = 'Task') {
  try {
    const res = await fetch(`${API_BASE}/api/unsnooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
    if (!res.ok) throw new Error('Failed to wake task');
    await fetchPlan();
    showToast(`☀️ Woke "${taskTitle}" back into active schedule`, 'success');
  } catch (err) {
    showToast(err.message || 'Failed to wake task', 'error');
  }
}

async function saveAddTask() {
  const titleInput = document.getElementById('newTaskTitleInput');
  const notesInput = document.getElementById('newTaskNotesInput');
  const dueInput = document.getElementById('newTaskDueInput');
  const title = titleInput.value.trim();
  const notes = notesInput.value.trim();
  const dueVal = dueInput ? dueInput.value.trim() : '';

  if (!title) {
    showToast('Please enter a task title.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('saveAddTaskBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Scheduling...';

  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        notes,
        priority_raw: 0,
        priority_score: selectedNewTaskPrio,
        due: dueVal || null
      })
    });
    if (!res.ok) throw new Error('Failed to add task');
    const createdData = await res.json();
    const createdTaskId = createdData.task && createdData.task.id;

    titleInput.value = '';
    notesInput.value = '';
    if (dueInput) dueInput.value = '';
    document.getElementById('addTaskModal').classList.remove('active');

    await fetchPlan();

    // Inspect where the solver placed the newly created task
    const matchedBlock = (currentSchedule.blocks || []).find(b => b.task_id === createdTaskId);
    const todayStr = getLocalDateStr();
    if (matchedBlock) {
      const bDateStr = matchedBlock.start.slice(0, 10);
      const dtStart = new Date(matchedBlock.start);
      const timeLabel = dtStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const dayLabel = bDateStr === todayStr
        ? 'Today'
        : dtStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      showToast(`📅 Scheduled "${title}" for ${dayLabel} at ${timeLabel}`, 'success');
    } else {
      showToast(`📥 Added "${title}" to Unscheduled queue`, 'info');
    }
  } catch (err) {
    showToast(err.message || 'Error adding task', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Create & Schedule';
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
    await fetchPlan();
    showToast('⚡ Schedule re-optimized with OR-Tools solver', 'success');
  } catch (err) {
    showToast(err.message || 'Error rescheduling', 'error');
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
        <div class="stream-card-time" style="background: rgba(16, 185, 129, 0.2); color: #34d399;">✓<br>${dateFormatted.split(',')[0]}</div>
        <div class="stream-card-info">
          <div class="stream-card-title">${escapeHtml(item.title)}</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
            Completed at ${dateFormatted} • Est: ${item.estimated_minutes}m
          </div>
        </div>
      </div>
      <div class="stream-card-controls">
        <span style="font-size: 12px; font-weight: 700; color: var(--text-muted);">Logged:</span>
        <input type="number" id="logInput_${item.id}" value="${item.actual_minutes}" min="0" style="width: 55px; padding: 4px; border-radius: 6px; border: 1px solid var(--border-card); background: var(--bg-subtle); color: var(--text-main); font-weight: 700; text-align: center;">
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
    showToast('Please enter valid minutes.', 'warning');
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
    showToast('Updated logged duration', 'success');
    fetchHistory();
  } catch (err) {
    console.error('Error updating logged time:', err);
    showToast('Failed to update logged duration', 'error');
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Save';
    }
  }
}

/* ===================================================
   SETTINGS & TABLET PREFERENCES
=================================================== */
let wakeLockSentinel = null;

async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
    } catch (err) {
      console.warn('WakeLock request error:', err);
    }
  }
}

function releaseScreenWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(err => console.warn(err));
    wakeLockSentinel = null;
  }
}

function toggleKioskFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => {
      console.warn('Fullscreen request failed:', err);
    });
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(err => console.warn(err));
    }
  }
}

function updateFullscreenButtonState() {
  const btn = document.getElementById('toggleFullscreenBtn');
  if (!btn) return;
  if (document.fullscreenElement) {
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`;
    btn.title = 'Exit Fullscreen';
  } else {
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
    btn.title = 'Toggle Kiosk Fullscreen (Wall Tablet)';
  }
}

function initTabletPreferences() {
  const urlParams = new URLSearchParams(window.location.search);
  const kioskParam = urlParams.get('kiosk');
  const storedKiosk = localStorage.getItem('monga_kiosk_fit');
  const storedWakeLock = localStorage.getItem('monga_keep_awake');

  if (kioskParam === '1' || kioskParam === 'true' || storedKiosk === 'true') {
    document.body.classList.add('kiosk-mode');
  }

  if (storedWakeLock === 'true') {
    requestScreenWakeLock();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const keepAwake = localStorage.getItem('monga_keep_awake') === 'true';
      if (keepAwake) requestScreenWakeLock();
    }
  });
}

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

  const wakeLockCheckbox = document.getElementById('wakeLockSettingCheckbox');
  const kioskCheckbox = document.getElementById('kioskFitSettingCheckbox');
  if (wakeLockCheckbox) wakeLockCheckbox.checked = localStorage.getItem('monga_keep_awake') === 'true';
  if (kioskCheckbox) kioskCheckbox.checked = document.body.classList.contains('kiosk-mode');

  const currentPref = getStoredThemePreference();
  const themeChips = document.querySelectorAll('#themePreferenceGroup .theme-chip');
  themeChips.forEach(chip => {
    if (chip.dataset.themePref === currentPref) chip.classList.add('active');
    else chip.classList.remove('active');
  });
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

  const wakeLockCheckbox = document.getElementById('wakeLockSettingCheckbox');
  const kioskCheckbox = document.getElementById('kioskFitSettingCheckbox');
  if (wakeLockCheckbox) {
    const enableWakeLock = wakeLockCheckbox.checked;
    localStorage.setItem('monga_keep_awake', enableWakeLock ? 'true' : 'false');
    if (enableWakeLock) requestScreenWakeLock();
    else releaseScreenWakeLock();
  }
  if (kioskCheckbox) {
    const enableKiosk = kioskCheckbox.checked;
    localStorage.setItem('monga_kiosk_fit', enableKiosk ? 'true' : 'false');
    if (enableKiosk) document.body.classList.add('kiosk-mode');
    else document.body.classList.remove('kiosk-mode');
  }

  try {
    const res = await fetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to save settings');
    currentConfig = payload;
    document.getElementById('settingsModal').classList.remove('active');
    showToast('⚙️ Saved solver settings & re-solved schedule', 'success');
    fetchPlan();
  } catch (err) {
    showToast(err.message || 'Error saving settings', 'error');
  }
}

/* ===================================================
   OAUTH RE-AUTH
=================================================== */
let pendingOAuthState = null;

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

    pendingOAuthState = data.state || null;
    if (data.auth_url) {
      window.open(data.auth_url, '_blank');
    }
  } catch (err) {
    showToast(err.message || 'Failed to generate authorization URL', 'error');
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
    showToast('Please enter or paste the Google Authorization Code (or redirected URL).', 'warning');
    return;
  }

  let code = rawInput;
  let state = pendingOAuthState;
  if (rawInput.includes('code=')) {
    try {
      const urlObj = new URL(rawInput.startsWith('http') ? rawInput : 'http://localhost/' + rawInput);
      code = urlObj.searchParams.get('code') || rawInput;
      state = urlObj.searchParams.get('state') || state;
    } catch (e) {
      const match = rawInput.match(/code=([^&]+)/);
      if (match) code = decodeURIComponent(match[1]);
      const stateMatch = rawInput.match(/state=([^&]+)/);
      if (stateMatch) state = decodeURIComponent(stateMatch[1]);
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
      body: JSON.stringify({ code, redirect_uri: redirectUri, state })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to exchange authorization code');

    showToast('✅ Successfully re-authenticated with Google!', 'success');
    const authModal = document.getElementById('authModal');
    if (authModal) authModal.classList.remove('active');
    if (input) input.value = '';
    fetchPlan();
  } catch (err) {
    showToast(err.message || 'OAuth code exchange failed.', 'error');
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

/* ===================================================
   THEME MANAGEMENT (DAY/NIGHT AUTO & MANUAL TOGGLE)
=================================================== */
function getAutoTheme() {
  try {
    const laHour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      hourCycle: 'h23'
    }).format(new Date()), 10);
    return (laHour >= 6 && laHour < 19) ? 'light' : 'dark';
  } catch (e) {
    const hour = new Date().getHours();
    return (hour >= 6 && hour < 19) ? 'light' : 'dark';
  }
}

function getStoredThemePreference() {
  return localStorage.getItem('monga_theme_preference') || 'auto';
}

function getEffectiveTheme() {
  const pref = getStoredThemePreference();
  if (pref === 'light' || pref === 'dark') return pref;
  return getAutoTheme();
}

function applyTheme(theme, preference = null) {
  if (!preference) preference = getStoredThemePreference();
  
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);

  const metaThemeColor = document.getElementById('metaThemeColor');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', theme === 'dark' ? '#0a0f1d' : '#f1f5f9');
  }
  const metaColorScheme = document.getElementById('metaColorScheme');
  if (metaColorScheme) {
    metaColorScheme.setAttribute('content', theme);
  }

  updateThemeControls(theme, preference);
}

function updateThemeControls(theme, preference) {
  const btn = document.getElementById('themeToggleBtn');
  const icon = document.getElementById('themeToggleIcon');
  if (btn && icon) {
    if (theme === 'dark') {
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
      btn.title = preference === 'auto'
        ? 'Theme: Auto (Night 7PM-6AM) • Click for Light'
        : 'Theme: Dark (Manual) • Click for Light';
    } else {
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
      btn.title = preference === 'auto'
        ? 'Theme: Auto (Day 6AM-7PM) • Click for Dark'
        : 'Theme: Light (Manual) • Click for Dark';
    }
  }

  const chips = document.querySelectorAll('#themePreferenceGroup .theme-chip');
  chips.forEach(chip => {
    if (chip.dataset.themePref === preference) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

function toggleThemeCycle() {
  const currentTheme = getEffectiveTheme();
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('monga_theme_preference', nextTheme);
  applyTheme(nextTheme, nextTheme);
}

function setThemePreference(pref) {
  localStorage.setItem('monga_theme_preference', pref);
  const effective = pref === 'auto' ? getAutoTheme() : pref;
  applyTheme(effective, pref);
}

function checkAutoThemeTransition() {
  const pref = getStoredThemePreference();
  if (pref === 'auto') {
    const desired = getAutoTheme();
    const current = document.documentElement.getAttribute('data-theme');
    if (current !== desired) {
      applyTheme(desired, 'auto');
    }
  }
}

function initTheme() {
  if (!localStorage.getItem('monga_theme_preference_v7')) {
    localStorage.setItem('monga_theme_preference', 'auto');
    localStorage.setItem('monga_theme_preference_v7', '1');
  }
  const effective = getEffectiveTheme();
  applyTheme(effective, getStoredThemePreference());

  setInterval(checkAutoThemeTransition, 60000);

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getStoredThemePreference() === 'auto') {
        applyTheme(getAutoTheme(), 'auto');
      }
    });
  }
}
