// DLTA data adapter — the single source-of-truth boundary.
//
// EVERY screen (dialer, Activity, Goals) talks to the app's data ONLY through
// the functions exported here. No screen may import the Espo client, build an
// Espo URL, or know an Espo field name. Swapping CRM later means rewriting the
// internals of THIS file and nothing else. If a screen reaches past this module,
// the exit insurance lapses.
//
// Public interface (screens depend on this, not on Espo):
//   getLeads({ filter, search, limit, offset })  -> [lead]
//   getLead(leadId)                               -> lead
//   saveDisposition(leadId, { status, followUpDate, nextAction, notes })
//   logTouch(leadId, touchType)
//   getMetrics({ start, end })                    -> { dials, contacts, leads, appts, perDay[7], outcomes }
//   getGoalInputs() / saveGoalInputs(obj)
//
// This file is a plain ES module. It also attaches the same API to
// window.adapter so the existing non-module dialer script can call it.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Secrets live in config, never here and never in screen code. Provide them via
// a window.DLTA_CONFIG object (see src/data/config.example.js). config.js is
// gitignored so the API key is never committed.
//
// SECURITY NOTE: this is a static client-side app on GitHub Pages, so any key
// placed in DLTA_CONFIG ships to the browser. For an internal tool behind the
// Cloudflare tunnel that is acceptable; for hardening, point ESPO_BASE_URL at a
// thin relay (the same pattern the Sheet writes already use via Apps Script)
// instead of Espo directly. Either way, screens are unaffected: only this
// adapter knows the difference.

function readConfig() {
  var cfg = (typeof window !== 'undefined' && window.DLTA_CONFIG) || {};
  return {
    baseUrl: (cfg.ESPO_BASE_URL || 'https://crm.dltaleads.com').replace(/\/+$/, ''),
    apiKey: cfg.ESPO_API_KEY || '',
    // 'apikey' (X-Api-Key header) or 'basic' (username + password).
    authMode: cfg.ESPO_AUTH_MODE || 'apikey',
    basicUser: cfg.ESPO_BASIC_USER || '',
    basicPass: cfg.ESPO_BASIC_PASS || ''
  };
}

// ---------------------------------------------------------------------------
// Field mapping — clean app names -> Espo keys.
// ---------------------------------------------------------------------------
// This is the ONE place Espo casing lives. After verifying Lead.json in step 1
// (Espo Admin > Entity Manager > Lead > Fields), correct any value below and the
// whole app follows. Custom fields carry Espo's 'c' prefix.
var LEAD = {
  entity: 'Lead',
  // Join key used everywhere. lead_id in the Sheet maps to this Espo attribute.
  // VERIFY in step 1: may be 'cLeadId' or the native 'id'.
  leadId: 'cLeadId',
  status: 'cCallStatus',
  // VERIFY in step 1: these may carry a 'c' prefix (cFollowUpDate / cNextAction).
  followUpDate: 'followUpDate',
  nextAction: 'nextAction',
  // Read-only display fields used by getLeads / getLead.
  name: 'name',
  firstName: 'firstName',
  lastName: 'lastName',
  addressStreet: 'addressStreet',
  addressCity: 'addressCity',
  addressState: 'addressState',
  addressZip: 'addressPostalCode',
  // Up to five custom phone fields (cPhone1..cPhone5). VERIFY exact keys.
  phoneFields: ['cPhone1', 'cPhone2', 'cPhone3', 'cPhone4', 'cPhone5'],
  source: 'source',
  leadType: 'cLeadType'
};

// Custom event entity created in step 2. Every disposition and every touch
// writes exactly one row here; this is what powers the metrics.
var CALLLOG = {
  entity: 'cCallLog',
  leadId: 'leadId',     // link attribute to Lead
  type: 'type',         // enum: call_status values AND touch types
  note: 'note',         // text
  occurredAt: 'occurredAt' // datetime
};

// ---------------------------------------------------------------------------
// Vocabularies — kept here so screens never hardcode Espo enum strings.
// ---------------------------------------------------------------------------
// Dialer status keys (lowercase) <-> Espo cCallStatus enum values (display).
var STATUS_KEY_TO_ESPO = {
  'new': 'New',
  'called': 'Called',
  'callback': 'Callback',
  'appointment': 'Appt Set',
  'notinterested': 'Not Int.',
  'dnc': 'DNC',
  'listed': 'Listed'
};
var STATUS_ESPO_TO_KEY = invert(STATUS_KEY_TO_ESPO);

// Touch button labels (canonical Espo type values). Accept loose dialer input
// like 'door knock' and normalize to 'Door Knock'.
var TOUCH_TYPES = ['Map It', 'Door Knock', 'Mail Sent', 'Letter Sent', 'Call', 'Text'];
var TOUCH_NORMALIZE = (function () {
  var m = {};
  for (var i = 0; i < TOUCH_TYPES.length; i++) m[TOUCH_TYPES[i].toLowerCase()] = TOUCH_TYPES[i];
  return m;
})();

// Metrics buckets, defined on the cCallLog `type` value.
var CONTACT_TYPES = ['Called', 'Callback', 'Appt Set', 'Not Int.', 'Listed'];
var LEAD_TYPES = ['Callback', 'Appt Set', 'Listed'];
var APPT_TYPES = ['Appt Set'];
var OUTCOME_TYPES = ['Mail Sent', 'Letter Sent', 'Door Knock'];

// ---------------------------------------------------------------------------
// Espo HTTP client — private to this module.
// ---------------------------------------------------------------------------
function espoHeaders(cfg) {
  var h = { 'Content-Type': 'application/json' };
  if (cfg.authMode === 'basic') {
    h['Authorization'] = 'Basic ' + btoa(cfg.basicUser + ':' + cfg.basicPass);
  } else {
    h['X-Api-Key'] = cfg.apiKey;
  }
  return h;
}

function espoFetch(method, path, options) {
  options = options || {};
  var cfg = readConfig();
  var url = cfg.baseUrl + '/api/v1/' + path;
  if (options.query) {
    var qs = buildQuery(options.query);
    if (qs) url += (url.indexOf('?') === -1 ? '?' : '&') + qs;
  }
  var init = { method: method, headers: espoHeaders(cfg) };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return fetch(url, init).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (text) {
        throw new Error('Espo ' + method + ' ' + path + ' failed: ' + res.status + ' ' + text);
      });
    }
    if (res.status === 204) return null;
    return res.text().then(function (text) {
      return text ? JSON.parse(text) : null;
    });
  });
}

// ---------------------------------------------------------------------------
// Mappers — Espo record <-> clean app object.
// ---------------------------------------------------------------------------
function mapLeadFromEspo(rec) {
  if (!rec) return null;
  var phones = [];
  for (var i = 0; i < LEAD.phoneFields.length; i++) {
    var raw = rec[LEAD.phoneFields[i]];
    var num = raw === undefined || raw === null ? '' : String(raw).trim().replace(/\.0$/, '');
    if (num && num !== '0') phones.push({ number: num, dnc: false, contact: '', type: '' });
  }
  var name = rec[LEAD.name];
  if (!name) {
    name = [rec[LEAD.firstName], rec[LEAD.lastName]].filter(Boolean).join(' ').trim();
  }
  return {
    id: rec.id,
    leadId: rec[LEAD.leadId] || rec.id,
    name: name || 'Unknown Owner',
    address: rec[LEAD.addressStreet] || '',
    city: rec[LEAD.addressCity] || '',
    state: rec[LEAD.addressState] || '',
    zip: rec[LEAD.addressZip] || '',
    phones: phones,
    status: STATUS_ESPO_TO_KEY[rec[LEAD.status]] || 'new',
    statusLabel: rec[LEAD.status] || 'New',
    followUp: String(rec[LEAD.followUpDate] || '').split('T')[0],
    nextAction: rec[LEAD.nextAction] || '',
    source: rec[LEAD.source] || '',
    leadType: rec[LEAD.leadType] || '',
    history: [],
    touches: []
  };
}

function mapCallLogFromEspo(rec) {
  return {
    id: rec.id,
    leadId: rec[CALLLOG.leadId],
    type: rec[CALLLOG.type],
    note: rec[CALLLOG.note] || '',
    occurredAt: rec[CALLLOG.occurredAt] || ''
  };
}

// ---------------------------------------------------------------------------
// Public adapter functions.
// ---------------------------------------------------------------------------

// getLeads({ filter, search, limit, offset }) -> [lead]
// filter: a dialer status key (e.g. 'callback') to narrow by cCallStatus.
function getLeads(opts) {
  opts = opts || {};
  var query = {
    maxSize: opts.limit || 50,
    offset: opts.offset || 0,
    orderBy: 'createdAt',
    order: 'desc'
  };
  if (opts.search) query.textFilter = opts.search;
  var w = 0;
  if (opts.filter && STATUS_KEY_TO_ESPO[opts.filter]) {
    query['where[' + w + '][type]'] = 'equals';
    query['where[' + w + '][attribute]'] = LEAD.status;
    query['where[' + w + '][value]'] = STATUS_KEY_TO_ESPO[opts.filter];
    w++;
  }
  return espoFetch('GET', LEAD.entity, { query: query }).then(function (data) {
    var list = (data && data.list) || [];
    return list.map(mapLeadFromEspo);
  });
}

// getLead(leadId) -> lead (phones, status, history, touches)
function getLead(leadId) {
  var lead;
  return espoFetch('GET', LEAD.entity + '/' + encodeURIComponent(leadId))
    .then(function (rec) {
      lead = mapLeadFromEspo(rec);
      return getCallLogs(leadId, { limit: 100 });
    })
    .then(function (logs) {
      lead.history = logs;
      lead.touches = logs.filter(function (e) { return TOUCH_NORMALIZE[String(e.type).toLowerCase()]; });
      return lead;
    });
}

// saveDisposition(leadId, { status, followUpDate, nextAction, notes })
// Writes the Lead, then creates one cCallLog event row.
function saveDisposition(leadId, payload) {
  payload = payload || {};
  var espoStatus = STATUS_KEY_TO_ESPO[payload.status] || payload.status || 'Called';
  var leadBody = {};
  leadBody[LEAD.status] = espoStatus;
  if (payload.followUpDate !== undefined) leadBody[LEAD.followUpDate] = payload.followUpDate || null;
  if (payload.nextAction !== undefined) leadBody[LEAD.nextAction] = payload.nextAction || '';

  return espoFetch('PUT', LEAD.entity + '/' + encodeURIComponent(leadId), { body: leadBody })
    .then(function (leadRec) {
      var logBody = {};
      logBody[CALLLOG.leadId] = leadId;
      logBody[CALLLOG.type] = espoStatus;
      logBody[CALLLOG.note] = payload.notes || '';
      logBody[CALLLOG.occurredAt] = nowIso();
      return espoFetch('POST', CALLLOG.entity, { body: logBody }).then(function (logRec) {
        return { lead: leadRec, event: logRec };
      });
    });
}

// logTouch(leadId, touchType) -> creates one cCallLog event row.
function logTouch(leadId, touchType) {
  var type = TOUCH_NORMALIZE[String(touchType).toLowerCase()] || touchType;
  var body = {};
  body[CALLLOG.leadId] = leadId;
  body[CALLLOG.type] = type;
  body[CALLLOG.occurredAt] = nowIso();
  return espoFetch('POST', CALLLOG.entity, { body: body });
}

// getMetrics({ start, end }) -> aggregates computed in the adapter.
// Espo REST has weak server-side aggregation, so we fetch the range and count
// here. Fine at this volume; if it grows, add a custom Espo API endpoint.
function getMetrics(range) {
  range = range || {};
  var start = range.start || startOfWeekIso();
  var end = range.end || nowIso();
  return fetchCallLogRange(start, end).then(function (rows) {
    var dials = rows.length;
    var contacts = 0, leadsCount = 0, appts = 0;
    var perDay = [0, 0, 0, 0, 0, 0, 0];
    var outcomes = { 'Mail Sent': 0, 'Letter Sent': 0, 'Door Knock': 0 };
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].type;
      if (CONTACT_TYPES.indexOf(t) !== -1) contacts++;
      if (LEAD_TYPES.indexOf(t) !== -1) leadsCount++;
      if (APPT_TYPES.indexOf(t) !== -1) appts++;
      if (OUTCOME_TYPES.indexOf(t) !== -1 && outcomes[t] !== undefined) outcomes[t]++;
      var d = new Date(rows[i].occurredAt);
      if (!isNaN(d.getTime())) perDay[d.getDay()]++;
    }
    return {
      dials: dials,
      contacts: contacts,
      leads: leadsCount,
      appts: appts,
      perDay: perDay,
      outcomes: outcomes,
      range: { start: start, end: end }
    };
  });
}

// getGoalInputs() / saveGoalInputs(obj)
// Lifestyle target plus funnel params. Persisted behind the boundary; today via
// localStorage, swappable to an Espo settings entity without touching screens.
var GOAL_KEY = 'dlta.goalInputs';
var GOAL_DEFAULTS = {
  lifestyleIncome: 120000, // annual take-home target
  avgCommission: 9000,     // dollars per closing
  commissionPercent: 3,    // true percent, handled as a percent not a fraction
  leadsPerClosing: 10,
  workdaysPerMonth: 20
};

function getGoalInputs() {
  try {
    var raw = (typeof localStorage !== 'undefined') && localStorage.getItem(GOAL_KEY);
    var saved = raw ? JSON.parse(raw) : {};
    return Promise.resolve(Object.assign({}, GOAL_DEFAULTS, saved));
  } catch (e) {
    return Promise.resolve(Object.assign({}, GOAL_DEFAULTS));
  }
}

function saveGoalInputs(obj) {
  var merged = Object.assign({}, GOAL_DEFAULTS, obj || {});
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(GOAL_KEY, JSON.stringify(merged));
  } catch (e) { /* non-fatal */ }
  return Promise.resolve(merged);
}

// ---------------------------------------------------------------------------
// Private helpers.
// ---------------------------------------------------------------------------
function getCallLogs(leadId, opts) {
  opts = opts || {};
  var query = {
    maxSize: opts.limit || 100,
    offset: 0,
    orderBy: CALLLOG.occurredAt,
    order: 'desc'
  };
  query['where[0][type]'] = 'equals';
  query['where[0][attribute]'] = CALLLOG.leadId;
  query['where[0][value]'] = leadId;
  return espoFetch('GET', CALLLOG.entity, { query: query }).then(function (data) {
    var list = (data && data.list) || [];
    return list.map(mapCallLogFromEspo);
  });
}

// Fetch every cCallLog row whose occurredAt is in [start, end], paging through
// Espo's maxSize window.
function fetchCallLogRange(start, end) {
  var pageSize = 200;
  var collected = [];
  function page(offset) {
    var query = {
      maxSize: pageSize,
      offset: offset,
      orderBy: CALLLOG.occurredAt,
      order: 'desc'
    };
    query['where[0][type]'] = 'between';
    query['where[0][attribute]'] = CALLLOG.occurredAt;
    query['where[0][value][0]'] = start;
    query['where[0][value][1]'] = end;
    return espoFetch('GET', CALLLOG.entity, { query: query }).then(function (data) {
      var list = (data && data.list) || [];
      collected = collected.concat(list.map(mapCallLogFromEspo));
      if (list.length === pageSize) return page(offset + pageSize);
      return collected;
    });
  }
  return page(0);
}

function buildQuery(obj) {
  var parts = [];
  for (var k in obj) {
    if (!obj.hasOwnProperty(k)) continue;
    if (obj[k] === undefined || obj[k] === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
  }
  return parts.join('&');
}

function invert(obj) {
  var out = {};
  for (var k in obj) { if (obj.hasOwnProperty(k)) out[obj[k]] = k; }
  return out;
}

function nowIso() {
  // Espo expects 'YYYY-MM-DD HH:mm:ss' in UTC for datetime fields.
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function startOfWeekIso() {
  var d = new Date();
  var day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Exports.
// ---------------------------------------------------------------------------
var adapter = {
  getLeads: getLeads,
  getLead: getLead,
  saveDisposition: saveDisposition,
  logTouch: logTouch,
  getMetrics: getMetrics,
  getGoalInputs: getGoalInputs,
  saveGoalInputs: saveGoalInputs
};

// Make available to the existing non-module dialer script.
if (typeof window !== 'undefined') window.adapter = adapter;

export default adapter;
export {
  getLeads, getLead, saveDisposition, logTouch,
  getMetrics, getGoalInputs, saveGoalInputs
};
