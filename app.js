/**
 * ========================================================================
 * ManageTask Dashboard - Application Script
 * ========================================================================
 * Designed, Developed, and Invented by: Marquant Ma (Haoran Ma)
 * Author Email: HaoranMa0818@icloud.com
 * Copyright (c) 2026 Marquant Ma. All rights reserved.
 * 
 * This software is proprietary intellectual property. Unauthorized copying,
 * redistribution, or modifications of this project's code, structure,
 * or assets is strictly prohibited under copyright law.
 * ========================================================================
 */
// ==========================================================================
// Application State
// ==========================================================================
const state = {
  tasks: [],
  activeTab: 'dashboard', // dashboard, calendar, analytics
  activeGroup: 'deadline', // deadline, subject
  currentDate: new Date(2026, 5, 14), // Current local time: June 14, 2026
  calendarMonth: 5, // June (0-indexed)
  calendarYear: 2026,
  calendarView: 'week', // week, month, day, year
  calendarActiveDate: new Date(2026, 5, 14),
  calendarEvents: [],
  filters: {
    search: '',
    subject: 'all',
    status: 'all'
  },
  syncStatus: {
    status: 'idle',
    message: 'System idle',
    progress: 0,
    last_sync: null
  },
  subjectBoundaries: {}
};

// Month Names mapping
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const MONTH_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

// ==========================================================================
// Date Parsing Helper
// ==========================================================================
function parseTaskDate(task) {
  const text = task.time || task.date_header || "";
  // Matches e.g., "Jun 16, 5:00 PM" or "Jun 16"
  const match = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)(?:,\s+(\d+):(\d+)\s+(AM|PM))?/i);
  if (!match) return null;
  
  const month = MONTH_MAP[match[1].toLowerCase()];
  const day = parseInt(match[2], 10);
  
  // Infer year based on context
  let year = 2026;
  const taskViews = task.views || [];
  if (month > 6 && (taskViews.includes('past') || taskViews.includes('overdue'))) {
    year = 2025;
  }
  
  let hours = 0;
  let minutes = 0;
  if (match[3]) {
    hours = parseInt(match[3], 10);
    minutes = parseInt(match[4], 10);
    const ampm = match[5].toUpperCase();
    if (ampm === 'PM' && hours < 12) {
      hours += 12;
    } else if (ampm === 'AM' && hours === 12) {
      hours = 0;
    }
  }
  
  return new Date(year, month, day, hours, minutes);
}

// Format date nicely
function formatDate(date) {
  if (!date) return "-";
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// ==========================================================================
// API Calls
// ==========================================================================
async function fetchTasks() {
  try {
    const res = await fetch('/api/tasks');
    state.tasks = await res.json();
    
    // Sort tasks chronologically by default
    state.tasks.forEach(t => t._date = parseTaskDate(t));
    state.tasks.sort((a, b) => {
      if (!a._date) return 1;
      if (!b._date) return -1;
      return a._date - b._date;
    });

    populateSubjectFilter();
    initGradeCalculator();
    calculateStats();
    renderActiveTab();
    renderDueRadar();
    fetchCalendarEvents();
    fetchSubjectBoundaries();
    fetchSubjectGrades();
  } catch (err) {
    console.error("Failed to load tasks:", err);
  }
}

async function fetchSubjectBoundaries() {
  try {
    const res = await fetch('/api/subject-boundaries');
    state.subjectBoundaries = await res.json();
    if (gradeCalculatorInitialized) {
      handleCalculatorSubjectChange();
    }
  } catch (err) {
    console.error("Failed to load subject boundaries:", err);
  }
}

async function fetchSubjectGrades() {
  try {
    const res = await fetch('/api/subject-grades');
    state.subjectGrades = await res.json();
    if (gradeCalculatorInitialized) {
      handleCalculatorSubjectChange();
    }
  } catch (err) {
    console.error("Failed to load subject grades:", err);
  }
}

function normalizeSubjectName(name) {
  if (!name) return "";
  // 1. Remove prefix like IB DP, HS, PG-, MYP
  let clean = name.replace(/^(?:IB\s+DP|HS|PG|MYP)\s+/i, "");
  // 2. Remove suffix like (Grade XX) using both half-width and full-width brackets
  clean = clean.replace(/\s*[（\(]Grade\s+\d+[\)）]\s*$/i, "");
  // 3. Strip all spaces, punctuation, and parentheses, keeping only alphanumeric and Chinese characters
  clean = clean.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "");
  return clean.toLowerCase();
}

function getSubjectBoundaries(sub) {
  if (!state.subjectBoundaries) return null;
  const normSub = normalizeSubjectName(sub);
  for (const key in state.subjectBoundaries) {
    if (normalizeSubjectName(key) === normSub) {
      return state.subjectBoundaries[key];
    }
  }
  return null;
}

function getSubjectGrades(sub) {
  if (!state.subjectGrades) return null;
  const normSub = normalizeSubjectName(sub);
  for (const key in state.subjectGrades) {
    if (normalizeSubjectName(key) === normSub) {
      return state.subjectGrades[key];
    }
  }
  return null;
}

async function fetchCalendarEvents() {
  try {
    const res = await fetch('/api/calendar-events');
    const data = await res.json();
    state.calendarEvents = data;
    
    // Sort & Parse
    state.calendarEvents.forEach(e => {
      e._startDate = e.start ? new Date(e.start) : null;
      e._endDate = e.end ? new Date(e.end) : null;
    });
    
    if (state.activeTab === 'calendar') {
      renderCalendar();
    }
  } catch (err) {
    console.error("Failed to load calendar events:", err);
  }
}

async function fetchSyncStatus() {
  try {
    const res = await fetch('/api/sync-status');
    const data = await res.json();
    state.syncStatus = data;
    updateSyncWidget();
    
    if (data.status === 'syncing') {
      // Keep polling if currently syncing
      if (!state.syncInterval) {
        state.syncInterval = setInterval(fetchSyncStatus, 1500);
      }
    } else {
      // Stop polling when finished
      if (state.syncInterval) {
        clearInterval(state.syncInterval);
        state.syncInterval = null;
        // Reload tasks if successfully synced
        if (data.status === 'success') {
          fetchTasks();
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch sync status:", err);
  }
}

async function triggerSync() {
  if (state.syncStatus.status === 'syncing') return;
  
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    state.syncStatus = data;
    updateSyncWidget();
    
    // Start polling sync progress
    if (!state.syncInterval) {
      state.syncInterval = setInterval(fetchSyncStatus, 1500);
    }
  } catch (err) {
    console.error("Failed to trigger sync:", err);
  }
}

// ==========================================================================
// Stats Calculation & Display
// ==========================================================================
function calculateStats() {
  const overdueCount = state.tasks.filter(t => (t.views || []).includes('overdue')).length;
  const upcomingCount = state.tasks.filter(t => (t.views || []).includes('upcoming')).length;
  
  // Graded / Assessed scores
  const gradedTasks = state.tasks.filter(t => t.status === "Assessed" && t.score);
  const gradedCount = gradedTasks.length;
  
  let averageScore = 0;
  if (gradedCount > 0) {
    const sum = gradedTasks.reduce((acc, t) => acc + parseFloat(t.score), 0);
    averageScore = (sum / gradedCount).toFixed(1);
  }

  // Update UI Elements
  document.getElementById('stat-overdue').innerText = overdueCount;
  document.getElementById('stat-upcoming').innerText = upcomingCount;
  document.getElementById('stat-average-grade').innerText = gradedCount > 0 ? averageScore : "N/A";
  document.getElementById('stat-completed').innerText = gradedCount;

  // Toggle active glow class for overdue card
  const overdueCard = document.getElementById('metric-overdue-card');
  if (overdueCount > 0) {
    overdueCard.classList.add('active-glow');
  } else {
    overdueCard.classList.remove('active-glow');
  }
}

// ==========================================================================
// Subject Filter Populating
// ==========================================================================
function populateSubjectFilter() {
  const subjects = new Set();
  state.tasks.forEach(t => {
    if (t.subject) subjects.add(t.subject);
  });

  const select = document.getElementById('filter-subject');
  // Clear except first option
  select.innerHTML = '<option value="all">All Subjects</option>';
  
  // Add sorted subjects
  Array.from(subjects).sort().forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.innerText = sub;
    select.appendChild(opt);
  });
  
  select.value = state.filters.subject;
}

// ==========================================================================
// Sync Widget UI Updating
// ==========================================================================
function updateSyncWidget() {
  const fill = document.getElementById('sync-progress-fill');
  const msg = document.getElementById('sync-message');
  const btn = document.getElementById('sync-btn');
  const lastSyncText = document.getElementById('last-sync-time');
  const icon = document.getElementById('sync-btn-icon');
  
  fill.style.width = `${state.syncStatus.progress}%`;
  msg.innerText = `Status: ${state.syncStatus.message}`;
  
  // Format last sync time
  if (state.syncStatus.last_sync) {
    const date = new Date(state.syncStatus.last_sync);
    lastSyncText.innerText = `Last: ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    lastSyncText.innerText = 'Last: Never';
  }
  
  if (state.syncStatus.status === 'syncing') {
    btn.disabled = true;
    btn.querySelector('span').innerText = 'Syncing...';
    icon.classList.add('syncing-rotation');
  } else {
    btn.disabled = false;
    btn.querySelector('span').innerText = 'Sync Now';
    icon.classList.remove('syncing-rotation');
  }
}

// ==========================================================================
// Active Tab Rendering
// ==========================================================================
function renderActiveTab() {
  // Hide all tabs, show active
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  
  document.getElementById(`tab-${state.activeTab}`).classList.add('active');
  document.getElementById(`nav-${state.activeTab}`).classList.add('active');
  
  // Update Header text
  const titleEl = document.getElementById('page-title');
  const subtitleEl = document.getElementById('page-subtitle');
  
  if (state.activeTab === 'dashboard') {
    titleEl.innerText = "Dashboard Overview";
    subtitleEl.innerText = "Manage and track all teacher-assigned tasks and grading scores.";
    renderDashboard();
  } else if (state.activeTab === 'calendar') {
    titleEl.innerText = "Calendar Planner";
    subtitleEl.innerText = "Schedule view of deadlines. Click events to view task details.";
    renderCalendar();
  } else if (state.activeTab === 'analytics') {
    titleEl.innerText = "Performance Analytics";
    subtitleEl.innerText = "Insights into assignments density, subjects volumes, and grades.";
    renderAnalytics();
  } else if (state.activeTab === 'cas') {
    titleEl.innerText = "ManageBac CAS Journal Dashboard";
    subtitleEl.innerText = "Log, track, and upload CAS experiences, reflections, and evidence.";
    renderCasTab();
  }
}

// ==========================================================================
// Dashboard Tab Rendering
// ==========================================================================
function getFilteredTasks() {
  return state.tasks.filter(task => {
    // 1. Search filter
    const matchesSearch = !state.filters.search || 
      task.title.toLowerCase().includes(state.filters.search.toLowerCase());
      
    // 2. Subject filter
    const matchesSubject = state.filters.subject === 'all' || 
      task.subject === state.filters.subject;
      
    // 3. Status filter
    let matchesStatus = true;
    if (state.filters.status !== 'all') {
      const views = task.views || [];
      if (state.filters.status === 'upcoming') {
        matchesStatus = views.includes('upcoming');
      } else if (state.filters.status === 'overdue') {
        matchesStatus = views.includes('overdue');
      } else if (state.filters.status === 'assessed') {
        matchesStatus = task.status === 'Assessed';
      } else if (state.filters.status === 'not_assessed') {
        matchesStatus = task.status === 'Not Assessed';
      } else if (state.filters.status === 'pending') {
        matchesStatus = task.status && task.status.toLowerCase().includes('submit');
      }
    }
    
    return matchesSearch && matchesSubject && matchesStatus;
  });
}

function renderDashboard() {
  const container = document.getElementById('tasks-board');
  const filtered = getFilteredTasks();
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
        <p>No tasks match your filter criteria.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  
  if (state.activeGroup === 'deadline') {
    // Group by Deadline buckets: Overdue, Today/This Week, Next Week, Later, Past (Graded / Completed)
    const buckets = {
      "Overdue": [],
      "Upcoming Tasks": [],
      "Past / Graded Tasks": []
    };
    
    filtered.forEach(task => {
      const views = task.views || [];
      if (views.includes('overdue')) {
        buckets["Overdue"].push(task);
      } else if (views.includes('upcoming')) {
        buckets["Upcoming Tasks"].push(task);
      } else {
        buckets["Past / Graded Tasks"].push(task);
      }
    });

    Object.keys(buckets).forEach(groupName => {
      const groupTasks = buckets[groupName];
      if (groupTasks.length > 0) {
        renderTaskGroup(container, groupName, groupTasks);
      }
    });
    
  } else {
    // Group by Subject
    const subjectBuckets = {};
    filtered.forEach(task => {
      const sub = task.subject || "Other";
      if (!subjectBuckets[sub]) {
        subjectBuckets[sub] = [];
      }
      subjectBuckets[sub].push(task);
    });

    // Render sorted subjects
    Object.keys(subjectBuckets).sort().forEach(sub => {
      renderTaskGroup(container, sub, subjectBuckets[sub]);
    });
  }
}

function renderTaskGroup(container, groupName, groupTasks) {
  const section = document.createElement('div');
  section.className = 'tasks-group-section';
  
  // Group Header
  const header = document.createElement('div');
  header.className = 'board-group-header';
  header.innerHTML = `
    <span>${groupName}</span>
    <span class="group-count">${groupTasks.length}</span>
  `;
  section.appendChild(header);
  
  // Cards Grid
  const grid = document.createElement('div');
  grid.className = 'tasks-grid';
  
  groupTasks.forEach(task => {
    const card = createTaskCard(task);
    grid.appendChild(card);
  });
  
  section.appendChild(grid);
  container.appendChild(section);
}

function createTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.id = task.id;
  
  // Header section
  const isOverdue = (task.views || []).includes('overdue');
  const isUpcoming = (task.views || []).includes('upcoming');
  const isAssessed = task.status === "Assessed";
  
  // Badges row
  let badgesHTML = '';
  task.badges.slice(0, 3).forEach(b => {
    let cls = 'type-tag';
    if (b.toLowerCase() === 'formative') cls = 'formative';
    else if (b.toLowerCase() === 'summative') cls = 'summative';
    else if (b.toLowerCase() === 'submitted') cls = 'submitted';
    else if (b.toLowerCase() === 'pending') cls = 'pending';
    badgesHTML += `<span class="badge ${cls}">${b}</span>`;
  });
  
  // Score Chip
  let scoreHTML = '';
  if (isAssessed && task.score) {
    const scoreVal = task.score;
    const pts = task.points ? task.points.replace('pts', ' pts') : '';
    scoreHTML = `
      <div class="task-score-chip">
        <span class="score-num">${scoreVal}</span>
        <span class="score-pts">${pts}</span>
      </div>
    `;
  } else {
    scoreHTML = `
      <div class="task-score-chip not-graded">
        <span class="score-pts">${task.status || "Not Graded"}</span>
      </div>
    `;
  }

  card.innerHTML = `
    <div class="task-card-header">
      <div>
        <h4 class="task-title">${task.title}</h4>
        <span class="task-subject">${task.subject || "No Subject"}</span>
      </div>
    </div>
    <div class="task-card-body">
      <div class="task-deadline">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>Due: ${task.time || task.date_header || "No Date"}</span>
      </div>
      <div class="task-badges-row">
        ${badgesHTML}
      </div>
    </div>
    <div class="task-card-footer">
      <span class="task-status-text">${isOverdue ? '<span style="color: var(--accent-red); font-weight:700">Overdue</span>' : isUpcoming ? 'Upcoming' : 'Past Task'}</span>
      ${scoreHTML}
    </div>
  `;
  
  card.addEventListener('click', () => showTaskModal(task));
  return card;
}

// ==========================================================================
// Calendar Tab Rendering
// ==========================================================================
function renderCalendar() {
  if (state.calendarView === 'week') {
    renderWeekView();
  } else {
    renderMonthView();
  }
}

function renderMonthView() {
  const daysGrid = document.getElementById('calendar-days-grid');
  const monthYearHeader = document.getElementById('calendar-month-year');
  
  daysGrid.innerHTML = '';
  monthYearHeader.innerText = `${MONTH_NAMES[state.calendarMonth]} ${state.calendarYear}`;
  
  const firstDayIndex = new Date(state.calendarYear, state.calendarMonth, 1).getDay();
  const totalDays = new Date(state.calendarYear, state.calendarMonth + 1, 0).getDate();
  const prevMonthTotalDays = new Date(state.calendarYear, state.calendarMonth, 0).getDate();
  
  // Match tasks due this month
  const calendarTasks = state.tasks.filter(t => {
    if (!t._date) return false;
    return t._date.getMonth() === state.calendarMonth && t._date.getFullYear() === state.calendarYear;
  });

  // 1. Previous Month Days
  for (let i = firstDayIndex; i > 0; i--) {
    const day = prevMonthTotalDays - i + 1;
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell other-month';
    cell.innerHTML = `<span class="day-num">${day}</span>`;
    daysGrid.appendChild(cell);
  }

  // 2. Current Month Days
  for (let day = 1; day <= totalDays; day++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell';
    
    // Check if cell represents today in state (June 14, 2026)
    if (day === 14 && state.calendarMonth === 5 && state.calendarYear === 2026) {
      cell.classList.add('today');
    }
    
    cell.innerHTML = `<span class="day-num">${day}</span>`;
    
    // Find tasks for this day
    const dayTasks = calendarTasks.filter(t => t._date.getDate() === day);
    if (dayTasks.length > 0) {
      const list = document.createElement('div');
      list.className = 'calendar-day-tasks';
      
      dayTasks.forEach(task => {
        const item = document.createElement('div');
        const views = task.views || [];
        let cls = 'upcoming';
        if (views.includes('overdue')) cls = 'overdue';
        else if (task.status === 'Assessed') cls = 'graded';
        
        item.className = `cal-task-item ${cls}`;
        item.innerText = task.title;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          showTaskModal(task);
        });
        list.appendChild(item);
      });
      cell.appendChild(list);
    }
    
    daysGrid.appendChild(cell);
  }
  
  // 3. Next Month Days to fill the calendar grid (6 rows * 7 days = 42 cells)
  const filledCells = firstDayIndex + totalDays;
  const remainingCells = 42 - filledCells;
  for (let day = 1; day <= remainingCells; day++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell other-month';
    cell.innerHTML = `<span class="day-num">${day}</span>`;
    daysGrid.appendChild(cell);
  }
}

function renderWeekView() {
  const weekDaysHeaders = document.getElementById('week-days-headers');
  const weekAllDayContainer = document.getElementById('week-all-day-container');
  const timeLabelsCol = document.getElementById('time-labels-col');
  const hourGridLines = document.getElementById('hour-grid-lines');
  const weekColumnsContainer = document.getElementById('week-columns-container');
  const monthYearHeader = document.getElementById('calendar-month-year');
  
  // 1. Calculate active week dates starting on Sunday
  const activeDate = state.calendarActiveDate || state.currentDate;
  const startOfWeek = new Date(activeDate);
  startOfWeek.setDate(activeDate.getDate() - activeDate.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    weekDates.push(d);
  }
  
  // Update Header Title (e.g. "June 2026")
  monthYearHeader.innerText = `${MONTH_NAMES[startOfWeek.getMonth()]} ${startOfWeek.getFullYear()}`;
  
  // 2. Render Header Row (Sun 14, Mon 15...)
  weekDaysHeaders.innerHTML = '<div class="time-header-cell"></div>';
  const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  weekDates.forEach((date, index) => {
    const cell = document.createElement('div');
    const isToday = date.getDate() === state.currentDate.getDate() &&
                    date.getMonth() === state.currentDate.getMonth() &&
                    date.getFullYear() === state.currentDate.getFullYear();
    
    cell.className = `day-header-cell ${isToday ? 'today' : ''}`;
    cell.innerHTML = `
      <span>${WEEKDAY_ABBR[index]}</span>
      <div class="day-badge">${date.getDate()}</div>
    `;
    weekDaysHeaders.appendChild(cell);
  });
  
  // 3. Render All-Day Cells Background Columns
  weekAllDayContainer.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const cell = document.createElement('div');
    cell.className = 'all-day-column-cell';
    weekAllDayContainer.appendChild(cell);
  }
  const allDayOverlay = document.createElement('div');
  allDayOverlay.className = 'all-day-events-overlay';
  allDayOverlay.id = 'all-day-events-overlay';
  weekAllDayContainer.appendChild(allDayOverlay);
  
  // 4. Render Time Columns Background Lines
  hourGridLines.innerHTML = '';
  for (let i = 0; i < 24; i++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    hourGridLines.appendChild(line);
  }
  
  // 5. Render Time Labels Column (12 AM, 1 AM...)
  timeLabelsCol.innerHTML = '';
  for (let i = 0; i < 24; i++) {
    const cell = document.createElement('div');
    cell.className = 'time-label-cell';
    let hourText = '';
    if (i === 0) hourText = '12 AM';
    else if (i < 12) hourText = `${i} AM`;
    else if (i === 12) hourText = '12 PM';
    else hourText = `${i - 12} PM`;
    cell.innerText = hourText;
    timeLabelsCol.appendChild(cell);
  }
  
  // 6. Create 7 day columns in weekColumnsContainer
  weekColumnsContainer.innerHTML = '';
  const dayColumnElements = [];
  for (let i = 0; i < 7; i++) {
    const col = document.createElement('div');
    col.className = 'week-day-column';
    col.setAttribute('data-day', i);
    weekColumnsContainer.appendChild(col);
    dayColumnElements.push(col);
  }
  
  // 7. Filter and Render Events (Managebac tasks and native Calendar events)
  const weekStartTs = startOfWeek.getTime();
  const weekEndTs = weekStartTs + 7 * 24 * 60 * 60 * 1000;
  
  // Filter native calendar events
  const weekCalendarEvents = state.calendarEvents.filter(e => {
    if (!e._startDate) return false;
    const t = e._startDate.getTime();
    return t >= weekStartTs && t < weekEndTs;
  });
  
  // Filter Managebac tasks
  const weekTasks = state.tasks.filter(t => {
    if (!t._date) return false;
    const tTime = t._date.getTime();
    return tTime >= weekStartTs && tTime < weekEndTs;
  });
  
  // Group all events by day index (0-6)
  const daysAllDay = Array.from({ length: 7 }, () => []);
  const daysHourly = Array.from({ length: 7 }, () => []);
  
  // Map native calendar events into groups
  weekCalendarEvents.forEach(e => {
    const dayIndex = e._startDate.getDay();
    if (e.is_all_day) {
      daysAllDay[dayIndex].push(e);
    } else {
      daysHourly[dayIndex].push(e);
    }
  });
  
  // Map Managebac tasks into groups.
  // To avoid duplicating tasks that already exist in native Calendar, check title match!
  weekTasks.forEach(task => {
    const dayIndex = task._date.getDay();
    
    const exists = weekCalendarEvents.some(ce => 
      ce._startDate.getDay() === dayIndex && 
      ce.title.toLowerCase().trim() === task.title.toLowerCase().trim()
    );
    if (exists) return; // Skip duplicate rendering
    
    // Check if task has specific hour (not 0:00 midnight)
    const hasTime = task._date.getHours() !== 0 || task._date.getMinutes() !== 0;
    
    if (hasTime) {
      daysHourly[dayIndex].push({
        title: task.title,
        start: task.time,
        location: task.subject || "",
        description: task.points || "",
        _startDate: task._date,
        _endDate: new Date(task._date.getTime() + 60 * 60 * 1000), // 1 hour duration default
        is_all_day: false,
        is_task: true,
        task_ref: task
      });
    } else {
      daysAllDay[dayIndex].push({
        title: task.title,
        location: task.subject || "",
        is_all_day: true,
        is_task: true,
        task_ref: task
      });
    }
  });
  
  // Render All-Day Events in overlay
  allDayOverlay.innerHTML = '';
  const maxAllDayRows = 4;
  const gridMatrix = Array.from({ length: maxAllDayRows }, () => Array(7).fill(null));
  
  for (let d = 0; d < 7; d++) {
    daysAllDay[d].forEach(event => {
      let rowIndex = 0;
      while (rowIndex < maxAllDayRows && gridMatrix[rowIndex][d] !== null) {
        rowIndex++;
      }
      if (rowIndex < maxAllDayRows) {
        gridMatrix[rowIndex][d] = event;
      }
    });
  }
  
  for (let row = 0; row < maxAllDayRows; row++) {
    for (let d = 0; d < 7; d++) {
      const event = gridMatrix[row][d];
      if (event) {
        const card = document.createElement('div');
        card.className = `all-day-event-card ${getEventCategory(event)}`;
        card.innerText = event.title;
        card.style.position = 'absolute';
        card.style.top = `${row * 22 + 4}px`;
        card.style.left = `${(d / 7) * 100 + 0.5}%`;
        card.style.width = `${100 / 7 - 1}%`;
        
        card.addEventListener('click', () => {
          if (event.is_task) {
            showTaskModal(event.task_ref);
          } else {
            showEventModal(event);
          }
        });
        allDayOverlay.appendChild(card);
      }
    }
  }
  
  // Render Hourly Events for each day
  for (let d = 0; d < 7; d++) {
    const colEl = dayColumnElements[d];
    const events = daysHourly[d];
    
    events.sort((a, b) => a._startDate.getTime() - b._startDate.getTime());
    
    const columns = [];
    events.forEach(event => {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const lastInCol = columns[i][columns[i].length - 1];
        if (event._startDate.getTime() >= lastInCol._endDate.getTime()) {
          columns[i].push(event);
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([event]);
      }
    });
    
    const totalCols = columns.length;
    columns.forEach((colEvents, colIndex) => {
      colEvents.forEach(event => {
        const startHour = event._startDate.getHours();
        const startMin = event._startDate.getMinutes();
        
        const top = startHour * 60 + startMin;
        const duration = event._endDate ? 
          Math.max(30, (event._endDate.getTime() - event._startDate.getTime()) / (60 * 1000)) : 
          60;
        
        const card = document.createElement('div');
        card.className = `week-event-card ${getEventCategory(event)}`;
        card.style.top = `${top}px`;
        card.style.height = `${duration}px`;
        
        const leftPercent = (colIndex / totalCols) * 96 + 2;
        const widthPercent = (96 / totalCols) - 1;
        card.style.left = `${leftPercent}%`;
        card.style.width = `${widthPercent}%`;
        card.style.zIndex = colIndex + 2;
        
        card.innerHTML = `
          <div class="week-event-title">${event.title}</div>
          ${event.location ? `<div class="week-event-loc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${event.location}</div>` : ''}
          <div class="week-event-time">${formatEventTimeRange(event)}</div>
        `;
        
        card.addEventListener('click', () => {
          if (event.is_task) {
            showTaskModal(event.task_ref);
          } else {
            showEventModal(event);
          }
        });
        
        colEl.appendChild(card);
      });
    });
  }
  
  // 8. Position the Current Time Marker Line
  const timeMarker = document.getElementById('current-time-marker');
  const today = new Date();
  
  const isTodayInWeek = weekDates.some(date => 
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
  
  const isMockedWeek = weekDates.some(date =>
    date.getDate() === 14 && date.getMonth() === 5 && date.getFullYear() === 2026
  );
  
  if (isTodayInWeek || isMockedWeek) {
    timeMarker.style.display = 'flex';
    
    let markerDate = today;
    if (isMockedWeek && !isTodayInWeek) {
      markerDate = new Date(2026, 5, 14, 18, 43); // June 14, 2026 6:43 PM
    }
    
    const minutesSinceMidnight = markerDate.getHours() * 60 + markerDate.getMinutes();
    timeMarker.style.top = `${minutesSinceMidnight}px`;
    
    const bubble = document.getElementById('marker-bubble');
    const displayHrs = markerDate.getHours();
    const displayMins = markerDate.getMinutes().toString().padStart(2, '0');
    const ampm = displayHrs >= 12 ? 'PM' : 'AM';
    const hour12 = displayHrs % 12 || 12;
    bubble.innerText = `${hour12}:${displayMins} ${ampm}`;
    
    setTimeout(() => {
      const scrollContainer = document.getElementById('week-hourly-scroll');
      if (scrollContainer) {
        scrollContainer.scrollTop = Math.max(0, minutesSinceMidnight - 180);
      }
    }, 50);
  } else {
    timeMarker.style.display = 'none';
    
    setTimeout(() => {
      const scrollContainer = document.getElementById('week-hourly-scroll');
      if (scrollContainer) {
        scrollContainer.scrollTop = 480; // 8 AM default
      }
    }, 50);
  }
}

function getEventCategory(event) {
  if (event.views && event.views.includes('overdue')) return 'overdue';
  if (event.is_task && event.task_ref && (event.task_ref.views || []).includes('overdue')) return 'overdue';
  if (event.status === 'Assessed') return 'graded';
  
  const cal = (event.calendar || '').toLowerCase().trim();
  const title = (event.title || '').toLowerCase().trim();
  
  if (cal.includes('personal') || cal.includes('activity')) return 'personal';
  if (cal.includes('class') || cal.includes('schedule') || cal.includes('blue')) return 'school';
  if (cal.includes('assignment') || cal.includes('test') || cal.includes('managebac') || event.is_task) return 'tasks';
  if (cal.includes('holiday') || cal.includes('节假日') || cal.includes('vacation')) return 'work';
  
  if (title.includes('check-in') || title.includes('dorm')) return 'personal';
  if (title.includes('ib ') || title.includes('hl') || title.includes('sl') || title.includes('class')) return 'school';
  
  return 'default';
}

function formatEventTimeRange(event) {
  if (!event._startDate) return '';
  const start = event._startDate;
  const end = event._endDate || new Date(start.getTime() + 60 * 60 * 1000);
  
  const formatTime = (d) => {
    let hrs = d.getHours();
    const mins = d.getMinutes().toString().padStart(2, '0');
    const ampm = hrs >= 12 ? 'PM' : 'AM';
    hrs = hrs % 12 || 12;
    return `${hrs}:${mins}${ampm}`;
  };
  
  return `${formatTime(start)} - ${formatTime(end)}`;
}

function showEventModal(event) {
  const modal = document.getElementById('task-modal');
  document.getElementById('modal-task-subject').innerText = event.calendar || "Calendar Event";
  document.getElementById('modal-task-title').innerText = event.title;
  
  const dateStr = event._startDate ? event._startDate.toLocaleString() : "-";
  document.getElementById('modal-task-deadline').innerText = dateStr;
  document.getElementById('modal-task-date-header').innerText = event.location || "No Location Specified";
  document.getElementById('modal-task-status').innerText = event.is_all_day ? "All-Day Event" : "Timed Event";
  
  const scoreContainer = document.getElementById('modal-task-score-container');
  scoreContainer.style.display = 'none';
  
  const badgesContainer = document.getElementById('modal-task-badges');
  badgesContainer.innerHTML = '';
  if (event.description) {
    const badge = document.createElement('span');
    badge.className = 'badge type-tag';
    badge.innerText = event.description;
    badgesContainer.appendChild(badge);
  }
  
  document.getElementById('modal-task-link').style.display = 'none';
  modal.classList.add('open');
}

// ==========================================================================
// Analytics Tab Rendering
// ==========================================================================
function renderAnalytics() {
  const total = state.tasks.length;
  if (total === 0) return;
  
  // Graded tasks
  const graded = state.tasks.filter(t => t.status === 'Assessed');
  const notAssessed = state.tasks.filter(t => t.status === 'Not Assessed');
  const overdue = state.tasks.filter(t => (t.views || []).includes('overdue'));
  
  // Percentages
  document.getElementById('pct-graded').innerText = `${Math.round((graded.length / total) * 100)}%`;
  document.getElementById('fill-pct-graded').style.width = `${(graded.length / total) * 100}%`;
  
  document.getElementById('pct-pending').innerText = `${Math.round((notAssessed.length / total) * 100)}%`;
  document.getElementById('fill-pct-pending').style.width = `${(notAssessed.length / total) * 100}%`;
  
  document.getElementById('pct-overdue').innerText = `${Math.round((overdue.length / total) * 100)}%`;
  document.getElementById('fill-pct-overdue').style.width = `${(overdue.length / total) * 100}%`;

  // 1. Grades Breakdown (1-7 scale)
  const grades = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0};
  const scoredTasks = graded.filter(t => t.score && !isNaN(t.score));
  scoredTasks.forEach(t => {
    const s = Math.round(parseFloat(t.score));
    if (grades[s] !== undefined) grades[s]++;
  });
  
  const maxGradeCount = Math.max(...Object.values(grades), 1);
  for (let g = 1; g <= 7; g++) {
    const count = grades[g];
    const pct = (count / maxGradeCount) * 100;
    document.getElementById(`grade-bar-${g}`).style.height = `${pct}%`;
    document.getElementById(`grade-val-${g}`).innerText = count;
  }

  // 2. Formative vs Summative Donut Chart
  let formativeCount = 0;
  let summativeCount = 0;
  state.tasks.forEach(t => {
    const badges = (t.badges || []).map(b => b.toLowerCase());
    if (badges.includes('formative')) formativeCount++;
    else if (badges.includes('summative')) summativeCount++;
  });
  
  const formativePct = total > 0 ? (formativeCount / total) * 100 : 50;
  const donut = document.getElementById('assessment-donut');
  donut.style.setProperty('--formative-percent', `${formativePct}%`);
  
  document.getElementById('donut-total').innerText = total;
  document.getElementById('count-formative').innerText = formativeCount;
  document.getElementById('count-summative').innerText = summativeCount;

  // 3. Top Subjects by Volume List
  const subjectCounts = {};
  state.tasks.forEach(t => {
    const sub = t.subject || "Other";
    subjectCounts[sub] = (subjectCounts[sub] || 0) + 1;
  });

  const sortedSubjects = Object.keys(subjectCounts).map(name => ({
    name, count: subjectCounts[name]
  })).sort((a, b) => b.count - a.count);

  const subjectListContainer = document.getElementById('subject-volume-list');
  subjectListContainer.innerHTML = '';
  
  const maxSubjectCount = sortedSubjects.length > 0 ? sortedSubjects[0].count : 1;
  sortedSubjects.slice(0, 5).forEach(sub => {
    const pct = (sub.count / maxSubjectCount) * 100;
    const row = document.createElement('div');
    row.className = 'subject-vol-row';
    row.innerHTML = `
      <div class="subject-vol-info">
        <span class="subject-vol-name">${sub.name}</span>
        <span class="subject-vol-count">${sub.count} tasks</span>
      </div>
      <div class="subject-vol-track">
        <div class="subject-vol-fill" style="width: ${pct}%"></div>
      </div>
    `;
    subjectListContainer.appendChild(row);
  });
}

// ==========================================================================
// Modal Dialog Controller
// ==========================================================================
function showTaskModal(task) {
  document.getElementById('modal-task-subject').innerText = task.subject || "No Subject";
  document.getElementById('modal-task-title').innerText = task.title;
  document.getElementById('modal-task-deadline').innerText = task.time || "No Specific Time";
  document.getElementById('modal-task-date-header').innerText = task.date_header || "No Date Header";
  
  const isOverdue = (task.views || []).includes('overdue');
  document.getElementById('modal-task-status').innerHTML = isOverdue ? 
    '<span style="color: var(--accent-red); font-weight:700">Overdue</span>' : task.status || "Pending";
  
  const scoreContainer = document.getElementById('modal-task-score-container');
  const scoreBadge = document.getElementById('modal-task-score');
  
  if (task.status === "Assessed" && task.score) {
    scoreContainer.style.display = 'block';
    const pts = task.points ? ` (${task.points})` : '';
    scoreBadge.innerText = `${task.score}${pts}`;
  } else {
    scoreContainer.style.display = 'none';
  }

  // Badges
  const badgesBox = document.getElementById('modal-task-badges');
  badgesBox.innerHTML = '';
  task.badges.forEach(b => {
    let cls = 'type-tag';
    if (b.toLowerCase() === 'formative') cls = 'formative';
    else if (b.toLowerCase() === 'summative') cls = 'summative';
    else if (b.toLowerCase() === 'submitted') cls = 'submitted';
    else if (b.toLowerCase() === 'pending') cls = 'pending';
    
    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    badge.innerText = b;
    badgesBox.appendChild(badge);
  });

  // Link
  const linkBtn = document.getElementById('modal-task-link');
  if (task.url) {
    linkBtn.href = task.url;
    linkBtn.style.display = 'flex';
  } else {
    linkBtn.style.display = 'none';
  }

  const modal = document.getElementById('task-modal');
  modal.classList.add('open');
}

function hideTaskModal() {
  document.getElementById('task-modal').classList.remove('open');
}

// ==========================================================================
// Setup Event Listeners & Bootstrapping
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Support Cmd + R / Ctrl + R to reload the dashboard
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      window.location.reload();
    }
  });

  // 1. Navigation clicks
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      renderActiveTab();
    });
  });

  // 2. Dashboard filters & groupings
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    renderDashboard();
  });

  document.getElementById('filter-subject').addEventListener('change', (e) => {
    state.filters.subject = e.target.value;
    renderDashboard();
  });

  document.getElementById('filter-status').addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    renderDashboard();
  });

  document.getElementById('btn-group-deadline').addEventListener('click', () => {
    state.activeGroup = 'deadline';
    document.getElementById('btn-group-deadline').classList.add('active');
    document.getElementById('btn-group-subject').classList.remove('active');
    renderDashboard();
  });

  document.getElementById('btn-group-subject').addEventListener('click', () => {
    state.activeGroup = 'subject';
    document.getElementById('btn-group-subject').classList.add('active');
    document.getElementById('btn-group-deadline').classList.remove('active');
    renderDashboard();
  });

  // 3. Calendar Navigation
  document.getElementById('cal-prev-btn').addEventListener('click', () => {
    if (state.calendarView === 'week') {
      state.calendarActiveDate.setDate(state.calendarActiveDate.getDate() - 7);
      state.calendarMonth = state.calendarActiveDate.getMonth();
      state.calendarYear = state.calendarActiveDate.getFullYear();
    } else {
      state.calendarMonth--;
      if (state.calendarMonth < 0) {
        state.calendarMonth = 11;
        state.calendarYear--;
      }
      state.calendarActiveDate = new Date(state.calendarYear, state.calendarMonth, 1);
    }
    renderCalendar();
  });

  document.getElementById('cal-next-btn').addEventListener('click', () => {
    if (state.calendarView === 'week') {
      state.calendarActiveDate.setDate(state.calendarActiveDate.getDate() + 7);
      state.calendarMonth = state.calendarActiveDate.getMonth();
      state.calendarYear = state.calendarActiveDate.getFullYear();
    } else {
      state.calendarMonth++;
      if (state.calendarMonth > 11) {
        state.calendarMonth = 0;
        state.calendarYear++;
      }
      state.calendarActiveDate = new Date(state.calendarYear, state.calendarMonth, 1);
    }
    renderCalendar();
  });

  document.getElementById('cal-today-btn').addEventListener('click', () => {
    state.calendarActiveDate = new Date(2026, 5, 14); // Locked to screenshot date
    state.calendarMonth = 5;
    state.calendarYear = 2026;
    renderCalendar();
  });

  // Calendar View Toggles
  const viewBtns = ['toggle-day', 'toggle-week', 'toggle-month', 'toggle-year'];
  viewBtns.forEach(btnId => {
    const el = document.getElementById(btnId);
    if (el) {
      el.addEventListener('click', (e) => {
        viewBtns.forEach(id => {
          const btn = document.getElementById(id);
          if (btn) btn.classList.remove('active');
        });
        el.classList.add('active');
        
        const view = el.getAttribute('data-view');
        state.calendarView = view;
        
        const weekContainer = document.getElementById('calendar-week-view');
        const monthContainer = document.getElementById('calendar-month-view');
        
        if (view === 'week') {
          weekContainer.classList.add('active');
          monthContainer.classList.remove('active');
        } else if (view === 'month') {
          weekContainer.classList.remove('active');
          monthContainer.classList.add('active');
        } else {
          weekContainer.classList.add('active');
          monthContainer.classList.remove('active');
        }
        
        renderCalendar();
      });
    }
  });

  // 4. Modal Close
  document.getElementById('modal-close-btn').addEventListener('click', hideTaskModal);
  document.getElementById('task-modal').addEventListener('click', (e) => {
    if (e.target.id === 'task-modal') hideTaskModal();
  });

  // 5. Sync Trigger click
  document.getElementById('sync-btn').addEventListener('click', triggerSync);

  // 6. Login/Logout Listeners
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }
  
  const logoutBtn = document.getElementById('nav-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  // Check authentication status on startup
  checkAuthStatus();
});

// ==========================================================================
// Authentication & Dashboard Initialization
// ==========================================================================
function initializeDashboard() {
  try {
    fetchTasks();
  } catch (err) {
    console.error("Error running fetchTasks:", err);
  }
  
  try {
    fetchSyncStatus();
  } catch (err) {
    console.error("Error running fetchSyncStatus:", err);
  }
  
  try {
    initCasDashboard();
  } catch (err) {
    console.error("Error running initCasDashboard:", err);
  }
  
  try {
    initDueRadar();
  } catch (err) {
    console.error("Error running initDueRadar:", err);
  }
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    
    if (data.credentials_exist && data.remembered) {
      document.getElementById('login-overlay').classList.remove('active');
      initializeDashboard();
      
      // Update profile info dynamically
      if (data.email) {
        document.querySelectorAll('.profile-email, .user-email').forEach(el => el.innerText = data.email);
        const namePart = data.email.split('@')[0];
        const displayName = namePart.split(/[\._\-]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        document.querySelectorAll('.profile-name, .user-name').forEach(el => el.innerText = displayName);
        const initials = displayName.split(' ').map(p => p.charAt(0)).join('').substring(0, 2).toUpperCase();
        document.querySelectorAll('.avatar').forEach(el => {
          el.innerText = initials || 'US';
        });
      }
      
      // Update trial days left
      const trialBadge = document.getElementById('profile-trial-status');
      if (trialBadge) {
        if (data.trial_remaining !== undefined && data.trial_remaining !== null) {
          const days = Math.ceil(data.trial_remaining);
          trialBadge.innerText = `Trial: ${days} day${days !== 1 ? 's' : ''} left`;
        } else {
          trialBadge.innerText = '';
        }
      }
    } else {
      document.getElementById('login-overlay').classList.add('active');
      if (data.email) {
        document.getElementById('login-email').value = data.email;
      }
      if (data.subdomain) {
        document.getElementById('login-subdomain').value = data.subdomain;
      }
    }
  } catch (err) {
    console.error("Failed to check auth status:", err);
    document.getElementById('login-overlay').classList.add('active');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const subdomain = document.getElementById('login-subdomain').value;
  const remember = document.getElementById('login-remember').checked;
  
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit-btn');
  const btnText = submitBtn.querySelector('.btn-text');
  const btnSpinner = submitBtn.querySelector('.btn-spinner');
  
  errorEl.style.display = 'none';
  btnText.style.display = 'none';
  btnSpinner.style.display = 'inline-block';
  submitBtn.disabled = true;
  document.getElementById('login-email').disabled = true;
  document.getElementById('login-password').disabled = true;
  document.getElementById('login-subdomain').disabled = true;
  document.getElementById('login-remember').disabled = true;
  
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, subdomain, remember })
    });
    
    const data = await res.json();
    
    if (res.ok && data.success) {
      document.getElementById('login-password').value = '';
      document.getElementById('login-overlay').classList.remove('active');
      initializeDashboard();
      
      // Automatically trigger background sync for tasks and CAS data on new account login
      triggerSync();
      performManageBacSync(true); // Run silently
    } else {
      errorEl.innerText = data.error || "Failed to log in. Please check your credentials.";
      errorEl.style.display = 'block';
    }
  } catch (err) {
    console.error("Login request error:", err);
    errorEl.innerText = "Connection failed. Please check if backend is running.";
    errorEl.style.display = 'block';
  } finally {
    btnText.style.display = 'inline-block';
    btnSpinner.style.display = 'none';
    submitBtn.disabled = false;
    document.getElementById('login-email').disabled = false;
    document.getElementById('login-password').disabled = false;
    document.getElementById('login-subdomain').disabled = false;
    document.getElementById('login-remember').disabled = false;
  }
}

async function handleLogout() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      document.getElementById('login-overlay').classList.add('active');
      document.getElementById('login-password').value = '';
      checkAuthStatus();
    }
  } catch (err) {
    console.error("Logout error:", err);
  }
}

// ==========================================================================
// Grade Calculator Controller
// ==========================================================================
let gradeCalculatorInitialized = false;

function initGradeCalculator() {
  if (gradeCalculatorInitialized) {
    populateCalcSubjectDropdown();
    calculateGradeRequired();
    return;
  }
  
  populateCalcSubjectDropdown();
  
  const inputs = [
    'calc-subject-select', 'calc-current-pct', 'calc-acquired-weight',
    'calc-exam-weight', 'calc-boundary-6', 'calc-boundary-7'
  ];
  
  inputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        if (id === 'calc-subject-select') {
          handleCalculatorSubjectChange();
        } else {
          calculateGradeRequired();
        }
      });
      el.addEventListener('change', () => {
        if (id === 'calc-subject-select') {
          handleCalculatorSubjectChange();
        } else {
          calculateGradeRequired();
        }
      });
    }
  });

  const acqInput = document.getElementById('calc-acquired-weight');
  const examInput = document.getElementById('calc-exam-weight');
  if (acqInput && examInput) {
    acqInput.addEventListener('input', () => {
      const val = parseFloat(acqInput.value);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        examInput.value = (100 - val).toFixed(0);
      }
    });
    examInput.addEventListener('input', () => {
      const val = parseFloat(examInput.value);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        acqInput.value = (100 - val).toFixed(0);
      }
    });
  }

  handleCalculatorSubjectChange();
  gradeCalculatorInitialized = true;
}

function populateCalcSubjectDropdown() {
  const select = document.getElementById('calc-subject-select');
  if (!select) return;
  
  const subjects = new Set();
  
  if (state.tasks) {
    state.tasks.forEach(t => {
      if (t.subject) subjects.add(t.subject);
    });
  }
  
  if (state.subjectGrades) {
    for (const key in state.subjectGrades) {
      subjects.add(key);
    }
  }
  
  if (state.subjectBoundaries) {
    for (const key in state.subjectBoundaries) {
      subjects.add(key);
    }
  }
  
  const normalizedSeen = new Set();
  // Sort by length descending to prefer longer/more descriptive names when de-duplicating
  const sortedSubjects = Array.from(subjects).sort((a, b) => b.length - a.length);
  
  const uniqueSubjects = [];
  sortedSubjects.forEach(sub => {
    const norm = normalizeSubjectName(sub);
    if (norm && !normalizedSeen.has(norm)) {
      normalizedSeen.add(norm);
      uniqueSubjects.push(sub);
    }
  });
  
  const currentSelection = select.value;
  select.innerHTML = '<option value="custom">-- Custom/Manual Input --</option>';
  
  uniqueSubjects.sort().forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.innerText = sub;
    select.appendChild(opt);
  });
  
  if (currentSelection && uniqueSubjects.includes(currentSelection)) {
    select.value = currentSelection;
  } else if (uniqueSubjects.length > 0 && !currentSelection) {
    select.selectedIndex = 1;
  }
}

function handleCalculatorSubjectChange() {
  const select = document.getElementById('calc-subject-select');
  if (!select) return;
  
  const sub = select.value;
  if (sub === 'custom') {
    calculateGradeRequired();
    return;
  }
  
  let currentPct = 75.0;
  let accomplishedWeight = 0;
  let leftoverWeight = 0;
  let hasOverallGrades = false;
  
  // Check if we have ManageBac overall grade and categories for this subject
  const classGrades = getSubjectGrades(sub);
  if (classGrades && classGrades.overall_percentage !== null) {
    hasOverallGrades = true;
    currentPct = classGrades.overall_percentage;
    document.getElementById('calc-current-pct').value = currentPct.toFixed(1);
    
    // Calculate weights based on ManageBac's category weights
    classGrades.categories.forEach(cat => {
      if (cat.percentage !== null || cat.grade !== null) {
        accomplishedWeight += cat.weight;
      } else {
        leftoverWeight += cat.weight;
      }
    });
    
    // If weights are missing or total 0, use defaults
    if (accomplishedWeight === 0 && leftoverWeight === 0) {
      accomplishedWeight = 70;
      leftoverWeight = 30;
    }
    
    document.getElementById('calc-acquired-weight').value = accomplishedWeight.toFixed(0);
    document.getElementById('calc-exam-weight').value = leftoverWeight.toFixed(0);
  }
  
  // Fallback to basic arithmetic average if ManageBac overall grades are not available
  if (!hasOverallGrades) {
    const subjectTasks = state.tasks.filter(t => t.subject === sub && t.status === 'Assessed');
    let totalPct = 0;
    let count = 0;
    
    subjectTasks.forEach(t => {
      if (t.points) {
        const ptsMatch = t.points.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
        if (ptsMatch) {
          const obtained = parseFloat(ptsMatch[1]);
          const maxPts = parseFloat(ptsMatch[2]);
          if (maxPts > 0) {
            totalPct += (obtained / maxPts) * 100;
            count++;
            return;
          }
        }
      }
      
      if (t.score && !isNaN(t.score)) {
        const score = parseFloat(t.score);
        if (score >= 1 && score <= 7) {
          const pct = 35 + (score - 1) * 10;
          totalPct += pct;
          count++;
        }
      }
    });
    
    if (count > 0) {
      currentPct = totalPct / count;
    }
    document.getElementById('calc-current-pct').value = currentPct.toFixed(1);
    
    // Set default fallbacks
    document.getElementById('calc-acquired-weight').value = "70";
    document.getElementById('calc-exam-weight').value = "30";
  }
  
  // Prefill boundaries from subjectBoundaries cache with fuzzy key matching
  const boundary6Input = document.getElementById('calc-boundary-6');
  const boundary7Input = document.getElementById('calc-boundary-7');
  if (boundary6Input && boundary7Input) {
    const boundaries = getSubjectBoundaries(sub);
    if (boundaries) {
      const b6 = boundaries["6"];
      const b7 = boundaries["7"];
      if (b6 !== undefined && b6 !== null) boundary6Input.value = Math.round(b6);
      if (b7 !== undefined && b7 !== null) boundary7Input.value = Math.round(b7);
    } else {
      // default fallback
      boundary6Input.value = 70;
      boundary7Input.value = 85;
    }
  }
  
  calculateGradeRequired();
}

function calculateGradeRequired() {
  const currentPct = parseFloat(document.getElementById('calc-current-pct').value) || 0;
  const acqWeight = parseFloat(document.getElementById('calc-acquired-weight').value) || 0;
  const examWeight = parseFloat(document.getElementById('calc-exam-weight').value) || 0;
  const boundary6 = parseFloat(document.getElementById('calc-boundary-6').value) || 70;
  const boundary7 = parseFloat(document.getElementById('calc-boundary-7').value) || 85;
  
  const b6Val = document.getElementById('target-boundary-6-val');
  const b7Val = document.getElementById('target-boundary-7-val');
  if (b6Val) b6Val.innerText = `Boundary: ${boundary6}%`;
  if (b7Val) b7Val.innerText = `Boundary: ${boundary7}%`;
  
  const targetGrade = currentPct >= boundary6 ? 7 : 6;
  const targetBoundary = targetGrade === 7 ? boundary7 : boundary6;
  
  const recBadge = document.getElementById('calc-recommended-badge');
  if (recBadge) {
    recBadge.innerText = `Target: Grade ${targetGrade}`;
    recBadge.style.background = targetGrade === 7 ? 'rgba(139, 92, 246, 0.15)' : 'rgba(56, 189, 248, 0.15)';
    recBadge.style.borderColor = targetGrade === 7 ? 'rgba(139, 92, 246, 0.3)' : 'rgba(56, 189, 248, 0.3)';
    recBadge.style.color = targetGrade === 7 ? 'var(--accent-primary)' : 'var(--accent-blue)';
  }
  
  const card6 = document.getElementById('target-card-6');
  const card7 = document.getElementById('target-card-7');
  if (card6 && card7) {
    if (targetGrade === 6) {
      card6.classList.add('active-target');
      card7.classList.remove('active-target');
    } else {
      card7.classList.add('active-target');
      card6.classList.remove('active-target');
    }
  }
  
  if (examWeight <= 0) {
    document.getElementById('target-6-result').innerText = '--';
    document.getElementById('target-7-result').innerText = '--';
    document.getElementById('formula-math-details').innerText = 'Final Exam weight must be greater than 0%';
    return;
  }
  
  const req6 = (boundary6 - (currentPct * acqWeight / 100)) / (examWeight / 100);
  const req7 = (boundary7 - (currentPct * acqWeight / 100)) / (examWeight / 100);
  
  const formatResult = (val) => {
    if (val <= 0) return "0.0% ✨";
    return `${val.toFixed(1)}%`;
  };
  
  document.getElementById('target-6-result').innerText = formatResult(req6);
  document.getElementById('target-7-result').innerText = formatResult(req7);
  
  const applyResultColors = (el, val) => {
    if (!el) return;
    if (val <= 0) {
      el.style.color = 'var(--accent-green)';
    } else if (val > 100) {
      el.style.color = 'var(--accent-red)';
    } else {
      el.style.color = 'var(--text-primary)';
    }
  };
  applyResultColors(document.getElementById('target-6-result'), req6);
  applyResultColors(document.getElementById('target-7-result'), req7);
  
  const activeReq = targetGrade === 7 ? req7 : req6;
  const currentContribution = (currentPct * acqWeight / 100).toFixed(1);
  const neededContribution = (targetBoundary - parseFloat(currentContribution)).toFixed(1);
  
  let mathDetails = `Target ${targetGrade} (${targetBoundary}%):\n`;
  mathDetails += `[ ${targetBoundary}% - (${currentPct}% × ${acqWeight}%) ] / ${examWeight}% \n`;
  mathDetails += `= [ ${targetBoundary}% - ${currentContribution}% ] / ${examWeight}% \n`;
  mathDetails += `= ${neededContribution}% / ${examWeight}% \n`;
  mathDetails += `= ${activeReq.toFixed(2)}% required on final exam`;
  
  if (activeReq <= 0) {
    mathDetails += `\n(Already secured! You will reach Grade ${targetGrade} even with a 0% on the final exam.)`;
  } else if (activeReq > 100) {
    mathDetails += `\n(Warning: Reaching Grade ${targetGrade} requires a score over 100%.)`;
  }
  
  document.getElementById('formula-math-details').innerText = mathDetails;
}

// ==========================================================================
// ManageBac CAS Dashboard Frontend Logic
// ==========================================================================
const casState = {
  experiences: [],
  reflections: [],
  uploadQueue: [],
  isUploading: false,
  activeEvidenceType: 'JournalEvidence',
  selectedFiles: [],
  loaded: false
};

const CAS_OUTCOMES = [
  { id: "138712", name: "Demonstrate how to initiate and plan a CAS experience", icon: "🗺️", short: "Initiative & Planning" },
  { id: "138711", name: "Demonstrate that challenges have been undertaken, developing new skills in the process", icon: "🧗", short: "Challenge & Skills" },
  { id: "138714", name: "Demonstrate the skills and recognize the benefits of working collaboratively", icon: "🤝", short: "Collaborative Skills" },
  { id: "138710", name: "Identify own strengths and develop areas for growth", icon: "📈", short: "Strength & Growth" },
  { id: "138716", name: "Recognize and consider the ethics of choices and actions", icon: "⚖️", short: "Ethics of Choices & Actions" },
  { id: "138713", name: "Show commitment to and perseverance in CAS experiences", icon: "⚓", short: "Commitment & Perseverance" },
  { id: "138715", name: "Demonstrate engagement with issues of global significance", icon: "🌍", short: "Global Engagement" }
];

async function renderCasTab() {
  if (!casState.loaded) {
    await loadCachedCasData();
  }
}

async function loadCachedCasData() {
  try {
    const res = await fetch('/api/cas/data');
    if (res.ok) {
      const data = await res.json();
      casState.experiences = data.experiences || [];
      casState.reflections = data.reflections || [];
      casState.loaded = true;
      
      const lastSync = data.last_sync;
      document.getElementById("mb-cas-last-sync").textContent = lastSync ? formatCasSyncTime(lastSync) : "Never";
      
      if (casState.experiences.length > 0) {
        updateCasConnectionStatus("connected", "CONNECTED");
      } else {
        updateCasConnectionStatus("disconnected", "DISCONNECTED");
      }
      
      populateExperiencesDropdowns(casState.experiences);
      computeStatsAndRender();
    }
  } catch (err) {
    console.error("Failed to load cached CAS data:", err);
  }
}

function formatCasSyncTime(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleString();
  } catch (e) {
    return isoString;
  }
}

async function performManageBacSync(silent = false) {
  const syncBtn = document.getElementById("btn-cas-sync");
  const syncIcon = document.getElementById("cas-sync-icon");
  
  syncBtn.disabled = true;
  syncIcon.classList.add("syncing-rotation");
  updateCasConnectionStatus("connecting", "SYNCING...");
  
  try {
    const res = await fetch('/api/cas/sync', { method: 'POST' });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to sync CAS experiences. Check credentials.");
    }
    const data = await res.json();
    casState.experiences = data.experiences || [];
    casState.reflections = data.reflections || [];
    casState.loaded = true;
    
    const lastSync = data.last_sync;
    document.getElementById("mb-cas-last-sync").textContent = lastSync ? formatCasSyncTime(lastSync) : "Never";
    
    updateCasConnectionStatus("connected", "CONNECTED");
    populateExperiencesDropdowns(casState.experiences);
    computeStatsAndRender();
    
    if (!silent) {
      alert("ManageBac Sync completed successfully! Stats and gallery have been updated.");
    }
  } catch (error) {
    console.error("ManageBac sync error:", error);
    updateCasConnectionStatus("disconnected", "DISCONNECTED / ERROR");
    if (!silent) {
      alert(`Sync Failed: ${error.message}`);
    }
  } finally {
    syncBtn.disabled = false;
    syncIcon.classList.remove("syncing-rotation");
  }
}

function updateCasConnectionStatus(status, text) {
  const badge = document.getElementById("mb-cas-status-badge");
  const statusText = document.getElementById("mb-cas-status-text");
  
  if (badge && statusText) {
    badge.className = `sync-status-indicator ${status}`;
    statusText.textContent = text;
  }
}

function populateExperiencesDropdowns(exps) {
  const uploadSelect = document.getElementById("cas-input-exp");
  const filterSelect = document.getElementById("cas-gallery-filter-exp");
  
  if (uploadSelect) {
    uploadSelect.innerHTML = '<option value="">-- Select an Experience --</option>';
    exps.forEach(exp => {
      const optUpload = document.createElement("option");
      optUpload.value = exp.id;
      optUpload.textContent = exp.name;
      uploadSelect.appendChild(optUpload);
    });
  }
  
  if (filterSelect) {
    filterSelect.innerHTML = '<option value="">All Experiences</option>';
    exps.forEach(exp => {
      const optFilter = document.createElement("option");
      optFilter.value = exp.id;
      optFilter.textContent = exp.name;
      filterSelect.appendChild(optFilter);
    });
  }
}

function computeStatsAndRender() {
  const refs = casState.reflections;
  const exps = casState.experiences;
  
  document.getElementById("cas-total-journals").textContent = refs.length;
  
  const totalHours = exps.reduce((sum, exp) => sum + (exp.hours || 0), 0);
  document.getElementById("cas-total-hours").textContent = totalHours;
  
  let cHours = 0, aHours = 0, sHours = 0;
  let cJournals = 0, aJournals = 0, sJournals = 0;
  
  exps.forEach(exp => {
    const cats = exp.categories || [];
    if (cats.includes('C')) cHours += exp.hours || 0;
    if (cats.includes('A')) aHours += exp.hours || 0;
    if (cats.includes('S')) sHours += exp.hours || 0;
  });
  
  refs.forEach(ref => {
    const cats = ref.experience_categories || [];
    if (cats.includes('C')) cJournals++;
    if (cats.includes('A')) aJournals++;
    if (cats.includes('S')) sJournals++;
  });
  
  document.getElementById("cas-c-hours").textContent = `${cHours} hrs`;
  document.getElementById("cas-c-journals").textContent = `${cJournals} ref`;
  
  document.getElementById("cas-a-hours").textContent = `${aHours} hrs`;
  document.getElementById("cas-a-journals").textContent = `${aJournals} ref`;
  
  document.getElementById("cas-s-hours").textContent = `${sHours} hrs`;
  document.getElementById("cas-s-journals").textContent = `${sJournals} ref`;
  
  computeSemesterStats(refs);
  
  let cntJournal = 0, cntFile = 0, cntVideo = 0, cntWebsite = 0, cntPhotos = 0;
  refs.forEach(ref => {
    if (ref.type === "Journal") cntJournal++;
    else if (ref.type === "File") cntFile++;
    else if (ref.type === "Video") cntVideo++;
    else if (ref.type === "Website") cntWebsite++;
    else if (ref.type === "Photos") cntPhotos++;
  });
  
  document.getElementById("val-cnt-journal").textContent = cntJournal;
  document.getElementById("val-cnt-file").textContent = cntFile;
  document.getElementById("val-cnt-video").textContent = cntVideo;
  document.getElementById("val-cnt-website").textContent = cntWebsite;
  document.getElementById("val-cnt-photos").textContent = cntPhotos;
  
  if (document.getElementById("cas-tab-content-gallery").style.display !== "none") {
    renderGallery();
  }
}

function computeSemesterStats(reflections) {
  const semestersCount = {};
  
  reflections.forEach(ref => {
    const dateStr = ref.date;
    if (!dateStr || dateStr === "Unknown Date") return;
    
    const parts = dateStr.split(', ');
    if (parts.length < 2) return;
    
    const dateObj = new Date(parts[1] + ", " + (parts[2] || ""));
    if (isNaN(dateObj.getTime())) return;
    
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    
    let semester = "Unknown Semester";
    
    if (year === 2024) {
      if (month >= 8) semester = "Grade 10 Fall (2024-2025 Sem 1)";
      else semester = "Grade 9 Spring (2023-2024 Sem 2)";
    } else if (year === 2025) {
      if (month <= 0) semester = "Grade 10 Fall (2024-2025 Sem 1)";
      else if (month >= 1 && month <= 5) semester = "Grade 10 Spring (2024-2025 Sem 2)";
      else semester = "Grade 11 Fall (2025-2026 Sem 1)";
    } else if (year === 2026) {
      if (month <= 0) semester = "Grade 11 Fall (2025-2026 Sem 1)";
      else if (month >= 1 && month <= 5) semester = "Grade 11 Spring (2025-2026 Sem 2)";
      else semester = "Grade 12 Fall (2026-2027 Sem 1)";
    } else if (year === 2027) {
      if (month <= 0) semester = "Grade 12 Fall (2026-2027 Sem 1)";
      else semester = "Grade 12 Spring (2026-2027 Sem 2)";
    }
    
    semestersCount[semester] = (semestersCount[semester] || 0) + 1;
  });
  
  const container = document.getElementById("cas-semesters-split");
  container.innerHTML = "";
  
  const sortedSems = Object.keys(semestersCount).sort().reverse();
  
  if (sortedSems.length === 0) {
    container.innerHTML = '<div class="empty-state-msg">No reflections with valid dates.</div>';
    return;
  }
  
  sortedSems.forEach(sem => {
    const row = document.createElement("div");
    row.className = "semester-stat-row";
    row.innerHTML = `
      <span class="sem-name">${sem}</span>
      <span class="sem-count">${semestersCount[sem]} pieces</span>
    `;
    container.appendChild(row);
  });
}

function renderGallery(filteredRefs = null) {
  const container = document.getElementById("cas-gallery-container");
  container.innerHTML = "";
  
  const refs = filteredRefs || casState.reflections;
  
  if (refs.length === 0) {
    container.innerHTML = '<div class="empty-state-msg">No evidence matching search criteria.</div>';
    return;
  }
  
  refs.forEach(ref => {
    const card = document.createElement("div");
    card.className = "gallery-card";
    
    let mediaHTML = "";
    
    if (ref.type === "Photos" && ref.images && ref.images.length > 0) {
      const captionEscaped = ref.body ? ref.body.replace(/"/g, '&quot;') : ref.experience_name;
      mediaHTML = `<img src="${ref.images[0]}" alt="Photo evidence" class="lightbox-trigger" data-url="${ref.images[0]}" data-caption="${captionEscaped}" style="cursor: pointer;" loading="lazy">`;
    } else if (ref.type === "File" && ref.attachments && ref.attachments.length > 0) {
      const attName = ref.attachments[0].name;
      const ext = attName.split('.').pop().slice(0, 4);
      mediaHTML = `
        <div class="gallery-doc-placeholder">
          <span>📁</span>
          <span class="gallery-doc-ext">${ext}</span>
        </div>
      `;
    } else if (ref.type === "Video") {
      mediaHTML = `
        <div class="gallery-doc-placeholder">
          <span>🎥</span>
          <span class="gallery-doc-ext">Video</span>
        </div>
      `;
    } else if (ref.type === "Website") {
      mediaHTML = `
        <div class="gallery-doc-placeholder">
          <span>🔗</span>
          <span class="gallery-doc-ext">Web</span>
        </div>
      `;
    } else {
      mediaHTML = `
        <div class="gallery-doc-placeholder">
          <span>📝</span>
          <span class="gallery-doc-ext">Journal</span>
        </div>
      `;
    }
    
    const outcomeHTML = ref.outcomes && ref.outcomes.length > 0 
      ? `<span class="gallery-tag">${ref.outcomes[0]}</span>`
      : "";
      
    let downloadHTML = "";
    if (ref.attachments && ref.attachments.length > 0) {
      downloadHTML = `<a href="${ref.attachments[0].url}" target="_blank" class="gallery-link">📥 Download</a>`;
    } else if (ref.images && ref.images.length > 0) {
      const captionEscaped = ref.body ? ref.body.replace(/"/g, '&quot;') : ref.experience_name;
      downloadHTML = `<a href="javascript:void(0)" class="gallery-link lightbox-trigger" data-url="${ref.images[0]}" data-caption="${captionEscaped}">🔍 View Large</a>`;
    } else {
      downloadHTML = `<span style="color: rgba(255,255,255,0.2)">Text Only</span>`;
    }
    
    card.innerHTML = `
      <div class="gallery-media">
        ${mediaHTML}
      </div>
      <div class="gallery-info">
        <div class="gallery-title">
          <span class="gallery-date">${ref.date || 'Unknown'}</span>
          ${ref.experience_name}
        </div>
        <div class="gallery-desc">
          ${ref.body || 'No description text.'}
        </div>
        <div class="gallery-card-footer">
          ${outcomeHTML}
          ${downloadHTML}
        </div>
      </div>
    `;
    
    container.appendChild(card);
  });
}

function filterGallery() {
  const searchVal = document.getElementById("cas-gallery-search").value.toLowerCase().trim();
  const filterExpId = document.getElementById("cas-gallery-filter-exp").value;
  
  const filtered = casState.reflections.filter(ref => {
    const searchMatch = !searchVal || 
                        ref.experience_name.toLowerCase().includes(searchVal) || 
                        ref.body.toLowerCase().includes(searchVal) || 
                        (ref.attachments && ref.attachments.some(a => a.name.toLowerCase().includes(searchVal)));
                        
    const expMatch = !filterExpId || ref.experience_id === filterExpId;
    
    return searchMatch && expMatch;
  });
  
  renderGallery(filtered);
}

function queueCurrentItem() {
  const expSelect = document.getElementById("cas-input-exp");
  const expId = expSelect.value;
  const expName = expSelect.options[expSelect.selectedIndex]?.text;
  const bodyText = document.getElementById("cas-input-body").value.trim();
  const urlVal = document.getElementById("cas-input-url").value.trim();
  
  if (!expId) {
    alert("Please select a CAS Experience first.");
    return;
  }
  
  if (casState.activeEvidenceType === "JournalEvidence" && !bodyText) {
    alert("Please enter the reflection text body.");
    return;
  }
  if ((casState.activeEvidenceType === "YoutubeEvidence" || casState.activeEvidenceType === "WebsiteEvidence") && !urlVal) {
    alert("Please enter the URL link.");
    return;
  }
  if ((casState.activeEvidenceType === "FileEvidence" || casState.activeEvidenceType === "AlbumEvidence") && casState.selectedFiles.length === 0) {
    alert("Please choose at least one file to attach.");
    return;
  }
  
  const outcomeIds = [];
  document.querySelectorAll("#cas-outcomes-grid input[type=checkbox]:checked").forEach(cb => {
    outcomeIds.push(cb.value);
  });
  
  if (casState.selectedFiles.length > 0) {
    casState.selectedFiles.forEach(file => {
      const qItem = {
        id: Math.random().toString(36).substr(2, 9),
        experience_id: expId,
        experience_name: expName,
        type: casState.activeEvidenceType,
        body: bodyText || `Attached evidence: ${file.name}`,
        url: urlVal,
        learning_outcome_ids: [...outcomeIds],
        file: file,
        filename: file.name,
        status: 'pending'
      };
      casState.uploadQueue.push(qItem);
    });
  } else {
    const qItem = {
      id: Math.random().toString(36).substr(2, 9),
      experience_id: expId,
      experience_name: expName,
      type: casState.activeEvidenceType,
      body: bodyText,
      url: urlVal,
      learning_outcome_ids: [...outcomeIds],
      file: null,
      filename: 'Text / Links',
      status: 'pending'
    };
    casState.uploadQueue.push(qItem);
  }
  
  document.getElementById("cas-input-body").value = "";
  document.getElementById("cas-input-url").value = "";
  casState.selectedFiles = [];
  updateSelectedFilesList();
  
  document.querySelectorAll("#cas-outcomes-grid input[type=checkbox]").forEach(cb => {
    cb.checked = false;
    cb.parentElement.classList.remove("checked");
  });
  
  renderQueueList();
}

function renderQueueList() {
  const container = document.getElementById("cas-queue-list");
  container.innerHTML = "";
  
  const countSpan = document.getElementById("cas-queue-count");
  countSpan.textContent = `${casState.uploadQueue.length} items`;
  
  const startBtn = document.getElementById("btn-cas-start-queue");
  if (casState.uploadQueue.length > 0) {
    startBtn.style.display = "block";
  } else {
    startBtn.style.display = "none";
    container.innerHTML = '<div class="empty-state-msg">No pending uploads. Add items in the Upload form.</div>';
    return;
  }
  
  casState.uploadQueue.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "queue-item";
    
    let statusClass = "pending";
    let statusText = "Pending";
    let progressWidth = "0%";
    let barClass = "";
    
    if (item.status === 'uploading') {
      statusClass = "uploading";
      statusText = "Uploading...";
      progressWidth = "50%";
    } else if (item.status === 'success') {
      statusClass = "success";
      statusText = "Success!";
      progressWidth = "100%";
      barClass = "success";
    } else if (item.status === 'error') {
      statusClass = "error";
      statusText = "Error";
      progressWidth = "100%";
      barClass = "error";
    }
    
    div.innerHTML = `
      <div class="queue-item-meta">
        <span class="q-title" title="${item.filename}">${item.filename}</span>
        <span class="q-type">${item.type.replace("Evidence", "")}</span>
        <span class="q-status ${statusClass}">${statusText}</span>
      </div>
      <div style="font-size: 0.65rem; color: rgba(255,255,255,0.4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        To: ${item.experience_name}
      </div>
      <div class="q-progress-bar">
        <div class="q-progress-fill ${barClass}" style="width: ${progressWidth}"></div>
      </div>
    `;
    container.appendChild(div);
  });
}

async function startBatchUpload() {
  if (casState.isUploading) return;
  
  const pendingItems = casState.uploadQueue.filter(item => item.status === 'pending');
  if (pendingItems.length === 0) {
    alert("All items in the queue have already been processed.");
    return;
  }
  
  casState.isUploading = true;
  document.getElementById("btn-cas-start-queue").disabled = true;
  document.getElementById("btn-cas-start-queue").textContent = "Processing Queue...";
  
  for (let i = 0; i < casState.uploadQueue.length; i++) {
    const item = casState.uploadQueue[i];
    if (item.status !== 'pending') continue;
    
    item.status = 'uploading';
    renderQueueList();
    
    try {
      const success = await uploadItemToServer(item);
      if (success) {
        item.status = 'success';
      } else {
        item.status = 'error';
      }
    } catch (err) {
      console.error("Queue upload error:", err);
      item.status = 'error';
    }
    
    renderQueueList();
    await new Promise(r => setTimeout(r, 1000));
  }
  
  casState.isUploading = false;
  document.getElementById("btn-cas-start-queue").disabled = false;
  document.getElementById("btn-cas-start-queue").textContent = "Start Upload Queue";
  
  casState.uploadQueue = casState.uploadQueue.filter(item => item.status !== 'success');
  renderQueueList();
  
  alert("Batch upload complete! Please click 'Sync CAS Data' to refresh your dashboard statistics and gallery.");
}

async function uploadItemToServer(item) {
  const formData = new FormData();
  formData.append("experience_id", item.experience_id);
  formData.append("type", item.type);
  formData.append("body", item.body);
  formData.append("url", item.url || "");
  
  item.learning_outcome_ids.forEach(id => {
    formData.append("learning_outcome_ids[]", id);
  });
  
  if (item.file) {
    formData.append("file", item.file, item.filename);
  }
  
  try {
    const response = await fetch(`/api/cas/upload`, {
      method: "POST",
      body: formData
    });
    
    const resData = await response.json();
    if (response.ok && resData.success) {
      return true;
    } else {
      console.error(`Failed to upload ${item.filename}:`, resData.error);
      return false;
    }
  } catch (err) {
    console.error(`Network error uploading ${item.filename}:`, err);
    return false;
  }
}

async function uploadCurrentItemDirectly() {
  const expSelect = document.getElementById("cas-input-exp");
  const expId = expSelect.value;
  const bodyText = document.getElementById("cas-input-body").value.trim();
  const urlVal = document.getElementById("cas-input-url").value.trim();
  
  if (!expId) {
    alert("Please select a CAS Experience first.");
    return;
  }
  
  if (casState.activeEvidenceType === "JournalEvidence" && !bodyText) {
    alert("Please enter the reflection text body.");
    return;
  }
  if ((casState.activeEvidenceType === "YoutubeEvidence" || casState.activeEvidenceType === "WebsiteEvidence") && !urlVal) {
    alert("Please enter the URL link.");
    return;
  }
  if ((casState.activeEvidenceType === "FileEvidence" || casState.activeEvidenceType === "AlbumEvidence") && casState.selectedFiles.length === 0) {
    alert("Please choose at least one file to attach.");
    return;
  }
  
  const outcomeIds = [];
  document.querySelectorAll("#cas-outcomes-grid input[type=checkbox]:checked").forEach(cb => {
    outcomeIds.push(cb.value);
  });
  
  const uploadBtn = document.getElementById("btn-cas-upload-direct");
  const origBtnText = uploadBtn.textContent;
  uploadBtn.disabled = true;
  uploadBtn.textContent = "Uploading Immediately...";
  
  try {
    let successCount = 0;
    
    if (casState.selectedFiles.length > 0) {
      for (const file of casState.selectedFiles) {
        const item = {
          experience_id: expId,
          type: casState.activeEvidenceType,
          body: bodyText || `Attached evidence: ${file.name}`,
          url: urlVal,
          learning_outcome_ids: outcomeIds,
          file: file,
          filename: file.name
        };
        const res = await uploadItemToServer(item);
        if (res) successCount++;
      }
    } else {
      const item = {
        experience_id: expId,
        type: casState.activeEvidenceType,
        body: bodyText,
        url: urlVal,
        learning_outcome_ids: outcomeIds,
        file: null,
        filename: 'Text / Links'
      };
      const res = await uploadItemToServer(item);
      if (res) successCount++;
    }
    
    if (successCount > 0) {
      alert(`Successfully uploaded ${successCount} item(s) to ManageBac!`);
      document.getElementById("cas-input-body").value = "";
      document.getElementById("cas-input-url").value = "";
      casState.selectedFiles = [];
      updateSelectedFilesList();
      
      document.querySelectorAll("#cas-outcomes-grid input[type=checkbox]").forEach(cb => {
        cb.checked = false;
        cb.parentElement.classList.remove("checked");
      });
      
      performManageBacSync();
    } else {
      alert("Failed to upload. See server console logs for details.");
    }
  } catch (err) {
    console.error("Direct upload error:", err);
    alert(`Upload error: ${err.message}`);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = origBtnText;
  }
}

function initCasDashboard() {
  const btnSync = document.getElementById("btn-cas-sync");
  if (!btnSync) return; // Exit if elements are not present

  btnSync.addEventListener("click", performManageBacSync);
  document.getElementById("btn-cas-queue-item").addEventListener("click", queueCurrentItem);
  document.getElementById("btn-cas-upload-direct").addEventListener("click", uploadCurrentItemDirectly);
  document.getElementById("btn-cas-start-queue").addEventListener("click", startBatchUpload);
  
  document.getElementById("cas-gallery-search").addEventListener("input", filterGallery);
  document.getElementById("cas-gallery-filter-exp").addEventListener("change", filterGallery);
  
  const btnUpload = document.getElementById("btn-cas-tab-upload");
  const btnGallery = document.getElementById("btn-cas-tab-gallery");
  
  const tabUpload = document.getElementById("cas-tab-content-upload");
  const tabGallery = document.getElementById("cas-tab-content-gallery");

  btnUpload.addEventListener("click", () => {
    btnUpload.classList.add("active");
    btnGallery.classList.remove("active");
    tabUpload.style.display = "block";
    tabGallery.style.display = "none";
  });

  btnGallery.addEventListener("click", () => {
    btnGallery.classList.add("active");
    btnUpload.classList.remove("active");
    tabGallery.style.display = "block";
    tabUpload.style.display = "none";
    renderGallery();
  });
  
  initEvidenceTypeSelector();
  initFileDropzone();
  renderOutcomesChecklist();
  
  // Lightbox Modal setup
  initLightbox();
  
  // Delegate click events inside gallery container for lightbox triggers
  document.getElementById("cas-gallery-container").addEventListener("click", (e) => {
    const trigger = e.target.closest(".lightbox-trigger");
    if (trigger) {
      e.preventDefault();
      const url = trigger.getAttribute("data-url");
      const caption = trigger.getAttribute("data-caption");
      openLightbox(url, caption);
    }
  });
}

function initLightbox() {
  const modal = document.getElementById("lightbox-modal");
  const closeBtn = document.getElementById("lightbox-close-btn");
  
  if (!modal) return;
  
  closeBtn.addEventListener("click", () => {
    modal.style.display = "none";
  });
  
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.style.display = "none";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "flex") {
      modal.style.display = "none";
    }
  });
}

function openLightbox(url, caption) {
  const modal = document.getElementById("lightbox-modal");
  const modalImg = document.getElementById("lightbox-img");
  const captionText = document.getElementById("lightbox-caption");
  
  if (!modal) return;
  
  modalImg.src = url;
  captionText.textContent = caption || "";
  modal.style.display = "flex";
}

function initEvidenceTypeSelector() {
  const tiles = document.querySelectorAll(".cas-tile");
  const inputUrl = document.getElementById("cas-group-url");
  const inputFile = document.getElementById("cas-group-file");
  const lblUrl = document.getElementById("cas-lbl-url");
  const lblFile = document.getElementById("cas-lbl-file");
  const dzSubtext = document.getElementById("cas-drop-subtext");

  tiles.forEach(tile => {
    tile.addEventListener("click", () => {
      tiles.forEach(t => t.classList.remove("active"));
      tile.classList.add("active");
      
      const type = tile.getAttribute("data-type");
      casState.activeEvidenceType = type;
      casState.selectedFiles = [];
      updateSelectedFilesList();
      
      inputUrl.style.display = "none";
      inputFile.style.display = "none";
      
      if (type === "JournalEvidence") {
        // No extra fields
      } else if (type === "FileEvidence") {
        inputFile.style.display = "block";
        lblFile.textContent = "Attach File Documents";
        dzSubtext.textContent = "Supports PDF, DOCX, ZIP, PPTX, etc.";
        document.getElementById("cas-input-file").multiple = false;
      } else if (type === "YoutubeEvidence") {
        inputUrl.style.display = "block";
        lblUrl.textContent = "YouTube / Video URL Link";
        document.getElementById("cas-input-url").placeholder = "https://www.youtube.com/watch?v=...";
      } else if (type === "WebsiteEvidence") {
        inputUrl.style.display = "block";
        lblUrl.textContent = "Website URL Link";
        document.getElementById("cas-input-url").placeholder = "https://...";
      } else if (type === "AlbumEvidence") {
        inputFile.style.display = "block";
        lblFile.textContent = "Upload Photos (Multiple Allowed)";
        dzSubtext.textContent = "Supports JPEG, PNG, GIF formats";
        document.getElementById("cas-input-file").multiple = true;
      }
    });
  });
}

function initFileDropzone() {
  const dropzone = document.getElementById("cas-dropzone");
  const fileInput = document.getElementById("cas-input-file");

  if (!dropzone || !fileInput) return;

  dropzone.addEventListener("click", () => fileInput.click());
  
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });
  
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
      handleFilesSelected(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      handleFilesSelected(fileInput.files);
    }
  });
}

function handleFilesSelected(filesList) {
  const isMultiple = document.getElementById("cas-input-file").multiple;
  
  if (isMultiple) {
    for (let i = 0; i < filesList.length; i++) {
      casState.selectedFiles.push(filesList[i]);
    }
  } else {
    casState.selectedFiles = [filesList[0]];
  }
  
  updateSelectedFilesList();
}

function updateSelectedFilesList() {
  const container = document.getElementById("cas-selected-files-list");
  if (!container) return;
  container.innerHTML = "";
  
  casState.selectedFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "selected-file-item";
    const sizeKB = (file.size / 1024).toFixed(1);
    
    item.innerHTML = `
      <div class="selected-file-info">
        <span>📄</span>
        <span><strong>${file.name}</strong> (${sizeKB} KB)</span>
      </div>
      <button class="remove-file-btn" data-index="${index}">×</button>
    `;
    
    item.querySelector(".remove-file-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(e.target.getAttribute("data-index"));
      casState.selectedFiles.splice(idx, 1);
      updateSelectedFilesList();
    });
    
    container.appendChild(item);
  });
}

function renderOutcomesChecklist() {
  const container = document.getElementById("cas-outcomes-grid");
  if (!container) return;
  container.innerHTML = "";
  
  CAS_OUTCOMES.forEach(out => {
    const label = document.createElement("label");
    label.className = "outcome-cb-label";
    label.innerHTML = `
      <input type="checkbox" value="${out.id}" data-short="${out.short}">
      <span>${out.icon} <strong>${out.short}</strong>: ${out.name}</span>
    `;
    
    label.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) {
        label.classList.add("checked");
      } else {
        label.classList.remove("checked");
      }
    });
    
    container.appendChild(label);
  });
}

// ==========================================================================
// Due Soon Radar Widget Logic
// ==========================================================================
state.dueRadar = {
  visible: true,
  days: 7,
  includeOverdue: true
};

// Safe localStorage helper to prevent exceptions in sandboxed WKWebViews
function safeGetLocalStorage(key, defaultValue) {
  try {
    const val = localStorage.getItem(key);
    return val !== null ? val : defaultValue;
  } catch (e) {
    console.warn("localStorage.getItem failed:", e);
    return defaultValue;
  }
}

function safeSetLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("localStorage.setItem failed:", e);
  }
}

function initDueRadar() {
  // Load saved preferences safely
  state.dueRadar.visible = (safeGetLocalStorage("dueRadarVisible", "true") === "true");
  state.dueRadar.days = parseInt(safeGetLocalStorage("dueRadarDays", "7"), 10);
  state.dueRadar.includeOverdue = (safeGetLocalStorage("dueRadarIncludeOverdue", "true") === "true");

  // Set initial control values in DOM
  const rangeSelect = document.getElementById("due-radar-range-select");
  if (rangeSelect) {
    rangeSelect.value = state.dueRadar.days;
    rangeSelect.addEventListener("change", (e) => {
      state.dueRadar.days = parseInt(e.target.value, 10);
      safeSetLocalStorage("dueRadarDays", state.dueRadar.days);
      renderDueRadar();
    });
  }

  const includeOverdueCheckbox = document.getElementById("due-radar-pref-show-overdue");
  if (includeOverdueCheckbox) {
    includeOverdueCheckbox.checked = state.dueRadar.includeOverdue;
    includeOverdueCheckbox.addEventListener("change", (e) => {
      state.dueRadar.includeOverdue = e.target.checked;
      safeSetLocalStorage("dueRadarIncludeOverdue", state.dueRadar.includeOverdue);
      renderDueRadar();
    });
  }

  // Toggle settings panel
  const settingsBtn = document.getElementById("due-radar-settings-btn");
  const settingsPanel = document.getElementById("due-radar-settings");
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener("click", () => {
      const isHidden = settingsPanel.style.display === "none";
      settingsPanel.style.display = isHidden ? "flex" : "none";
    });
  }

  // Close/Minimize button
  const closeBtn = document.getElementById("due-radar-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      state.dueRadar.visible = false;
      safeSetLocalStorage("dueRadarVisible", "false");
      renderDueRadar();
    });
  }

  // Floating trigger button
  const triggerBtn = document.getElementById("due-radar-trigger");
  if (triggerBtn) {
    triggerBtn.addEventListener("click", () => {
      state.dueRadar.visible = true;
      safeSetLocalStorage("dueRadarVisible", "true");
      renderDueRadar();
    });
  }

  // Global toggle in dashboard header controls
  const globalToggle = document.getElementById("dashboard-radar-toggle");
  if (globalToggle) {
    globalToggle.checked = state.dueRadar.visible;
    globalToggle.addEventListener("change", (e) => {
      state.dueRadar.visible = e.target.checked;
      safeSetLocalStorage("dueRadarVisible", state.dueRadar.visible);
      renderDueRadar();
    });
  }

  renderDueRadar();
}

function renderDueRadar() {
  const widget = document.getElementById("due-radar-widget");
  const trigger = document.getElementById("due-radar-trigger");
  const listContainer = document.getElementById("due-radar-list");
  const badge = document.getElementById("due-radar-badge");
  const pulseIndicator = document.getElementById("due-radar-pulse");
  
  if (!widget || !trigger || !listContainer) return;

  // Sync global toggle status
  const globalToggle = document.getElementById("dashboard-radar-toggle");
  if (globalToggle) {
    globalToggle.checked = state.dueRadar.visible;
  }

  // If tasks haven't loaded yet
  if (!state.tasks || state.tasks.length === 0) {
    listContainer.innerHTML = `
      <div class="radar-empty-state">
        <span class="empty-icon">⏳</span>
        <p>Loading tasks...</p>
      </div>
    `;
    return;
  }

  // 1. Filter and identify tasks that need to be done
  const needsDone = state.tasks.filter(t => {
    // Exclude completed or graded tasks
    if (t.status === 'Assessed') return false;
    
    // If badges explicitly mention 'Submitted' (case insensitive), exclude it
    const badges = (t.badges || []).map(b => b.toLowerCase());
    if (badges.includes('submitted')) return false;
    
    return true;
  });

  const now = new Date();
  const targetTime = now.getTime() + state.dueRadar.days * 24 * 60 * 60 * 1000;

  const overdueTasks = [];
  const upcomingTasks = [];

  needsDone.forEach(t => {
    const isExplicitOverdue = (t.views || []).includes('overdue');
    
    if (t._date) {
      if (t._date < now) {
        overdueTasks.push(t);
      } else if (t._date.getTime() <= targetTime) {
        upcomingTasks.push(t);
      }
    } else {
      if (isExplicitOverdue) {
        overdueTasks.push(t);
      }
    }
  });

  // Sort chronologically (oldest / closest first)
  overdueTasks.sort((a, b) => (a._date || 0) - (b._date || 0));
  upcomingTasks.sort((a, b) => (a._date || 0) - (b._date || 0));

  // Determine total relevant count for trigger badge
  // Badge includes overdue tasks (if checked) + upcoming tasks
  const totalCount = (state.dueRadar.includeOverdue ? overdueTasks.length : 0) + upcomingTasks.length;
  if (badge) {
    badge.textContent = totalCount;
  }

  // Adjust pulse indicator depending on urgency
  if (pulseIndicator) {
    pulseIndicator.className = "pulse-indicator";
    if (overdueTasks.length > 0 && state.dueRadar.includeOverdue) {
      pulseIndicator.classList.add("red");
    } else if (upcomingTasks.length > 0) {
      pulseIndicator.classList.add("orange");
    } else {
      pulseIndicator.classList.add("green");
    }
  }

  // 2. Manage visibility
  if (state.dueRadar.visible) {
    widget.classList.remove("hidden");
    trigger.style.display = "none";
  } else {
    widget.classList.add("hidden");
    trigger.style.display = "flex";
  }

  // 3. Render list items
  listContainer.innerHTML = "";
  
  const displayTasks = [];
  if (state.dueRadar.includeOverdue) {
    overdueTasks.forEach(t => displayTasks.push({ task: t, isOverdue: true }));
  }
  upcomingTasks.forEach(t => displayTasks.push({ task: t, isOverdue: false }));

  if (displayTasks.length === 0) {
    listContainer.innerHTML = `
      <div class="radar-empty-state">
        <span class="empty-icon">🌟</span>
        <p>All clear!<br>No pending tasks due soon.</p>
      </div>
    `;
    return;
  }

  displayTasks.forEach(({ task, isOverdue }) => {
    const item = document.createElement("div");
    item.className = "radar-task-item";
    
    const timeBadgeClass = isOverdue ? "overdue" : "due-soon";
    const timeBadgeText = isOverdue ? "Overdue" : formatRadarTimeRemaining(task._date);
    
    item.innerHTML = `
      <div class="radar-task-top">
        <span class="radar-task-subject">${shortenRadarSubject(task.subject)}</span>
        <span class="radar-task-status-badge ${timeBadgeClass}">${timeBadgeText}</span>
      </div>
      <div class="radar-task-title" title="${task.title}">${task.title}</div>
      <div class="radar-task-due">
        <span>📅</span> <span>${task.time || task.date_header || "No deadline details"}</span>
      </div>
    `;
    
    item.addEventListener("click", () => {
      const taskObj = state.tasks.find(x => x.id === task.id);
      if (taskObj) {
        showTaskModal(taskObj);
      }
    });
    
    listContainer.appendChild(item);
  });
}

function shortenRadarSubject(subject) {
  if (!subject) return "Other";
  const match = subject.match(/(?:DP\d*|MYP\d*|CP\d*)-([^-(（]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return subject.split(' (Grade')[0].replace('IB DP DP1-', '').replace('IB DP DP2-', '').trim();
}

function formatRadarTimeRemaining(date) {
  if (!date) return "Due Soon";
  const now = new Date();
  const diffMs = date - now;
  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) {
    return "Today";
  } else if (diffDays === 1) {
    return "Tomorrow";
  } else {
    return `In ${diffDays}d`;
  }
}

// ==========================================================================
// Theme (Light/Dark Mode) Toggle Setup
// ==========================================================================
function initThemeToggle() {
  const themeToggleBtn = document.getElementById('theme-toggle');
  if (!themeToggleBtn) return;
  
  const sunIcon = themeToggleBtn.querySelector('.sun-icon');
  const moonIcon = themeToggleBtn.querySelector('.moon-icon');
  
  function applyTheme(theme) {
    if (theme === 'light') {
      document.body.classList.add('light-theme');
      if (sunIcon) sunIcon.style.display = 'block';
      if (moonIcon) moonIcon.style.display = 'none';
    } else {
      document.body.classList.remove('light-theme');
      if (sunIcon) sunIcon.style.display = 'none';
      if (moonIcon) moonIcon.style.display = 'block';
    }
  }

  // Check localStorage first, otherwise fallback to system theme
  let currentTheme = localStorage.getItem('app-theme');
  if (!currentTheme) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    currentTheme = prefersDark ? 'dark' : 'light';
  }
  applyTheme(currentTheme);
  
  themeToggleBtn.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light-theme');
    const newTheme = isLight ? 'light' : 'dark';
    localStorage.setItem('app-theme', newTheme);
    applyTheme(newTheme);
  });

  // Watch for prefers-color-scheme system changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('app-theme')) {
      const systemTheme = e.matches ? 'dark' : 'light';
      applyTheme(systemTheme);
    }
  });
}

// Call theme toggle initialization immediately since script is at the bottom of the HTML
initThemeToggle();

// Header drag support for macOS native window performance
(function initHeaderDrag() {
  const header = document.querySelector('.main-header');
  if (header) {
    header.addEventListener('mousedown', (e) => {
      // Don't drag if user clicked on buttons, avatars, inputs, profile, or toggle switch
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('.profile-badge') || e.target.closest('.radar-toggle-wrapper')) {
        return;
      }
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.windowDrag) {
        window.webkit.messageHandlers.windowDrag.postMessage(null);
      }
    });
  }
})();

