// Tests for apps-script/Code.gs against an in-memory fake of Google Sheets.
// Run: node tests/api.test.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const assert = require('assert');

function makeEnv() {
  const tabs = {};
  function makeSheet(name, rows) {
    const data = rows.map(r => r.slice());
    const sheet = {
      name, data,
      getLastRow: () => data.length,
      getLastColumn: () => Math.max(0, ...data.map(r => r.length)),
      getDataRange: () => ({
        getValues: () => data.map(r => { const w = sheet.getLastColumn(); const c = r.slice(); while (c.length < w) c.push(''); return c; }),
        getDisplayValues: () => data.map(r => { const w = sheet.getLastColumn(); const c = r.map(String); while (c.length < w) c.push(''); return c; })
      }),
      getRange: (row, col, nr = 1, nc = 1) => ({
        getValues: () => {
          const out = [];
          for (let i = 0; i < nr; i++) { const rr = []; for (let j = 0; j < nc; j++) { const v = (data[row - 1 + i] || [])[col - 1 + j]; rr.push(v === undefined ? '' : v); } out.push(rr); }
          return out;
        },
        setValue: v => { while (data.length < row) data.push([]); const r = data[row - 1]; while (r.length < col) r.push(''); r[col - 1] = v; }
      }),
      appendRow: r => data.push(r.slice()),
      deleteRow: r => data.splice(r - 1, 1)
    };
    tabs[name] = sheet;
    return sheet;
  }
  const ss = { getSheetByName: n => tabs[n] || null, insertSheet: n => makeSheet(n, []) };
  const props = {}; const cache = {}; const triggers = [];
  const toSigned = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  const ctx = {
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
    ScriptApp: { getProjectTriggers: () => triggers, newTrigger: fn => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => triggers.push({ getHandlerFunction: () => fn }) }) }) }) }) },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    console: { log: () => {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => toSigned(crypto.createHash('sha256').update(s, 'utf8').digest()),
      computeHmacSha256Signature: (s, k) => toSigned(crypto.createHmac('sha256', k).update(s).digest()),
      base64EncodeWebSafe: x => Buffer.from(typeof x === 'string' ? Buffer.from(x, 'utf8') : x.map(b => b & 0xff)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: s => Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      formatDate: (d, tz, f) => (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(),
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') })
    },
    Date, JSON, Math, String, Number, Object
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);

  // 45-column header like the live tab, plus two leads.
  const headers = ['lead_id', 'date', 'owner_name'];
  while (headers.length < 45) headers.push('col' + headers.length);
  headers[3] = 'address_street'; headers[12] = 'phone_1'; headers[27] = 'best_phone_number';
  headers[28] = 'text_sent'; headers[29] = 'text_sent_timestamp'; headers[30] = 'lead_type';
  headers[20] = 'notes'; headers[21] = 'call_status'; headers[22] = 'follow_up_date'; headers[26] = 'lead_status';
  const lead = id => { const r = headers.map(() => ''); r[0] = id; r[2] = 'Owner ' + id; r[3] = id + ' Main St'; r[12] = '708555' + String(1000 + id.length); return r; };
  makeSheet('dlta-leads-formatted', [headers, lead('L1'), lead('L2'), lead('L3')]);
  const call = req => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(req) } }).s);
  return { ctx, tabs, call, cache, triggers };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }

const env = makeEnv();
const { ctx, tabs, call } = env;
const S = 'dlta-leads-formatted';

test('setup adds 4 columns after column 45 and an agents tab', () => {
  ctx.setup();
  const h = tabs[S].data[0];
  assert.strictEqual(h.length, 53);
  assert.deepStrictEqual(h.slice(45), ['assigned_to', 'assigned_at', 'last_called_by', 'last_called_at',
    'drip_start', 'drip_step', 'drip_next', 'drip_status']);
  assert.strictEqual(h[0], 'lead_id');
  assert.strictEqual(tabs.agents.data.length, 5);
  ctx.setup(); // idempotent
  assert.strictEqual(tabs[S].data[0].length, 53);
});

test('a 45-column runner append still lands cleanly (pool)', () => {
  const r = tabs[S].data[1].slice(0, 45); r[0] = 'L4';
  tabs[S].appendRow(r);
});

test('agents list shows active names only', () => {
  tabs.agents.appendRow([5, 'Gone', '', 'agent', false]);
  assert.deepStrictEqual(call({ action: 'agents' }).agents, ['George', 'Tom', 'Yaser', 'Guero']);
});

test('no token returns 401', () => {
  assert.strictEqual(call({ action: 'leads', sheet: S }).code, 401);
  assert.strictEqual(call({ action: 'leads', sheet: S, token: 'abc.def' }).code, 401);
});

let tom, yaser, george;
test('first login sets the PIN, second login checks it', () => {
  const r = call({ action: 'login', name: 'Tom', pin: '1234' });
  assert.ok(r.ok && r.firstTime && r.role === 'agent');
  tom = r.token;
  assert.ok(!/1234/.test(String(tabs.agents.data[2][2])), 'PIN not stored in plain text');
  assert.strictEqual(call({ action: 'login', name: 'Tom', pin: '9999' }).code, 401);
  const again = call({ action: 'login', name: 'Tom', pin: '1234' });
  assert.ok(again.ok && !again.firstTime);
  yaser = call({ action: 'login', name: 'Yaser', pin: '5555' }).token;
  george = call({ action: 'login', name: 'George', pin: '7777' }).token;
});

test('5 bad PINs locks the name', () => {
  for (let i = 0; i < 5; i++) call({ action: 'login', name: 'Yaser', pin: '0000' });
  assert.strictEqual(call({ action: 'login', name: 'Yaser', pin: '5555' }).code, 429);
  delete env.cache['fail_yaser'];
});

test('tampered token is rejected', () => {
  const [p, s] = tom.split('.');
  const forged = Buffer.from(JSON.stringify({ n: 'George', r: 'admin', e: Date.now() + 1e7 })).toString('base64');
  assert.strictEqual(call({ action: 'leads', sheet: S, token: forged + '.' + s }).code, 401);
  assert.strictEqual(call({ action: 'leads', sheet: S, token: p }).code, 401);
});

test('Tom claims L1; Yaser gets 409 on claim and 403 on save', () => {
  assert.ok(call({ action: 'claim', sheet: S, row: 2, lead_id: 'L1', token: tom }).ok);
  const c = call({ action: 'claim', sheet: S, row: 2, lead_id: 'L1', token: yaser });
  assert.strictEqual(c.code, 409); assert.strictEqual(c.owner, 'Tom');
  const s = call({ action: 'save', sheet: S, row: 2, lead_id: 'L1', token: yaser, updates: { notes: 'mine now' } });
  assert.strictEqual(s.code, 403);
  assert.strictEqual(tabs[S].data[1][20], '', 'Yaser note was not written');
});

test('Yaser never receives Tom lead; Tom sees his plus pool', () => {
  const y = call({ action: 'leads', sheet: S, token: yaser });
  assert.ok(!y.rows.some(r => r.v[0] === 'L1'));
  assert.deepStrictEqual(y.rows.map(r => r.v[0]), ['L2', 'L3', 'L4']);
  const t = call({ action: 'leads', sheet: S, token: tom });
  assert.ok(t.rows.some(r => r.v[0] === 'L1'));
  assert.strictEqual(call({ action: 'leads', sheet: S, token: george }).rows.length, 4);
});

test('saving a pool lead auto-claims it and stamps who called', () => {
  const r = call({ action: 'save', sheet: S, row: 3, lead_id: 'L2', token: yaser, updates: { notes: 'left vm', call_status: 'called', owner_name: 'HACK' } });
  assert.ok(r.ok); assert.strictEqual(r.assigned_to, 'Yaser');
  const row = tabs[S].data[2];
  assert.strictEqual(row[45], 'Yaser'); assert.strictEqual(row[47], 'Yaser');
  assert.strictEqual(row[20], 'left vm');
  assert.strictEqual(row[2], 'Owner L2', 'non-whitelisted field ignored');
});

test('wrong lead_id for the row returns row_moved_reload', () => {
  assert.strictEqual(call({ action: 'save', sheet: S, row: 3, lead_id: 'L1', token: yaser, updates: {} }).error, 'row_moved_reload');
});

test('assign is admin only; George reassigns L1 from Tom to Yaser', () => {
  assert.strictEqual(call({ action: 'assign', sheet: S, row: 2, lead_id: 'L1', to: 'Yaser', token: tom }).code, 403);
  assert.ok(call({ action: 'assign', sheet: S, row: 2, lead_id: 'L1', to: 'Yaser', token: george }).ok);
  assert.ok(!call({ action: 'leads', sheet: S, token: tom }).rows.some(r => r.v[0] === 'L1'));
  assert.ok(call({ action: 'leads', sheet: S, token: yaser }).rows.some(r => r.v[0] === 'L1'));
  assert.strictEqual(call({ action: 'assign', sheet: S, row: 2, lead_id: 'L1', to: 'Nobody Real', token: george }).error, 'unknown_agent');
  assert.ok(call({ action: 'assign', sheet: S, row: 2, lead_id: 'L1', to: '', token: george }).ok);
  assert.strictEqual(tabs[S].data[1][45], '');
});

test('unknown tab is refused', () => {
  assert.strictEqual(call({ action: 'leads', sheet: 'agents', token: george }).ok, false);
});

test('resetPin lets an agent pick a new PIN', () => {
  ctx.resetPin('Tom');
  const r = call({ action: 'login', name: 'Tom', pin: '4321' });
  assert.ok(r.ok && r.firstTime);
});

test('setup creates appointments tab and exactly one daily sweep trigger', () => {
  assert.ok(tabs.appointments);
  ctx.setup();
  assert.strictEqual(env.triggers.length, 1);
});

test('appointments: add, list own only, delete own only', () => {
  const tom2 = call({ action: 'login', name: 'Tom', pin: '4321' }).token;
  assert.strictEqual(call({ action: 'addAppt', token: tom2, appt: { title: 'x' } }).error, 'start_and_title_required');
  const a = call({ action: 'addAppt', token: tom2, appt: { title: 'Listing appt', start: '2026-11-24T15:00', type: 'appointment', lead_row: 2 } });
  assert.ok(a.ok);
  call({ action: 'addAppt', token: yaser, appt: { title: 'Y appt', start: '2026-11-25T10:00' } });
  assert.deepStrictEqual(call({ action: 'appts', token: tom2 }).appts.map(x => x.title), ['Listing appt']);
  assert.strictEqual(call({ action: 'appts', token: george }).appts.length, 2);
  assert.strictEqual(call({ action: 'deleteAppt', token: yaser, appt_id: a.appt_id }).code, 403);
  assert.ok(call({ action: 'deleteAppt', token: tom2, appt_id: a.appt_id }).ok);
  assert.strictEqual(call({ action: 'appts', token: tom2 }).appts.length, 0);
});

test('sweep returns missed follow-ups and idle claims to the pool, keeps the rest', () => {
  const d = tabs[S].data;
  const set = (row, fu, lastCall, owner, claimed, status) => {
    d[row][22] = fu; d[row][46] = claimed; d[row][48] = lastCall; d[row][45] = owner; d[row][26] = status || 'called';
  };
  const now = '2026-11-20T12:00:00';
  set(1, '2026-11-10', '2026-11-09T10:00:00Z', 'Tom', '2026-11-01'); // missed by 10 days -> return
  set(2, '2026-11-19', '2026-11-18T10:00:00Z', 'Yaser', '2026-11-01'); // 1 day late, in grace -> keep
  set(3, '', '', 'Tom', '2026-11-05T10:00:00Z'); // claimed 15 days, never called -> return
  d.push(d[1].slice()); d[5][0] = 'L5'; set(5, '11/1/2026', '', 'Yaser', '2026-11-01', 'listed'); // listed -> keep
  const out = ctx.sweepOverdue(now);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(d[1][45], ''); assert.ok(/Back to pool from Tom: follow-up missed/.test(d[1][20]));
  assert.strictEqual(d[2][45], 'Yaser');
  assert.strictEqual(d[3][45], ''); assert.ok(/no call/.test(d[3][20]));
  assert.strictEqual(d[5][45], 'Yaser');
  assert.strictEqual(ctx.sweepOverdue(now).length, 0, 'second run changes nothing');
});

test('setup starts the drip on leads claimed before the drip existed', () => {
  const e = makeEnv(); e.ctx.setup();
  const d = e.tabs[S].data;
  d[1][45] = 'Tom'; d[2][45] = 'Tom'; d[2][26] = 'listed';
  e.ctx.setup();
  assert.strictEqual(d[1][52], 'active'); assert.strictEqual(d[2][52] || '', '', 'listed lead not started');
  assert.strictEqual(d[3][52] || '', '', 'pool lead not started');
});

test('drip: claim starts it, text queued with agent name and address', () => {
  const e = makeEnv(); e.ctx.setup();
  const t = e.call({ action: 'login', name: 'Tom', pin: '1111' }).token;
  const y = e.call({ action: 'login', name: 'Yaser', pin: '2222' }).token;
  assert.ok(e.call({ action: 'claim', sheet: S, row: 2, lead_id: 'L1', token: t }).ok);
  const row = e.tabs[S].data[1];
  assert.strictEqual(row[52], 'active'); assert.strictEqual(row[50], 0);
  const q = e.call({ action: 'dripQueue', token: t });
  assert.strictEqual(q.items.length, 1);
  assert.ok(/Tom/.test(q.items[0].text) && /L1 Main St/.test(q.items[0].text), q.items[0].text);
  assert.ok(q.items[0].text.length <= 160, 'one bubble: ' + q.items[0].text.length);
  assert.strictEqual(e.call({ action: 'dripQueue', token: y }).items.length, 0, 'Yaser does not see Tom queue');
  assert.strictEqual(e.call({ action: 'dripSent', token: y, sheet: S, row: 2, lead_id: 'L1', step: 0 }).code, 403);
  const m = e.call({ action: 'dripSent', token: t, sheet: S, row: 2, lead_id: 'L1', step: 0, text: q.items[0].text });
  assert.ok(m.ok); assert.strictEqual(row[50], 1); assert.strictEqual(row[28], 'TRUE');
  assert.ok(/Drip text sent/.test(row[20]));
  assert.strictEqual(e.call({ action: 'dripSent', token: t, sheet: S, row: 2, lead_id: 'L1', step: 0 }).error, 'step_already_handled');
  assert.strictEqual(e.call({ action: 'dripQueue', token: t }).items.length, 0, 'next step is in the future');
  global.__dripEnv = { e, t, row };
});

test('drip: overdue call and mail steps run on their own; text steps wait', () => {
  const { e, t, row } = global.__dripEnv;
  const ago = new Date(); ago.setDate(ago.getDate() - 10);
  row[49] = ago.toISOString(); row[51] = '2000-01-01';
  const q = e.call({ action: 'dripQueue', token: t });
  assert.strictEqual(q.items.length, 1); assert.strictEqual(q.items[0].msg, 'guide');
  assert.ok(/lis_pendens_infographic/.test(q.items[0].text));
  assert.ok(row[22], 'call step set a follow-up date');
  assert.ok(e.call({ action: 'dripSkip', token: t, sheet: S, row: 2, lead_id: 'L1', step: 2 }).ok);
  const q2 = e.call({ action: 'dripQueue', token: t });
  assert.strictEqual(q2.items[0].msg, 'calls');
  assert.strictEqual(e.tabs.mailers.data.length, 2, 'mail step added one postcard row');
  assert.strictEqual(e.tabs.mailers.data[1][6], 'L1 Main St');
});

test('drip: a stop status ends it; sweep moves call days without the app open', () => {
  const { e, t, row } = global.__dripEnv;
  e.call({ action: 'save', token: t, sheet: S, row: 2, lead_id: 'L1', updates: { lead_status: 'appointment' } });
  assert.strictEqual(row[52], 'stopped');
  assert.strictEqual(e.call({ action: 'dripQueue', token: t }).items.length, 0);
  e.call({ action: 'claim', sheet: S, row: 3, lead_id: 'L2', token: t });
  const r2 = e.tabs[S].data[2];
  const ago = new Date(); ago.setDate(ago.getDate() - 3);
  r2[48] = ago.toISOString(); r2[50] = 1; r2[51] = '2000-01-01'; r2[49] = ago.toISOString();
  e.ctx.sweepOverdue();
  assert.strictEqual(r2[50], 2, 'call step advanced by the daily run');
  assert.ok(r2[22], 'follow-up date set for the call day');
});

console.log('\n' + passed + ' tests passed');
