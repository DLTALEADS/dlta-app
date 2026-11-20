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
    OWNER_COLS.forEach(function (h) {
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
  }
  var updates = req.updates || {};
  Object.keys(updates).forEach(function (k) {
    if (WRITABLE.indexOf(k) !== -1 && r.col[k]) sh.getRange(r.row, r.col[k]).setValue(updates[k]);
  });
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
  return { ok: true, assigned_to: to };
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
