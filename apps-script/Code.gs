/**
 * DLTA Dialer API (multi-user).
 *
 * A standalone Google Apps Script web app. It is the only thing the dialer
 * talks to: logins, reading leads, claiming, saving and assigning.
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * First time only: run setup() once from the editor (it adds the 4 ownership
 * columns after the existing ones and creates the "agents" tab).
 */

var SHEET_ID = '1MlrW2RAdykKJFBbiIeNBlCwct7oepW_mrybhS3U1Wqw';
var LEAD_TABS = ['dlta-leads-formatted', 'remine-leads'];
var AGENTS_TAB = 'agents';
var OWNER_COLS = ['assigned_to', 'assigned_at', 'last_called_by', 'last_called_at'];
var AGENT_HEADERS = ['agent_id', 'display_name', 'pin_hash', 'role', 'active'];
var SEED_AGENTS = [
  [1, 'George', '', 'admin', true],
  [2, 'Tom', '', 'agent', true],
  [3, 'Yaser', '', 'agent', true],
  [4, 'Guero', '', 'admin', true]
];
// Fields the dialer is allowed to write. Anything else in "updates" is ignored.
var WRITABLE = ['notes', 'call_status', 'lead_status', 'follow_up_date', 'next_action',
  'best_phone_number', 'text_sent', 'text_sent_timestamp'];
var APPT_TAB = 'appointments';
var APPT_HEADERS = ['appt_id', 'agent', 'sheet', 'lead_row', 'lead_id', 'lead_name', 'type', 'title',
  'start', 'end', 'notes', 'created_at'];
// Missed follow-ups go back to the pool after this many days with no call.
var FOLLOWUP_GRACE_DAYS = 3;
// Claimed but never called: back to the pool after this many days.
var CLAIM_IDLE_DAYS = 7;
// ───── Drip: claim a lead and this sequence runs on its own ─────
var DRIP_COLS = ['drip_start', 'drip_step', 'drip_next', 'drip_status'];
// day = days after the claim. text steps wait in the agent's send queue;
// call steps put the lead in Due; mail steps add it to the postcard list.
var DRIP_STEPS = [
  { day: 0, ch: 'text', msg: 'intro' },
  { day: 2, ch: 'call' },
  { day: 4, ch: 'text', msg: 'guide' },
  { day: 7, ch: 'mail' },
  { day: 10, ch: 'text', msg: 'calls' },
  { day: 14, ch: 'call' },
  { day: 21, ch: 'text', msg: 'options' },
  { day: 30, ch: 'mail' },
  { day: 45, ch: 'text', msg: 'checkin' }
];
// Short, one bubble each. Wording rotates so texts are not identical.
var DRIP_TEXTS = {
  intro: [
    'Hi, this is {agent} with Delta Realty. I saw a court filing on {address}. I help homeowners understand their options. Open to a quick call?',
    'Hi, {agent} here with Delta Realty, a local brokerage. Reaching out about {address}. If you are weighing options, I can help. Call or text anytime.',
    'Hi, this is {agent} at Delta Realty. I help local homeowners after a foreclosure filing. Happy to answer any questions about {address}.'
  ],
  guide: [
    '{agent} from Delta Realty. Here is a 1-page guide to what this filing means for {address} and your options: {image}',
    'Quick guide for {address}: what the filing means, your timeline and options. Questions? Text me. {agent} {image}'
  ],
  calls: [
    'You are probably getting a lot of calls about {address}. If anyone can help you keep the home or sell on your terms, it is us. {agent}, Delta Realty',
    'I know the calls and letters pile up. No pressure from me on {address}, just straight answers when you want them. {agent}, Delta Realty'
  ],
  options: [
    'Options for {address} can include catching up, a loan change, a sale, or legal help. I can point you to the right one. {agent}, Delta Realty',
    'Not sure where to start on {address}? Step one is knowing your numbers and timeline. I can help with both. {agent}, Delta Realty'
  ],
  checkin: [
    'Checking in on {address}. Still here if you need help or a referral. Reply STOP and I will not text again. {agent}, Delta Realty',
    'Hi, {agent} with Delta Realty again. Anything changed with {address}? Happy to help whenever you are ready. Reply STOP to opt out.'
  ]
};
var DRIP_IMAGES = {
  LP: 'https://app.dltaleads.com/assets/sms/lis_pendens_infographic.png',
  NOS: 'https://app.dltaleads.com/assets/sms/lis_pendens_vs_notice_of_sale.png'
};
// Statuses that end the drip.
var DRIP_STOP = ['appointment', 'notinterested', 'dnc', 'listed', 'referred'];
var MAILERS_TAB = 'mailers';
var MAILER_HEADERS = ['added_at', 'agent', 'sheet', 'lead_row', 'lead_id', 'owner_name', 'address_street',
  'address_city', 'address_state', 'address_zip', 'drip_step', 'mailed'];
var TOKEN_HOURS = 12;
var MAX_BAD_PINS = 5;
var LOCKOUT_SECONDS = 15 * 60;

// ───────────────────────── one-time setup ─────────────────────────

function setup() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  LEAD_TABS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var lastCol = sh.getLastColumn();
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var col = lastCol;
    OWNER_COLS.concat(DRIP_COLS).forEach(function (h) {
      if (headers.indexOf(h) === -1) {
        col++;
        sh.getRange(1, col).setValue(h);
      }
    });
  });
  if (!ss.getSheetByName(AGENTS_TAB)) {
    var a = ss.insertSheet(AGENTS_TAB);
    a.appendRow(AGENT_HEADERS);
    SEED_AGENTS.forEach(function (r) { a.appendRow(r); });
  }
  // Leads claimed before the drip existed get their drip started now.
  LEAD_TABS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var values = sh.getDataRange().getValues();
    var col = {};
    values[0].map(String).forEach(function (h, i) { col[h] = i + 1; });
    if (!col.drip_status || !col.assigned_to) return;
    for (var i = 1; i < values.length; i++) {
      var st = String(values[i][col.lead_status - 1] || '').toLowerCase();
      if (String(values[i][col.assigned_to - 1] || '').trim() && !String(values[i][col.drip_status - 1] || '') &&
          DRIP_STOP.indexOf(st) === -1) dripStart_(sh, i + 1, col);
    }
  });
  if (!ss.getSheetByName(MAILERS_TAB)) {
    ss.insertSheet(MAILERS_TAB).appendRow(MAILER_HEADERS);
  }
  if (!ss.getSheetByName(APPT_TAB)) {
    ss.insertSheet(APPT_TAB).appendRow(APPT_HEADERS);
  }
  // Daily sweep that returns missed follow-ups to the pool (6am).
  var hasSweep = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'sweepOverdue';
  });
  if (!hasSweep) ScriptApp.newTrigger('sweepOverdue').timeBased().everyDays(1).atHour(6).create();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN_SECRET')) {
    props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  return 'setup done';
}

// Admin helper: run from the editor to let someone pick a new PIN on next login.
function resetPin(displayName) {
  var a = agentsSheet_();
  var rows = a.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim().toLowerCase() === String(displayName).trim().toLowerCase()) {
      a.getRange(i + 1, 3).setValue('');
      return 'PIN cleared for ' + rows[i][1];
    }
  }
  return 'not found';
}

// ───────────────────────── web entry points ─────────────────────────

function doGet() {
  return json_({ ok: true, service: 'dlta-dialer-api' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 400, error: 'bad_json' });
  }
  try {
    return json_(route_(req));
  } catch (err) {
    return json_({ ok: false, code: 500, error: String(err && err.message || err) });
  }
}

function route_(req) {
  var action = req.action;
  if (action === 'agents') return listAgents_();
  if (action === 'login') return login_(req);

  var user = verifyToken_(req.token);
  if (!user) return { ok: false, code: 401, error: 'login_required' };

  if (action === 'leads') return readLeads_(user, req);
  if (action === 'claim') return withLock_(function () { return claim_(user, req); });
  if (action === 'save') return withLock_(function () { return save_(user, req); });
  if (action === 'dripQueue') return withLock_(function () { return dripQueue_(user, req); });
  if (action === 'dripSent') return withLock_(function () { return dripMark_(user, req, true); });
  if (action === 'dripSkip') return withLock_(function () { return dripMark_(user, req, false); });
  if (action === 'appts') return listAppts_(user);
  if (action === 'addAppt') return withLock_(function () { return addAppt_(user, req); });
  if (action === 'deleteAppt') return withLock_(function () { return deleteAppt_(user, req); });
  if (action === 'assign') {
    if (user.r !== 'admin') return { ok: false, code: 403, error: 'admin_only' };
    return withLock_(function () { return assign_(req); });
  }
  return { ok: false, code: 400, error: 'unknown_action' };
}

// ───────────────────────── auth ─────────────────────────

function agentsSheet_() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(AGENTS_TAB);
}

function isActive_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function listAgents_() {
  var rows = agentsSheet_().getDataRange().getValues();
  var names = [];
  for (var i = 1; i < rows.length; i++) {
    if (isActive_(rows[i][4]) && String(rows[i][1]).trim()) names.push(String(rows[i][1]).trim());
  }
  return { ok: true, agents: names };
}

function login_(req) {
  var name = String(req.name || '').trim();
  var pin = String(req.pin || '').trim();
  if (!/^\d{4}$/.test(pin)) return { ok: false, code: 400, error: 'pin_must_be_4_digits' };

  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + name.toLowerCase();
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_BAD_PINS) return { ok: false, code: 429, error: 'locked_try_later' };

  var a = agentsSheet_();
  var rows = a.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim().toLowerCase() !== name.toLowerCase()) continue;
    if (!isActive_(rows[i][4])) break;
    var stored = String(rows[i][2] || '').trim();
    var role = String(rows[i][3] || 'agent').trim().toLowerCase() === 'admin' ? 'admin' : 'agent';
    var display = String(rows[i][1]).trim();
    var firstTime = false;
    if (!stored) {
      // First login: the PIN they type becomes their PIN.
      var salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      a.getRange(i + 1, 3).setValue(salt + ':' + sha256Hex_(salt + pin));
      firstTime = true;
    } else {
      var parts = stored.split(':');
      if (parts.length !== 2 || sha256Hex_(parts[0] + pin) !== parts[1]) {
        cache.put(failKey, String(fails + 1), LOCKOUT_SECONDS);
        return { ok: false, code: 401, error: 'wrong_pin' };
      }
    }
    cache.remove(failKey);
    return { ok: true, token: makeToken_(display, role), name: display, role: role, firstTime: firstTime };
  }
  cache.put(failKey, String(fails + 1), LOCKOUT_SECONDS);
  return { ok: false, code: 401, error: 'wrong_pin' };
}

function secret_() {
  var s = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!s) throw new Error('Run setup() first');
  return s;
}

function makeToken_(name, role) {
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    n: name, r: role, e: Date.now() + TOKEN_HOURS * 3600 * 1000
  }));
  return payload + '.' + sign_(payload);
}

function verifyToken_(token) {
  if (!token || String(token).indexOf('.') === -1) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) return null;
  var p;
  try {
    p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) { return null; }
  if (!p || !p.n || Date.now() > p.e) return null;
  return p;
}

function sign_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, secret_()));
}

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ───────────────────────── leads ─────────────────────────

function leadSheet_(name) {
  if (LEAD_TABS.indexOf(name) === -1) throw new Error('unknown_sheet');
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('missing_sheet');
  return sh;
}

function readLeads_(user, req) {
  var sh = leadSheet_(req.sheet);
  var values = sh.getDataRange().getDisplayValues();
  if (!values.length) return { ok: true, headers: [], rows: [] };
  var headers = values[0];
  var ownerIdx = headers.indexOf('assigned_to');
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var owner = ownerIdx === -1 ? '' : String(values[i][ownerIdx] || '').trim();
    // Agents see their own leads and the open pool. Never someone else's.
    if (user.r !== 'admin' && owner && owner !== user.n) continue;
    out.push({ n: i + 1, v: values[i] });
  }
  return { ok: true, headers: headers, rows: out };
}

// Reads one row and checks it is still the lead the client thinks it is.
function getRow_(sh, req) {
  var row = Number(req.row);
  if (!row || row < 2 || row > sh.getLastRow()) return { err: { ok: false, code: 404, error: 'no_such_row' } };
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var vals = sh.getRange(row, 1, 1, lastCol).getValues()[0];
  var idIdx = headers.indexOf('lead_id');
  if (req.lead_id && idIdx !== -1 && String(vals[idIdx]) !== String(req.lead_id)) {
    return { err: { ok: false, code: 409, error: 'row_moved_reload' } };
  }
  var col = {};
  headers.forEach(function (h, i) { col[h] = i + 1; });
  OWNER_COLS.forEach(function (h) {
    if (!col[h]) throw new Error('Run setup() first: missing column ' + h);
  });
  return { row: row, headers: headers, vals: vals, col: col, owner: String(vals[col.assigned_to - 1] || '').trim() };
}

function claim_(user, req) {
  var sh = leadSheet_(req.sheet);
  var r = getRow_(sh, req);
  if (r.err) return r.err;
  if (r.owner && r.owner !== user.n) return { ok: false, code: 409, error: 'already_owned', owner: r.owner };
  if (!r.owner) {
    sh.getRange(r.row, r.col.assigned_to).setValue(user.n);
    sh.getRange(r.row, r.col.assigned_at).setValue(new Date().toISOString());
    dripStart_(sh, r.row, r.col);
  }
  return { ok: true, assigned_to: user.n };
}

function save_(user, req) {
  var sh = leadSheet_(req.sheet);
  var r = getRow_(sh, req);
  if (r.err) return r.err;
  if (r.owner && r.owner !== user.n && user.r !== 'admin') {
    return { ok: false, code: 403, error: 'owned_by_someone_else', owner: r.owner };
  }
  var now = new Date().toISOString();
  var owner = r.owner;
  if (!owner) {
    // Working a pool lead claims it, so nobody else can step on it.
    owner = user.n;
    sh.getRange(r.row, r.col.assigned_to).setValue(owner);
    sh.getRange(r.row, r.col.assigned_at).setValue(now);
    dripStart_(sh, r.row, r.col);
  }
  var updates = req.updates || {};
  Object.keys(updates).forEach(function (k) {
    if (WRITABLE.indexOf(k) !== -1 && r.col[k]) sh.getRange(r.row, r.col[k]).setValue(updates[k]);
  });
  var st = String(updates.lead_status || '').toLowerCase();
  if (st && DRIP_STOP.indexOf(st) !== -1) dripStop_(sh, r.row, r.col);
  sh.getRange(r.row, r.col.last_called_by).setValue(user.n);
  sh.getRange(r.row, r.col.last_called_at).setValue(now);
  return { ok: true, assigned_to: owner };
}

function assign_(req) {
  var sh = leadSheet_(req.sheet);
  var r = getRow_(sh, req);
  if (r.err) return r.err;
  var to = String(req.to || '').trim();
  if (to && listAgents_().agents.indexOf(to) === -1) return { ok: false, code: 400, error: 'unknown_agent' };
  sh.getRange(r.row, r.col.assigned_to).setValue(to);
  sh.getRange(r.row, r.col.assigned_at).setValue(to ? new Date().toISOString() : '');
  if (to && to !== r.owner) dripStart_(sh, r.row, r.col);
  if (!to) dripStop_(sh, r.row, r.col);
  return { ok: true, assigned_to: to };
}

// ───────────────────────── drip ─────────────────────────

function isoDay_(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function addDays_(d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }

// col is 1-based (getRow_ style). Silently does nothing until setup() adds the drip columns.
function dripStart_(sh, row, col) {
  if (!col.drip_status) return;
  var now = new Date();
  sh.getRange(row, col.drip_start).setValue(now.toISOString());
  sh.getRange(row, col.drip_step).setValue(0);
  sh.getRange(row, col.drip_next).setValue(isoDay_(now));
  sh.getRange(row, col.drip_status).setValue('active');
}
function dripStop_(sh, row, col) {
  if (!col.drip_status) return;
  if (String(sh.getRange(row, col.drip_status).getValues()[0][0]) === 'active') {
    sh.getRange(row, col.drip_status).setValue('stopped');
  }
}

function fill_(tpl, v) {
  return tpl.replace(/\{(\w+)\}/g, function (m, k) { return v[k] !== undefined ? v[k] : ''; }).replace(/\s+/g, ' ').trim();
}

// Moves a lead past call and mail steps that are due, so only text steps wait.
// vals/c are 0-based (getValues row + header index map). Returns the current step or null.
function dripCatchUp_(sh, row, vals, c, agent, sheetName, today) {
  var guard = 0;
  while (guard++ < DRIP_STEPS.length) {
    var stepIdx = Number(vals[c.drip_step]);
    var step = DRIP_STEPS[stepIdx];
    var next = toDate_(vals[c.drip_next]);
    if (!step) { sh.getRange(row, c.drip_status + 1).setValue('done'); vals[c.drip_status] = 'done'; return null; }
    if (!next || next > today) return null;
    if (step.ch === 'text') return step;
    if (step.ch === 'call') {
      var fu = isoDay_(next);
      var cur = c.follow_up_date !== undefined ? toDate_(vals[c.follow_up_date]) : null;
      // Never push back a sooner follow-up the agent already set.
      if (c.follow_up_date !== undefined && (!cur || cur > next || cur < today)) {
        sh.getRange(row, c.follow_up_date + 1).setValue(fu); vals[c.follow_up_date] = fu;
      }
      dripNote_(sh, row, vals, c, 'drip', 'Drip: call day ' + fu);
    } else if (step.ch === 'mail') {
      var m = SpreadsheetApp.openById(SHEET_ID).getSheetByName(MAILERS_TAB);
      if (m) m.appendRow([new Date().toISOString(), agent, sheetName, row, vals[c.lead_id] || '', vals[c.owner_name] || '',
        vals[c.address_street] || vals[c.address_full] || '', vals[c.address_city] || '', vals[c.address_state] || '',
        vals[c.address_zip] || '', stepIdx, '']);
      dripNote_(sh, row, vals, c, 'drip', 'Drip: added to postcard list');
    }
    dripAdvance_(sh, row, vals, c, stepIdx);
  }
  return null;
}

function dripAdvance_(sh, row, vals, c, stepIdx) {
  var nextIdx = stepIdx + 1;
  sh.getRange(row, c.drip_step + 1).setValue(nextIdx);
  vals[c.drip_step] = nextIdx;
  if (nextIdx >= DRIP_STEPS.length) {
    sh.getRange(row, c.drip_status + 1).setValue('done');
    vals[c.drip_status] = 'done';
    return;
  }
  var start = toDate_(vals[c.drip_start]) || new Date();
  var due = addDays_(start, DRIP_STEPS[nextIdx].day);
  var today = addDays_(new Date(), 0);
  if (due < today) due = today;
  sh.getRange(row, c.drip_next + 1).setValue(isoDay_(due));
  vals[c.drip_next] = isoDay_(due);
}

function dripNote_(sh, row, vals, c, type, text) {
  if (c.notes === undefined) return;
  var entry = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy') + '|' + type + '|' + text;
  var notes = String(vals[c.notes] || '');
  notes = notes ? notes + '|||' + entry : entry;
  sh.getRange(row, c.notes + 1).setValue(notes);
  vals[c.notes] = notes;
}

function bestPhone_(vals, c) {
  var p = String(vals[c.best_phone_number] || '').replace(/\D/g, '');
  if (p.length >= 10) return p;
  for (var j = 1; j <= 5; j++) {
    p = String(vals[c['phone_' + j]] || '').replace(/\.0$/, '').replace(/\D/g, '');
    if (p.length >= 10) return p;
  }
  return '';
}

// The agent's texts due today (admin can pass agent to see someone else's).
function dripQueue_(user, req) {
  var agent = user.r === 'admin' && req.agent ? String(req.agent) : user.n;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var today = addDays_(new Date(), 0);
  var items = [];
  LEAD_TABS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var values = sh.getDataRange().getValues();
    var c = {};
    values[0].map(String).forEach(function (h, i) { c[h] = i; });
    if (c.drip_status === undefined) return;
    for (var i = 1; i < values.length; i++) {
      var v = values[i];
      if (String(v[c.assigned_to] || '').trim() !== agent) continue;
      if (String(v[c.drip_status]) !== 'active') continue;
      var step = dripCatchUp_(sh, i + 1, v, c, agent, name, today);
      if (!step) continue;
      var phone = bestPhone_(v, c);
      if (!phone) continue;
      var variants = DRIP_TEXTS[step.msg] || [''];
      var type = String(v[c.lead_type] || '').toUpperCase() === 'NOS' ? 'NOS' : 'LP';
      var text = fill_(variants[(i + Number(v[c.drip_step])) % variants.length], {
        agent: agent, address: String(v[c.address_street] || v[c.address_full] || 'your property'),
        image: DRIP_IMAGES[type]
      });
      items.push({ sheet: name, row: i + 1, lead_id: v[c.lead_id] || '', name: v[c.owner_name] || '',
        address: v[c.address_street] || v[c.address_full] || '', phone: phone, step: Number(v[c.drip_step]),
        msg: step.msg, text: text });
    }
  });
  return { ok: true, agent: agent, items: items };
}

// Marks a queued text as sent (or skipped) and moves the lead to its next step.
function dripMark_(user, req, sent) {
  var sh = leadSheet_(req.sheet);
  var r = getRow_(sh, req);
  if (r.err) return r.err;
  if (r.owner !== user.n && user.r !== 'admin') return { ok: false, code: 403, error: 'owned_by_someone_else', owner: r.owner };
  if (!r.col.drip_status) return { ok: false, code: 400, error: 'run_setup' };
  var c = {};
  Object.keys(r.col).forEach(function (k) { c[k] = r.col[k] - 1; });
  var vals = r.vals;
  if (String(vals[c.drip_status]) !== 'active' || Number(vals[c.drip_step]) !== Number(req.step)) {
    return { ok: false, code: 409, error: 'step_already_handled' };
  }
  var now = new Date().toISOString();
  if (sent) {
    if (c.text_sent !== undefined) sh.getRange(r.row, c.text_sent + 1).setValue('TRUE');
    if (c.text_sent_timestamp !== undefined) sh.getRange(r.row, c.text_sent_timestamp + 1).setValue(now.slice(0, 10));
    dripNote_(sh, r.row, vals, c, 'text', 'Drip text sent: ' + String(req.text || '').slice(0, 300));
  } else {
    dripNote_(sh, r.row, vals, c, 'drip', 'Drip text skipped');
  }
  dripAdvance_(sh, r.row, vals, c, Number(vals[c.drip_step]));
  return { ok: true, next: vals[c.drip_next] || '', status: vals[c.drip_status] };
}

// ───────────────────────── appointments ─────────────────────────

function apptSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(APPT_TAB);
  if (!sh) { sh = ss.insertSheet(APPT_TAB); sh.appendRow(APPT_HEADERS); }
  return sh;
}

function listAppts_(user) {
  var rows = apptSheet_().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    if (user.r !== 'admin' && String(r[1]) !== user.n) continue;
    var o = {};
    APPT_HEADERS.forEach(function (h, j) {
      var v = r[j];
      o[h] = v instanceof Date ? v.toISOString() : v;
    });
    out.push(o);
  }
  return { ok: true, appts: out };
}

function addAppt_(user, req) {
  var a = req.appt || {};
  if (!a.start || !a.title) return { ok: false, code: 400, error: 'start_and_title_required' };
  var id = Utilities.getUuid();
  apptSheet_().appendRow([id, user.n, a.sheet || '', a.lead_row || '', a.lead_id || '', a.lead_name || '',
    a.type || 'appointment', a.title, a.start, a.end || '', a.notes || '', new Date().toISOString()]);
  return { ok: true, appt_id: id };
}

function deleteAppt_(user, req) {
  var sh = apptSheet_();
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(req.appt_id)) continue;
    if (user.r !== 'admin' && String(rows[i][1]) !== user.n) return { ok: false, code: 403, error: 'not_yours' };
    sh.deleteRow(i + 1);
    return { ok: true };
  }
  return { ok: false, code: 404, error: 'not_found' };
}

// ───────────────────────── missed follow-up sweep ─────────────────────────

function toDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v || '').trim();
  if (!s) return null;
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return new Date(+m[1], m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return new Date(+m[3], m[1] - 1, +m[2]);
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Runs daily from the trigger setup() installs. Safe to run by hand too.
// Returns leads to the pool when the owner let them go cold, and logs why.
function sweepOverdue(nowOverride) {
  var now = nowOverride ? new Date(nowOverride) : new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var dueCutoff = new Date(today.getTime() - FOLLOWUP_GRACE_DAYS * 86400000);
  var idleCutoff = new Date(now.getTime() - CLAIM_IDLE_DAYS * 86400000);
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var returned = [];
  LEAD_TABS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var values = sh.getDataRange().getValues();
    var h = values[0].map(String);
    var c = {};
    h.forEach(function (x, i) { c[x] = i; });
    if (c.assigned_to === undefined) return;
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var owner = String(row[c.assigned_to] || '').trim();
      if (!owner) continue;
      var status = String(row[c.lead_status] || '').toLowerCase();
      if (status === 'listed' || status === 'dnc') continue;
      var fu = toDate_(row[c.follow_up_date]);
      var lastCall = toDate_(row[c.last_called_at]);
      var claimed = toDate_(row[c.assigned_at]);
      var reason = '';
      if (fu && fu < dueCutoff && (!lastCall || lastCall < fu)) {
        reason = 'follow-up missed (was due ' + Utilities.formatDate(fu, Session.getScriptTimeZone(), 'M/d/yyyy') + ')';
      } else if (!lastCall && claimed && claimed < idleCutoff) {
        reason = 'claimed ' + CLAIM_IDLE_DAYS + '+ days with no call';
      }
      if (!reason) continue;
      var r = i + 1;
      sh.getRange(r, c.assigned_to + 1).setValue('');
      sh.getRange(r, c.assigned_at + 1).setValue('');
      if (c.drip_status !== undefined) sh.getRange(r, c.drip_status + 1).setValue('stopped');
      if (c.notes !== undefined) {
        var entry = Utilities.formatDate(now, Session.getScriptTimeZone(), 'M/d/yyyy') +
          '|returned|Back to pool from ' + owner + ': ' + reason;
        var notes = String(row[c.notes] || '');
        sh.getRange(r, c.notes + 1).setValue(notes ? notes + '|||' + entry : entry);
      }
      returned.push(owner + ': ' + (row[c.owner_name] || row[c.lead_id] || ('row ' + r)) + ' (' + reason + ')');
    }
  });
  // Move drip leads past call and mail days even if the agent has not opened the app.
  var today0 = addDays_(now, 0);
  LEAD_TABS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var values = sh.getDataRange().getValues();
    var c = {};
    values[0].map(String).forEach(function (x, i) { c[x] = i; });
    if (c.drip_status === undefined) return;
    for (var i = 1; i < values.length; i++) {
      var owner = String(values[i][c.assigned_to] || '').trim();
      if (owner && String(values[i][c.drip_status]) === 'active') dripCatchUp_(sh, i + 1, values[i], c, owner, name, today0);
    }
  });
  console.log('sweepOverdue returned ' + returned.length + ' lead(s)' + (returned.length ? ':\n' + returned.join('\n') : ''));
  return returned;
}

// ───────────────────────── helpers ─────────────────────────

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, code: 503, error: 'busy_try_again' };
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
