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
   Day-based deadlines fall at 5:00 pm, counted from the day after the request.
   Very Urgent : at least 4 hours from now (reason required), pending work ignored.
   Urgent      : 1 working day from today, pending work ignored.
   High        : 2 working days from today, pending work ignored.
   Normal      : later of 3 working days from today, or 1 working day after the last pending job's deadline.
   Low         : later of 4 working days from today, or 2 working days after the last pending job's deadline. */
const DUE_RULES = {
  'Very Urgent': { hours: 4, days: 0, gap: 0, queue: false },
  'Urgent':      { days: 1, gap: 0, queue: false },
  'High':        { days: 2, gap: 0, queue: false },
  'Normal':      { days: 3, gap: 1, queue: true },
  'Low':         { days: 4, gap: 2, queue: true }
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
/** Earliest allowed deadline for a priority, given the pending design jobs.
 *  designerCount is kept for compatibility; the rules no longer use it. */
function earliestDue_(priority, requests, designerCount, hol, nowMs, excludeId) {
  const rule = DUE_RULES[priority] || DUE_RULES.Normal;
  const pending = requests.filter(r => r.ID !== excludeId && WORKLOAD_STATUSES.indexOf(r.Status) >= 0 && r.Deadline);
  let last = null;
  pending.forEach(r => { const t = new Date(r.Deadline).getTime(); if (!isNaN(t) && (!last || t > last.ms)) last = { ms: t, id: r.ID }; });
  const out = { pending: pending.length, needDays: rule.days, gap: rule.gap, hours: rule.hours || 0, queue: rule.queue,
    lastDeadline: last ? last.ms : null, lastId: last ? last.id : '', afterQueue: null, byQueue: false };
  if (rule.hours) { out.due = nowMs + rule.hours * 36e5; out.base = out.due; return out; }
  out.base = addWorkDays_(nowMs, rule.days, hol);
  out.due = out.base;
  if (rule.queue && last) {
    out.afterQueue = addWorkDays_(last.ms, rule.gap, hol);
    if (out.afterQueue > out.base) { out.due = out.afterQueue; out.byQueue = true; }
  }
  return out;
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
  ensureMgmtKey_();
  if (!teamRows_().some(m => /^management$/i.test(m.team))) team.appendRow(['Mr Champika', 'Management', 'CTO', 'Yes', '']);
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
  Logger.log('MANAGEMENT key: ' + p.MGMT_KEY + '   (view all jobs and reports, comment)');
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

const BACKEND_VERSION = '2026-11-04 deadline rules v2';

// ===================== WEB API =====================
function doGet() {
  return json_({ ok: true, data: { service: 'Regen Design Request Tracker', version: BACKEND_VERSION, notifications: pushReady_() } });
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
      case 'teamAdmin':  data = teamAdmin_(user); break;
      case 'teamAdd':    data = withLock_(() => teamAdd_(user, body.member || {})); break;
      case 'teamRemove': data = withLock_(() => teamRemove_(user, body.name)); break;
      case 'pushConfig':     data = pushConfig_(user); break;
      case 'pushRegister':   data = withLock_(() => pushRegister_(user, body.token, body.device)); break;
      case 'pushUnregister': data = withLock_(() => pushUnregister_(user, body.token)); break;
      case 'pushTest':       data = pushTest_(user); break;
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
  } else if (/^management$/i.test(m.team)) {
    if (key === ensureMgmtKey_().toUpperCase()) role = 'management';
  }
  if (!role) throw new Error('Wrong team key');
  return { name: m.name, team: m.team, role: role };
}

function ensureMgmtKey_() {
  const p = PropertiesService.getScriptProperties();
  let k = p.getProperty('MGMT_KEY');
  if (!k) { k = 'M-' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase(); p.setProperty('MGMT_KEY', k); }
  return k;
}

// ----- Team management (Design Lead only) -----
const TEAM_TYPES = ['Sales', 'Design', 'Management'];
function requireLead_(user) { if (user.role !== 'lead') throw new Error('Only the Design Head can manage the team'); }

function teamAdmin_(user) {
  requireLead_(user);
  const p = PropertiesService.getScriptProperties();
  const open = readRequests_().filter(r => WORKLOAD_STATUSES.indexOf(r.Status) >= 0);
  const devs = deviceRows_();
  return {
    pushReady: pushReady_(),
    members: teamRows_().map(m => ({ name: m.name, team: m.team, lead: m.lead, active: m.active, hasTopic: !!m.topic,
      openJobs: open.filter(r => r.AssignedTo === m.name).length,
      devices: devs.filter(d => d.name.toLowerCase() === m.name.toLowerCase()).length })),
    keys: { Sales: p.getProperty('SALES_KEY'), Design: p.getProperty('DESIGN_KEY'), Management: ensureMgmtKey_() }
  };
}

function teamAdd_(user, m) {
  requireLead_(user);
  const name = clean_(m.name, 60).replace(/\s+/g, ' ');
  const team = TEAM_TYPES.find(t => t.toLowerCase() === String(m.team || '').toLowerCase());
  if (name.length < 2) throw new Error('Enter the member\'s name');
  if (!team) throw new Error('Choose Sales, Design or Management');
  if (teamRows_().some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Error(name + ' is already in the team list');
  book_().getSheetByName('Team').appendRow([name, team, team === 'Management' ? 'Management' : 'Member', 'Yes', clean_(m.topic, 80)]);
  log_('TEAM', user.name, 'Team', 'Added ' + name + ' (' + team + ')');
  return teamAdmin_(user);
}

function teamRemove_(user, nameIn) {
  requireLead_(user);
  const sh = book_().getSheetByName('Team');
  const v = sh.getDataRange().getValues();
  const want = String(nameIn || '').trim().toLowerCase();
  let row = -1;
  for (let i = 1; i < v.length; i++) if (String(v[i][0] || '').trim().toLowerCase() === want) { row = i + 1; break; }
  if (row < 0) throw new Error('Member not found');
  const name = String(v[row - 1][0]).trim();
  if (name.toLowerCase() === user.name.toLowerCase()) throw new Error('You cannot remove yourself');
  if (/lead/i.test(String(v[row - 1][2] || ''))) throw new Error('The Design Head cannot be removed here');
  const open = readRequests_().filter(r => r.AssignedTo === name && WORKLOAD_STATUSES.indexOf(r.Status) >= 0);
  if (open.length) throw new Error(name + ' still has ' + open.length + ' open job' + (open.length > 1 ? 's' : '') + ' (' + open.map(r => r.ID).join(', ') + '). Reassign them first.');
  sh.deleteRow(row);
  log_('TEAM', user.name, 'Team', 'Removed ' + name);
  return teamAdmin_(user);
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
    throw new Error('Earliest allowed deadline for ' + priority + ' is ' + fmt_(new Date(e.due)) + ' (' + dueWhy_(priority, e) + ')');
  }
}
function dueWhy_(priority, e) {
  const wd = n => n + ' working day' + (n === 1 ? '' : 's');
  if (e.hours) return e.hours + ' hours from now';
  if (e.byQueue) return wd(e.gap) + ' after the last pending job ' + e.lastId + ', due ' + fmt_(new Date(e.lastDeadline));
  return wd(e.needDays) + ' from today' + (e.queue ? '' : ', pending jobs not counted');
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
  appPush_(['role:design'].concat(priority === 'Very Urgent' ? ['role:management'] : []),
    (priority === 'Very Urgent' ? '⚡ VERY URGENT — ' : TOP_PRIORITY(priority) ? 'URGENT — ' : 'New request — ') + client,
    id + (row.Deliverables ? ' · ' + row.Deliverables : '') + '\nDue ' + fmt_(deadline) + ' · from ' + user.name + (reason ? '\nReason: ' + reason : ''),
    { id: id, prio: TOP_PRIORITY(priority) ? 5 : 3, exclude: user.name });
  return rowToObj_(REQ_HEADERS.map(h => row[h]));
}

const SALES_FIELDS = ['Client', 'Location', 'SystemKW', 'ProjectType', 'Deliverables', 'Priority', 'Deadline', 'SalesNotes', 'UrgentReason'];

function updateRequest_(user, id, ch) {
  if (user.role === 'management') throw new Error('Management can view and comment only');
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
      appPush_([to], 'New job for you — ' + next.Client,
        id + ' · ' + next.Priority + ' · due ' + fmt_(new Date(next.Deadline)) + (next.Deliverables ? '\n' + next.Deliverables : ''),
        { id: id, prio: TOP_PRIORITY(next.Priority) ? 5 : 4, exclude: user.name });
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
    const who = n[0] === 'sales' ? [next.CreatedBy] : n[0] === 'lead' ? ['role:lead'] : (next.AssignedTo ? [next.AssignedTo, 'role:lead'] : ['role:design']);
    appPush_(who, n[1], n[2], { id: id, prio: n[3], exclude: user.name });
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
  const topics = user.role === 'management' ? [p.getProperty('NTFY_SALES'), p.getProperty('NTFY_DESIGN')]
               : [user.role === 'sales' ? p.getProperty('NTFY_DESIGN') : p.getProperty('NTFY_SALES')];
  topics.forEach(tp => push_(tp, user.name + ' on ' + id, cur.Client + ': ' + t, user.role === 'management' ? 4 : 3, ['speech_balloon']));
  const designSide = cur.AssignedTo ? [cur.AssignedTo, 'role:lead'] : ['role:lead'];
  const who = user.role === 'management' ? [cur.CreatedBy].concat(designSide)
            : user.role === 'sales' ? designSide
            : [cur.CreatedBy].concat(user.role === 'designer' ? ['role:lead'] : []);
  appPush_(who, '💬 ' + user.name + ' — ' + cur.Client, id + ': ' + t, { id: id, prio: user.role === 'management' ? 4 : 3, exclude: user.name, tag: 'c-' + id });
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
    appPush_([r.CreatedBy, 'role:lead'].concat(r.AssignedTo ? [r.AssignedTo] : []),
      (stage === 'overdue' ? '🔴 ' : stage === 'urgent' ? '🟠 ' : '🟡 ') + title, msg, { id: r.ID, prio: prio, tag: 'd-' + r.ID });

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
  appPush_(['role:all'], '☀ ' + title, lines.join('\n'), { prio: 3, tag: 'summary' });
}

// ===================== APP NOTIFICATIONS (Firebase Cloud Messaging) =====================
// Script properties (Project Settings > Script properties):
//   FCM_CONFIG           the firebaseConfig object from Firebase (apiKey, projectId, messagingSenderId, appId)
//   FCM_VAPID            Cloud Messaging > Web Push certificates > Key pair (public key)
//   FCM_SERVICE_ACCOUNT  the whole JSON file from Service accounts > Generate new private key
const DEVICE_HEADERS = ['Name', 'Token', 'Updated', 'Device'];
const MAX_DEVICES_PER_PERSON = 6;

function pushReady_() {
  const p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('FCM_CONFIG') && p.getProperty('FCM_VAPID') && p.getProperty('FCM_SERVICE_ACCOUNT'));
}
function fcmWebConfig_() {
  const raw = String(PropertiesService.getScriptProperties().getProperty('FCM_CONFIG') || '');
  let o = {};
  try { o = JSON.parse(raw); } catch (e) { raw.replace(/(\w+)\s*:\s*["']([^"']+)["']/g, (m, k, v) => { o[k] = v; return m; }); }
  return { apiKey: o.apiKey, authDomain: o.authDomain, projectId: o.projectId, messagingSenderId: o.messagingSenderId, appId: o.appId };
}
function deviceSheet_() {
  const ss = book_();
  return ss.getSheetByName('Devices') || ensureSheet_(ss, 'Devices', DEVICE_HEADERS);
}
function deviceRows_() {
  const sh = book_().getSheetByName('Devices');
  if (!sh) return [];
  const v = sh.getDataRange().getValues(), out = [];
  for (let i = 1; i < v.length; i++) if (v[i][1]) out.push({ row: i + 1, name: String(v[i][0] || '').trim(), token: String(v[i][1]), updated: v[i][2], device: String(v[i][3] || '') });
  return out;
}
function pushConfig_(user) {
  const ready = pushReady_();
  return { ready: ready, config: ready ? fcmWebConfig_() : null,
    vapid: ready ? String(PropertiesService.getScriptProperties().getProperty('FCM_VAPID')).trim() : null,
    devices: deviceRows_().filter(d => d.name.toLowerCase() === user.name.toLowerCase()).length };
}
function pushRegister_(user, token, device) {
  token = String(token || '').trim();
  if (token.length < 20 || token.length > 4096) throw new Error('Invalid notification token');
  const sh = deviceSheet_(), rows = deviceRows_(), now = new Date(), dev = clean_(device, 120);
  const hit = rows.find(d => d.token === token);
  if (hit) sh.getRange(hit.row, 1, 1, 4).setValues([[user.name, token, now, dev]]);
  else sh.appendRow([user.name, token, now, dev]);
  // keep only the newest few devices per person
  const mine = deviceRows_().filter(d => d.name.toLowerCase() === user.name.toLowerCase())
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));
  mine.slice(MAX_DEVICES_PER_PERSON).map(d => d.row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  return pushConfig_(user);
}
function pushUnregister_(user, token) {
  removeTokens_([String(token || '')]);
  return pushConfig_(user);
}
function pushTest_(user) {
  if (!pushReady_()) throw new Error('Notifications are not set up on the server yet');
  const sent = appPush_([user.name], 'Test notification ✅', 'Design Requests notifications are working on this phone.', { prio: 4, tag: 'test' });
  if (!sent) throw new Error('No device received it — turn notifications on again on this phone');
  return { sent: sent };
}
function removeTokens_(tokens) {
  const sh = book_().getSheetByName('Devices');
  if (!sh || !tokens.length) return;
  deviceRows_().filter(d => tokens.indexOf(d.token) >= 0).map(d => d.row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}
/** who: names and/or 'role:sales' | 'role:design' (Design Head + designers) | 'role:lead' | 'role:management' | 'role:all' */
function targetNames_(who, exclude) {
  const team = teamRows_().filter(m => m.active), out = {};
  (who || []).forEach(w => {
    if (!w) return;
    const s = String(w);
    if (s.indexOf('role:') === 0) {
      const r = s.slice(5);
      team.forEach(m => {
        const t = m.team.toLowerCase();
        if (r === 'all' || (r === 'sales' && t === 'sales') || (r === 'management' && t === 'management') ||
            (r === 'design' && t === 'design') || (r === 'lead' && t === 'design' && m.lead)) out[m.name.toLowerCase()] = 1;
      });
    } else if (team.some(m => m.name.toLowerCase() === s.toLowerCase())) out[s.toLowerCase()] = 1;
  });
  if (exclude) delete out[String(exclude).toLowerCase()];
  return Object.keys(out);
}
/** Sends a phone notification from the app to the given people. Never throws; returns how many devices accepted it. */
function appPush_(who, title, body, o) {
  o = o || {};
  try {
    if (!pushReady_()) return 0;
    const names = targetNames_(who, o.exclude);
    if (!names.length) return 0;
    const devs = deviceRows_().filter(d => names.indexOf(d.name.toLowerCase()) >= 0);
    if (!devs.length) return 0;
    return fcmSend_(devs, { title: title, body: body, id: o.id || '', prio: o.prio || 3, tag: o.tag || (o.id || '') });
  } catch (e) { console.warn('app push failed: ' + e); return 0; }
}
function appLink_(id) {
  const base = String(PropertiesService.getScriptProperties().getProperty('APP_URL') || './').trim() || './';
  return base + (id ? '#job=' + encodeURIComponent(id) : '');
}
function fcmSend_(devs, d) {
  const sa = JSON.parse(PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT'));
  const at = fcmAccessToken_(sa);
  const url = 'https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send';
  const data = { title: String(d.title).slice(0, 140), body: String(d.body).slice(0, 600), url: appLink_(d.id), tag: String(d.tag || ''), prio: String(d.prio || 3), id: String(d.id || '') };
  const res = UrlFetchApp.fetchAll(devs.map(dev => ({
    url: url, method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + at },
    payload: JSON.stringify({ message: { token: dev.token, data: data, webpush: { headers: { Urgency: 'high', TTL: '172800' } } } })
  })));
  let ok = 0; const dead = [];
  res.forEach((r, i) => {
    const code = r.getResponseCode(), txt = r.getContentText();
    if (code === 200) ok++;
    else if (code === 404 || /UNREGISTERED|not a valid FCM registration token|registration-token-not-registered/i.test(txt)) dead.push(devs[i].token);
    else console.warn('FCM ' + code + ': ' + txt.slice(0, 300));
  });
  if (dead.length) removeTokens_(dead);
  return ok;
}
function fcmAccessToken_(sa) {
  const cache = CacheService.getScriptCache(), key = 'fcm_at_' + sa.client_email;
  const hit = cache.get(key);
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(Utilities.newBlob(JSON.stringify(o)).getBytes()).replace(/=+$/, '');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, sa.private_key)).replace(/=+$/, '');
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig } });
  if (r.getResponseCode() !== 200) throw new Error('Google sign-in for notifications failed: ' + r.getContentText().slice(0, 200));
  const token = JSON.parse(r.getContentText()).access_token;
  cache.put(key, token, 3300);
  return token;
}
/** Run from the editor: shows whether app notifications are set up and who has them on. */
function pushStatus() {
  Logger.log('App notifications set up: ' + (pushReady_() ? 'YES' : 'NO — add FCM_CONFIG, FCM_VAPID and FCM_SERVICE_ACCOUNT in Script properties'));
  if (pushReady_()) { const sa = JSON.parse(PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT')); Logger.log('Firebase project: ' + sa.project_id); fcmAccessToken_(sa); Logger.log('Google sign-in for notifications: OK'); }
  const devs = deviceRows_();
  Logger.log('Phones registered: ' + devs.length);
  devs.forEach(d => Logger.log(' - ' + d.name + ' · ' + d.device));
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
