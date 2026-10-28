/**
 * REGEN DESIGN REQUEST TRACKER — Google Apps Script backend
 * ---------------------------------------------------------------
 * Sales create design requests (deadline + priority), the Design Lead
 * assigns them to designers, and both teams get phone push alerts
 * (ntfy app) when a deadline is near or missed.
 *
 * Setup (once):  open this script from the Google Sheet
 *   (Extensions > Apps Script), paste this file, then run setup().
 *   Then Deploy > New deployment > Web app
 *     Execute as: Me    Who has access: Anyone
 *   Copy the /exec URL into the app (index.html, API_URL).
 *
 * © Regen Renewables (Pvt) Ltd. Confidential — internal use only.
 */

// ===================== SETTINGS =====================
const CFG = {
  TZ: 'Asia/Colombo',
  SOON_HOURS: 48,          // first "due soon" push this many hours before the deadline
  URGENT_HOURS: 24,        // second push ("due within 24h")
  SUMMARY_HOUR: 8,         // morning summary push at 8 am
  NTFY_SERVER: 'https://ntfy.sh'
};

const STATUSES = ['New', 'Assigned', 'In Progress', 'Info Needed', 'Review', 'Completed', 'On Hold', 'Cancelled'];
const CLOSED = ['Completed', 'Cancelled'];
const PRIORITIES = ['Very Urgent', 'Urgent', 'High', 'Normal', 'Low'];
const TOP_PRIORITY = p => p === 'Very Urgent' || p === 'Urgent';

/* ---- Due-date rules (identical in the app and in Code.gs) ----
   Working days skip Saturdays, Sundays and the holidays in the Sheet's "Holidays" tab.
   A deadline falls at 5:00 pm on its last working day, counted from the day after the request. */
const DUE_RULES = {
  'Very Urgent': { days: 1, queue: false },   // reason required, existing workload ignored
  'Urgent':      { days: 1, queue: true },
  'High':        { days: 2, queue: true },
  'Normal':      { days: 3, queue: true },
  'Low':         { days: 4, queue: true }
};
const PRIORITY_ORDER = ['Very Urgent', 'Urgent', 'High', 'Normal', 'Low'];
const WORKLOAD_STATUSES = ['New', 'Assigned', 'In Progress', 'Info Needed', 'Review'];
const WORK_END_HOUR = 17;
const SL_OFFSET_MIN = 330;   // Sri Lanka time, UTC+05:30, no daylight saving
const VERY_URGENT_REASON_MIN = 10;
const DEFAULT_HOLIDAYS = [
  ['2026-01-03','Duruthu Full Moon Poya Day'],['2026-01-15','Tamil Thai Pongal Day'],['2026-02-01','Navam Full Moon Poya Day'],
  ['2026-02-04','Independence Day'],['2026-02-15','Mahasivarathri Day'],['2026-03-02','Medin Full Moon Poya Day'],
  ['2026-03-21','Eid-Ul-Fitr (Ramazan Festival Day)'],['2026-04-01','Bak Full Moon Poya Day'],['2026-04-03','Good Friday'],
  ['2026-04-13','Day prior to Sinhala & Tamil New Year Day'],['2026-04-14','Sinhala & Tamil New Year Day'],
  ['2026-05-01','Vesak Full Moon Poya Day / May Day'],['2026-05-02','Day following Vesak Full Moon Poya Day'],
  ['2026-05-28','Eid-Ul-Alha (Hadji Festival Day)'],['2026-05-30','Adhi Poson Full Moon Poya Day'],['2026-06-29','Poson Full Moon Poya Day'],
  ['2026-07-29','Esala Full Moon Poya Day'],['2026-08-26','Milad-Un-Nabi (Holy Prophet\'s Birthday)'],['2026-08-27','Nikini Full Moon Poya Day'],
  ['2026-09-26','Binara Full Moon Poya Day'],['2026-10-25','Vap Full Moon Poya Day'],['2026-11-08','Deepavali Festival Day'],
  ['2026-11-24','Ill Full Moon Poya Day'],['2026-12-23','Unduvap Full Moon Poya Day'],['2026-12-25','Christmas Day'],
  ['2027-01-15','Tamil Thai Pongal Day'],['2027-01-22','Duruthu Full Moon Poya Day'],['2027-02-04','Independence Day'],
  ['2027-02-20','Navam Full Moon Poya Day'],['2027-03-06','Mahasivarathri Day'],['2027-03-10','Eid-Ul-Fitr (Ramazan Festival Day)'],
  ['2027-03-22','Medin Full Moon Poya Day'],['2027-03-26','Good Friday'],['2027-04-13','Day prior to Sinhala & Tamil New Year Day'],
  ['2027-04-14','Sinhala & Tamil New Year Day'],['2027-04-20','Bak Full Moon Poya Day'],['2027-05-01','May Day'],
  ['2027-05-17','Eid-Ul-Alha (Hadji Festival Day)'],['2027-05-19','Vesak Full Moon Poya Day'],['2027-05-20','Day following Vesak Full Moon Poya Day'],
  ['2027-06-18','Poson Full Moon Poya Day'],['2027-07-18','Esala Full Moon Poya Day'],['2027-08-15','Milad-Un-Nabi (Holy Prophet\'s Birthday)'],
  ['2027-08-16','Nikini Full Moon Poya Day'],['2027-09-15','Binara Full Moon Poya Day'],['2027-10-15','Vap Full Moon Poya Day'],
  ['2027-10-28','Deepawali Festival Day'],['2027-11-13','Ill Full Moon Poya Day'],['2027-12-13','Unduwap Full Moon Poya Day'],
  ['2027-12-25','Christmas Day']
];
function slDay_(ms) { return new Date(ms + SL_OFFSET_MIN * 6e4).toISOString().slice(0, 10); }
function nextDay_(day) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function isWorkDay_(day, hol) { const w = new Date(day + 'T00:00:00Z').getUTCDay(); return w !== 0 && w !== 6 && !hol[day]; }
function addWorkDays_(fromMs, n, hol) {
  let day = slDay_(fromMs), c = 0;
  while (c < n) { day = nextDay_(day); if (isWorkDay_(day, hol)) c++; }
  return Date.parse(day + 'T' + String(WORK_END_HOUR).padStart(2, '0') + ':00:00Z') - SL_OFFSET_MIN * 6e4;
}
/** Earliest allowed deadline for a priority, given the open design workload.
 *  Workload = the working days of every pending job (by its priority), shared across the active designers. */
function earliestDue_(priority, requests, designerCount, hol, nowMs, excludeId) {
  const rule = DUE_RULES[priority] || DUE_RULES.Normal;
  const pending = requests.filter(r => r.ID !== excludeId && WORKLOAD_STATUSES.indexOf(r.Status) >= 0);
  const loadDays = pending.reduce((s, r) => s + (DUE_RULES[r.Priority] || DUE_RULES.Normal).days, 0);
  const team = Math.max(1, designerCount || 0);
  const queueDays = rule.queue ? Math.ceil(loadDays / team) : 0;
  return {
    due: addWorkDays_(nowMs, queueDays + rule.days, hol),
    workloadEnd: queueDays ? addWorkDays_(nowMs, queueDays, hol) : null,
    queueDays: queueDays, needDays: rule.days, pending: pending.length, loadDays: loadDays, team: team, queue: rule.queue
  };
}

const REQ_HEADERS = [
  'ID', 'Created', 'CreatedBy', 'Client', 'Location', 'SystemKW', 'ProjectType',
  'Deliverables', 'Priority', 'Deadline', 'SalesNotes', 'AssignedTo', 'AssignedAt',
  'Status', 'DesignNotes', 'CompletedAt', 'UpdatedAt', 'UpdatedBy', 'AlertStage', 'UrgentReason'
];
const LOG_HEADERS = ['Time', 'ID', 'By', 'Action', 'Detail'];
const TEAM_HEADERS = ['Name', 'Team', 'Role', 'Active', 'NtfyTopic'];
const HOLIDAY_HEADERS = ['Date', 'Holiday'];

// ===================== ONE-TIME SETUP =====================
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const p = PropertiesService.getScriptProperties();
  p.setProperty('SHEET_ID', ss.getId());

  ensureSheet_(ss, 'Requests', REQ_HEADERS);
  ensureSheet_(ss, 'Log', LOG_HEADERS);
  ensureReqColumns_();
  holidaySheet_();
  const team = ensureSheet_(ss, 'Team', TEAM_HEADERS);
  if (team.getLastRow() < 2) {
    team.getRange(2, 1, 3, 5).setValues([
      ['Your Name', 'Design', 'Lead', 'Yes', ''],
      ['Designer 1', 'Design', 'Member', 'Yes', ''],
      ['Kavish', 'Sales', 'Member', 'Yes', '']
    ]);
  }

  const rnd = () => Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
  if (!p.getProperty('SALES_KEY')) p.setProperty('SALES_KEY', 'S-' + rnd());
  if (!p.getProperty('DESIGN_KEY')) p.setProperty('DESIGN_KEY', 'D-' + rnd());
  if (!p.getProperty('LEAD_KEY')) p.setProperty('LEAD_KEY', 'L-' + rnd());
  if (!p.getProperty('NTFY_SALES')) p.setProperty('NTFY_SALES', 'regen-sales-' + rnd().toLowerCase() + rnd().toLowerCase());
  if (!p.getProperty('NTFY_DESIGN')) p.setProperty('NTFY_DESIGN', 'regen-design-' + rnd().toLowerCase() + rnd().toLowerCase());
  if (!p.getProperty('APP_URL')) p.setProperty('APP_URL', '');

  // (Re)install timed triggers
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['checkDeadlines', 'morningSummary'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkDeadlines').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('morningSummary').timeBased().atHour(CFG.SUMMARY_HOUR).everyDays(1).inTimezone(CFG.TZ).create();

  showSettings();
}

/** Run any time to see the team keys and ntfy topics in the log. */
function showSettings() {
  const p = PropertiesService.getScriptProperties().getProperties();
  Logger.log('SALES key   : ' + p.SALES_KEY);
  Logger.log('DESIGN key  : ' + p.DESIGN_KEY);
  Logger.log('LEAD key    : ' + p.LEAD_KEY + '   (design lead only)');
  Logger.log('ntfy topic for SALES phones : ' + p.NTFY_SALES);
  Logger.log('ntfy topic for DESIGN phones: ' + p.NTFY_DESIGN);
  Logger.log('APP_URL (link inside alerts): ' + (p.APP_URL || '(not set — Project Settings > Script properties)'));
}

/** Sends a test push to both team topics. */
function testPush() {
  const p = PropertiesService.getScriptProperties();
  push_(p.getProperty('NTFY_SALES'), 'Test — Sales alerts', 'Sales phones are receiving design tracker alerts.', 3, ['white_check_mark']);
  push_(p.getProperty('NTFY_DESIGN'), 'Test — Design alerts', 'Design phones are receiving design tracker alerts.', 3, ['white_check_mark']);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ===================== WEB API =====================
function doGet() {
  return json_({ ok: true, data: { service: 'Regen Design Request Tracker' } });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    if (action === 'team') return json_({ ok: true, data: teamList_() });

    const user = auth_(body.auth || {});
    let data;
    switch (action) {
      case 'login':   data = user; break;
      case 'list':    data = { requests: readRequests_(), team: teamList_(), holidays: holidayList_(), now: new Date().toISOString() }; break;
      case 'create':  data = withLock_(() => createRequest_(user, body.request || {})); break;
      case 'update':  data = withLock_(() => updateRequest_(user, body.id, body.changes || {})); break;
      case 'comment': data = withLock_(() => addComment_(user, body.id, body.text)); break;
      case 'log':     data = readLog_(body.id); break;
      default: throw new Error('Unknown action');
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ===================== AUTH / TEAM =====================
function teamRows_() {
  const sh = book_().getSheetByName('Team');
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) {
    const name = String(v[i][0] || '').trim();
    if (!name) continue;
    out.push({
      name: name,
      team: String(v[i][1] || '').trim(),
      lead: /lead/i.test(String(v[i][2] || '')),
      active: !/^(no|n|false|0)$/i.test(String(v[i][3] || 'Yes').trim()),
      topic: String(v[i][4] || '').trim()
    });
  }
  return out;
}

function teamList_() {
  return teamRows_().filter(m => m.active).map(m => ({ name: m.name, team: m.team, lead: m.lead }));
}

function auth_(a) {
  const m = teamRows_().find(x => x.active && x.name.toLowerCase() === String(a.name || '').trim().toLowerCase());
  if (!m) throw new Error('Name not found in the team list');
  const p = PropertiesService.getScriptProperties();
  const key = String(a.key || '').trim().toUpperCase();
  let role;
  if (/^design$/i.test(m.team)) {
    if (m.lead && key === String(p.getProperty('LEAD_KEY')).toUpperCase()) role = 'lead';
    else if (key === String(p.getProperty('DESIGN_KEY')).toUpperCase()) role = 'designer';
  } else if (/^sales$/i.test(m.team)) {
    if (key === String(p.getProperty('SALES_KEY')).toUpperCase()) role = 'sales';
  }
  if (!role) throw new Error('Wrong team key');
  return { name: m.name, team: m.team, role: role };
}

// ===================== REQUESTS =====================
function book_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function reqSheet_() { return book_().getSheetByName('Requests'); }

/** Adds any header the Requests sheet is missing (e.g. UrgentReason) without touching existing rows. */
function ensureReqColumns_() {
  const sh = reqSheet_();
  const have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  REQ_HEADERS.forEach((h, i) => {
    if (have[i] !== h) sh.getRange(1, i + 1).setValue(h).setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff');
  });
}

/** "Holidays" tab: Date | Holiday. Created and filled with the gazetted Sri Lanka holidays the first time. */
function holidaySheet_() {
  const ss = book_();
  let sh = ss.getSheetByName('Holidays');
  if (!sh) {
    sh = ensureSheet_(ss, 'Holidays', HOLIDAY_HEADERS);
    sh.getRange(2, 1, DEFAULT_HOLIDAYS.length, 2).setValues(DEFAULT_HOLIDAYS.map(h => [h[0], h[1]]));
    sh.getRange(2, 1, DEFAULT_HOLIDAYS.length, 1).setNumberFormat('yyyy-mm-dd');
    sh.setColumnWidth(1, 110); sh.setColumnWidth(2, 320);
  }
  return sh;
}
function holidayList_() {
  const v = holidaySheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) {
    const d = v[i][0];
    let day = '';
    if (d instanceof Date) day = Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd');
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(d).trim())) day = String(d).trim();
    if (day) out.push([day, String(v[i][1] || '')]);
  }
  return out;
}
function holidayMap_() { const m = {}; holidayList_().forEach(h => { m[h[0]] = h[1]; }); return m; }
function designerCount_() { return teamRows_().filter(m => m.active && /^design$/i.test(m.team)).length; }

/** Throws if the deadline is earlier than the rules allow. excludeId: the request being edited. */
function checkDeadline_(priority, deadlineMs, excludeId) {
  const e = earliestDue_(priority, readRequests_(), designerCount_(), holidayMap_(), Date.now(), excludeId);
  if (deadlineMs < e.due - 60000) {
    throw new Error('Earliest allowed deadline for ' + priority + ' is ' + fmt_(new Date(e.due)) +
      (e.queueDays ? ' (design workload ≈ ' + e.queueDays + ' working day' + (e.queueDays > 1 ? 's' : '') + ' + ' + e.needDays + ' for ' + priority + ')'
                   : ' (' + e.needDays + ' working day' + (e.needDays > 1 ? 's' : '') + ' for ' + priority + ')'));
  }
}
function checkReason_(priority, reason) {
  if (priority === 'Very Urgent' && clean_(reason, 500).length < VERY_URGENT_REASON_MIN)
    throw new Error('Give a reason for Very Urgent (at least ' + VERY_URGENT_REASON_MIN + ' characters)');
}

function rowToObj_(r) {
  const o = {};
  REQ_HEADERS.forEach((h, i) => {
    const v = r[i];
    o[h] = v instanceof Date ? v.toISOString() : (v === null || v === undefined ? '' : v);
  });
  return o;
}

function readRequests_() {
  const v = reqSheet_().getRange(1, 1, Math.max(reqSheet_().getLastRow(), 1), REQ_HEADERS.length).getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) if (v[i][0]) out.push(rowToObj_(v[i]));
  return out;
}

function findRow_(id) {
  const sh = reqSheet_();
  const ids = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (let i = 1; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 1;
  throw new Error('Request ' + id + ' not found');
}

function nextId_() {
  const v = reqSheet_().getRange('A:A').getValues();
  let max = 0;
  v.forEach(r => { const m = String(r[0]).match(/^DR-(\d+)$/); if (m) max = Math.max(max, +m[1]); });
  return 'DR-' + String(max + 1).padStart(4, '0');
}

function parseDeadline_(s) {
  const d = new Date(s);
  if (!s || isNaN(d.getTime())) throw new Error('A valid deadline is required');
  return d;
}

function clean_(s, max) { return String(s === undefined || s === null ? '' : s).trim().slice(0, max || 500); }

function createRequest_(user, r) {
  if (user.role !== 'sales' && user.role !== 'lead') throw new Error('Only Sales or the Design Lead can add requests');
  const client = clean_(r.Client, 120);
  if (!client) throw new Error('Client / project name is required');
  const deadline = parseDeadline_(r.Deadline);
  const priority = PRIORITIES.indexOf(r.Priority) >= 0 ? r.Priority : 'Normal';
  const reason = priority === 'Very Urgent' ? clean_(r.UrgentReason, 500) : '';
  checkReason_(priority, reason);
  ensureReqColumns_();
  checkDeadline_(priority, deadline.getTime(), null);
  const now = new Date();
  const id = nextId_();
  const row = {
    ID: id, Created: now, CreatedBy: user.name, Client: client,
    Location: clean_(r.Location, 120), SystemKW: clean_(r.SystemKW, 20),
    ProjectType: clean_(r.ProjectType, 60), Deliverables: clean_(r.Deliverables, 200),
    Priority: priority, Deadline: deadline, SalesNotes: clean_(r.SalesNotes, 2000),
    AssignedTo: '', AssignedAt: '', Status: 'New', DesignNotes: '', CompletedAt: '',
    UpdatedAt: now, UpdatedBy: user.name, AlertStage: '', UrgentReason: reason
  };
  reqSheet_().appendRow(REQ_HEADERS.map(h => row[h]));
  log_(id, user.name, 'Created', priority + ' · due ' + fmt_(deadline) + (reason ? ' · reason: ' + reason : ''));

  const p = PropertiesService.getScriptProperties();
  push_(p.getProperty('NTFY_DESIGN'),
    'New design request ' + id + (TOP_PRIORITY(priority) ? ' — ' + priority.toUpperCase() : ''),
    client + (row.Deliverables ? ' · ' + row.Deliverables : '') + '\nDue ' + fmt_(deadline) + ' · from ' + user.name + (reason ? '\nReason: ' + reason : ''),
    TOP_PRIORITY(priority) ? 5 : 3, [priority === 'Very Urgent' ? 'rotating_light' : 'inbox_tray']);
  return rowToObj_(REQ_HEADERS.map(h => row[h]));
}

const SALES_FIELDS = ['Client', 'Location', 'SystemKW', 'ProjectType', 'Deliverables', 'Priority', 'Deadline', 'SalesNotes', 'UrgentReason'];

function updateRequest_(user, id, ch) {
  const sh = reqSheet_();
  const rowNo = findRow_(id);
  const cur = rowToObj_(sh.getRange(rowNo, 1, 1, REQ_HEADERS.length).getValues()[0]);
  const next = Object.assign({}, cur);
  const changes = [];
  const p = PropertiesService.getScriptProperties();
  const notes = [];

  const isSales = user.role === 'sales';
  const isLead = user.role === 'lead';
  const isAssignee = user.role === 'designer' && cur.AssignedTo === user.name;

  // --- Sales-owned fields: request details, deadline, priority
  SALES_FIELDS.forEach(f => {
    if (!(f in ch)) return;
    let val = ch[f];
    if (f === 'Deadline') {
      val = parseDeadline_(val).toISOString();
      if (val === cur.Deadline) return;
    } else if (f === 'Priority') {
      if (PRIORITIES.indexOf(val) < 0) return;
    } else val = clean_(val, f === 'SalesNotes' ? 2000 : f === 'UrgentReason' ? 500 : 200);
    if (String(val) === String(cur[f])) return;
    if (!isSales) throw new Error('Deadline, priority and request details are set by the Sales team');
    if (f === 'Client' && !val) throw new Error('Client / project name is required');
    next[f] = val;
    changes.push(f === 'Deadline' ? 'Deadline → ' + fmt_(new Date(val)) : f === 'Priority' ? 'Priority → ' + val : f === 'UrgentReason' ? 'Very Urgent reason: ' + val : f + ' updated');
  });
  if (next.Priority !== 'Very Urgent' && next.UrgentReason) next.UrgentReason = '';
  if (next.Priority !== cur.Priority || next.UrgentReason !== cur.UrgentReason) checkReason_(next.Priority, next.UrgentReason);
  // A deadline may always be kept or moved later; moving it earlier must respect the rules.
  // Lowering the priority (e.g. Very Urgent -> Normal) also re-checks the deadline against the new priority.
  const lowered = PRIORITY_ORDER.indexOf(next.Priority) > PRIORITY_ORDER.indexOf(cur.Priority);
  if (lowered || (next.Deadline !== cur.Deadline && (!cur.Deadline || new Date(next.Deadline) < new Date(cur.Deadline))))
    checkDeadline_(next.Priority, new Date(next.Deadline).getTime(), id);
  if (next.Deadline !== cur.Deadline) {
    next.AlertStage = '';
    notes.push(['design', 'Deadline changed ' + id, next.Client + '\nNew deadline ' + fmt_(new Date(next.Deadline)) + ' (by ' + user.name + ')', 4, ['calendar']]);
  }
  if (next.Priority !== cur.Priority && TOP_PRIORITY(next.Priority)) {
    notes.push(['design', id + ' is now ' + next.Priority.toUpperCase(), next.Client + ' · due ' + fmt_(new Date(next.Deadline)) + (next.UrgentReason ? '\nReason: ' + next.UrgentReason : ''), 5, ['rotating_light']]);
  }

  // --- Assignment: Design Lead only
  if ('AssignedTo' in ch && clean_(ch.AssignedTo, 80) !== cur.AssignedTo) {
    if (!isLead) throw new Error('Only the Design Lead can assign requests');
    const to = clean_(ch.AssignedTo, 80);
    if (to) {
      const m = teamRows_().find(x => x.active && x.name === to && /^design$/i.test(x.team));
      if (!m) throw new Error(to + ' is not an active Design team member');
      next.AssignedTo = to;
      next.AssignedAt = new Date().toISOString();
      if (cur.Status === 'New') next.Status = 'Assigned';
      changes.push('Assigned to ' + to);
      push_(m.topic || p.getProperty('NTFY_DESIGN'),
        (m.topic ? '' : to + ': ') + 'New job assigned — ' + id,
        next.Client + (next.Deliverables ? ' · ' + next.Deliverables : '') + '\n' + next.Priority + ' · due ' + fmt_(new Date(next.Deadline)),
        TOP_PRIORITY(next.Priority) ? 5 : 4, ['pencil2']);
    } else {
      next.AssignedTo = ''; next.AssignedAt = '';
      if (cur.Status === 'Assigned') next.Status = 'New';
      changes.push('Unassigned');
    }
  }

  // --- Status
  if ('Status' in ch && ch.Status !== next.Status) {
    const s = ch.Status;
    if (STATUSES.indexOf(s) < 0) throw new Error('Unknown status');
    const salesAllowed = ['Cancelled', 'On Hold', 'New'];
    if (!(isLead || isAssignee || (isSales && salesAllowed.indexOf(s) >= 0)))
      throw new Error(isSales ? 'Sales can only put a request On Hold or Cancel it' : 'Only the assigned designer or the Design Lead can change this status');
    next.Status = s;
    next.CompletedAt = s === 'Completed' ? new Date().toISOString() : '';
    changes.push('Status → ' + s);
    if (s === 'Completed') notes.push(['sales', 'Design ready — ' + id, next.Client + ' completed by ' + (next.AssignedTo || user.name), 4, ['tada']]);
    if (s === 'Info Needed') notes.push(['sales', 'Design needs info — ' + id, next.Client + ': ' + (clean_(ch.DesignNotes || next.DesignNotes, 200) || 'see the app'), 4, ['question']]);
    if (s === 'Review') notes.push(['lead', 'Ready for review — ' + id, next.Client + ' (' + user.name + ')', 3, ['mag']]);
    if (s === 'Cancelled' || s === 'On Hold') notes.push(['design', id + ' ' + s.toLowerCase(), next.Client + ' (by ' + user.name + ')', 3, ['pause_button']]);
  }

  // --- Design notes: lead or assigned designer
  if ('DesignNotes' in ch && clean_(ch.DesignNotes, 2000) !== cur.DesignNotes) {
    if (!(isLead || isAssignee)) throw new Error('Only the assigned designer or the Design Lead can edit design notes');
    next.DesignNotes = clean_(ch.DesignNotes, 2000);
    changes.push('Design notes updated');
  }

  if (!changes.length) return cur;
  next.UpdatedAt = new Date().toISOString();
  next.UpdatedBy = user.name;

  const toCell = (h) => {
    const v = next[h];
    if (['Created', 'Deadline', 'AssignedAt', 'CompletedAt', 'UpdatedAt'].indexOf(h) >= 0 && v) return new Date(v);
    return v;
  };
  sh.getRange(rowNo, 1, 1, REQ_HEADERS.length).setValues([REQ_HEADERS.map(toCell)]);
  log_(id, user.name, 'Updated', changes.join('; '));

  notes.forEach(n => {
    const topic = n[0] === 'sales' ? p.getProperty('NTFY_SALES') : n[0] === 'lead' ? leadTopic_() : p.getProperty('NTFY_DESIGN');
    push_(topic, n[1], n[2], n[3], n[4]);
  });
  return next;
}

function addComment_(user, id, text) {
  const t = clean_(text, 1000);
  if (!t) throw new Error('Empty comment');
  const sh = reqSheet_();
  const rowNo = findRow_(id);
  const cur = rowToObj_(sh.getRange(rowNo, 1, 1, REQ_HEADERS.length).getValues()[0]);
  log_(id, user.name, 'Comment', t);
  const p = PropertiesService.getScriptProperties();
  const toSales = user.role !== 'sales';
  push_(toSales ? p.getProperty('NTFY_SALES') : p.getProperty('NTFY_DESIGN'),
    user.name + ' on ' + id, cur.Client + ': ' + t, 3, ['speech_balloon']);
  return readLog_(id);
}

function log_(id, by, action, detail) {
  book_().getSheetByName('Log').appendRow([new Date(), id, by, action, detail]);
}

function readLog_(id) {
  const v = book_().getSheetByName('Log').getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][1]) === String(id)) out.push({ time: v[i][0] instanceof Date ? v[i][0].toISOString() : v[i][0], by: v[i][2], action: v[i][3], detail: v[i][4] });
  }
  return out.reverse();
}

function leadTopic_() {
  const lead = teamRows_().find(m => m.active && m.lead && /^design$/i.test(m.team) && m.topic);
  return lead ? lead.topic : PropertiesService.getScriptProperties().getProperty('NTFY_DESIGN');
}

// ===================== DEADLINE ALERTS (timed triggers) =====================
const STAGE_RANK = { '': 0, soon: 1, urgent: 2, overdue: 3 };

/** Hourly: pushes once when a job enters "due soon", "due within 24h" and "overdue"; overdue repeats each morning. */
function checkDeadlines() {
  const sh = reqSheet_();
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return;
  const col = REQ_HEADERS.indexOf('AlertStage') + 1;
  const p = PropertiesService.getScriptProperties();
  const team = teamRows_();
  const now = new Date();
  const today = Utilities.formatDate(now, CFG.TZ, 'yyyy-MM-dd');
  const hourNow = +Utilities.formatDate(now, CFG.TZ, 'H');

  for (let i = 1; i < v.length; i++) {
    const r = rowToObj_(v[i]);
    if (!r.ID || CLOSED.indexOf(r.Status) >= 0 || r.Status === 'On Hold' || !r.Deadline) continue;
    const hrs = (new Date(r.Deadline) - now) / 36e5;
    const stage = hrs < 0 ? 'overdue' : hrs <= CFG.URGENT_HOURS ? 'urgent' : hrs <= CFG.SOON_HOURS ? 'soon' : '';
    if (!stage) continue;

    const stored = String(r.AlertStage || '');
    const storedStage = stored.split('@')[0];
    const storedDay = stored.split('@')[1] || '';
    let send = STAGE_RANK[stage] > (STAGE_RANK[storedStage] || 0);
    if (!send && stage === 'overdue' && storedDay !== today && hourNow >= CFG.SUMMARY_HOUR) send = true; // daily overdue reminder
    if (!send) continue;

    const who = r.AssignedTo ? 'Designer: ' + r.AssignedTo : 'NOT ASSIGNED yet';
    const when = fmt_(new Date(r.Deadline));
    let title, prio, tag;
    if (stage === 'overdue') { title = 'OVERDUE ' + r.ID + ' — ' + r.Client; prio = 5; tag = 'red_circle'; }
    else if (stage === 'urgent') { title = 'Due within 24h: ' + r.ID + ' — ' + r.Client; prio = 5; tag = 'warning'; }
    else { title = 'Due within 48h: ' + r.ID + ' — ' + r.Client; prio = 4; tag = 'hourglass'; }
    const msg = 'Deadline ' + when + ' · ' + r.Priority + ' · ' + r.Status + '\n' + who + ' · Sales: ' + r.CreatedBy;

    push_(p.getProperty('NTFY_SALES'), title, msg, prio, [tag]);
    push_(p.getProperty('NTFY_DESIGN'), title, msg, prio, [tag]);
    const m = team.find(x => x.name === r.AssignedTo && x.topic);
    if (m) push_(m.topic, title, msg, prio, [tag]);

    sh.getRange(i + 1, col).setValue(stage + (stage === 'overdue' ? '@' + today : ''));
  }
}

/** Daily morning summary to both teams (only when something needs attention). */
function morningSummary() {
  const now = new Date();
  const rows = readRequests_().filter(r => CLOSED.indexOf(r.Status) < 0 && r.Status !== 'On Hold');
  let overdue = 0, d1 = 0, d2 = 0, unassigned = 0, info = 0;
  rows.forEach(r => {
    const h = (new Date(r.Deadline) - now) / 36e5;
    if (h < 0) overdue++; else if (h <= 24) d1++; else if (h <= 48) d2++;
    if (!r.AssignedTo) unassigned++;
    if (r.Status === 'Info Needed') info++;
  });
  if (!(overdue || d1 || d2 || unassigned || info)) return;
  const lines = [];
  if (overdue) lines.push('🔴 Overdue: ' + overdue);
  if (d1) lines.push('🟠 Due within 24h: ' + d1);
  if (d2) lines.push('🟡 Due within 48h: ' + d2);
  if (unassigned) lines.push('⚪ Not assigned: ' + unassigned);
  if (info) lines.push('❓ Waiting for info from Sales: ' + info);
  lines.push('Open jobs: ' + rows.length);
  const p = PropertiesService.getScriptProperties();
  const title = 'Design jobs — ' + Utilities.formatDate(now, CFG.TZ, 'EEE d MMM');
  push_(p.getProperty('NTFY_SALES'), title, lines.join('\n'), 3, ['sunrise']);
  push_(p.getProperty('NTFY_DESIGN'), title, lines.join('\n'), 3, ['sunrise']);
}

// ===================== HELPERS =====================
function push_(topic, title, message, priority, tags) {
  if (!topic) return;
  const p = PropertiesService.getScriptProperties();
  const payload = { topic: topic, title: title, message: message, priority: priority || 3, tags: tags || [] };
  const url = p.getProperty('APP_URL');
  if (url) payload.click = url;
  try {
    UrlFetchApp.fetch((p.getProperty('NTFY_SERVER') || CFG.NTFY_SERVER).replace(/\/$/, '') + '/', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
    });
  } catch (e) { console.warn('push failed: ' + e); }
}

function fmt_(d) {
  return Utilities.formatDate(d, CFG.TZ, 'EEE d MMM, h:mm a');
}
