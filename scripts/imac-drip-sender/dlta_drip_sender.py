#!/usr/bin/env python3
"""
DLTA drip sender for the office iMac.

Pulls one agent's drip texts from the DLTA Dialer API and sends them through
the Messages app (the DLTA line), one at a time. Runs from launchd every 30
minutes. Standard library only.

Rules it enforces:
  - only between 9am and 8pm local time
  - at most DAILY_CAP texts per day
  - a 20 to 60 second pause between texts
  - a text is marked sent only after Messages accepts it

The agent's PIN is read from the macOS Keychain (service "dlta-dialer",
account = agent name). It is never stored in this file or in a log.

Usage:
  dlta_drip_sender.py              send what is due now
  dlta_drip_sender.py --dry-run    show what would be sent, send nothing
  dlta_drip_sender.py --test PHONE send one test text to PHONE and exit
"""
import datetime
import json
import os
import random
import subprocess
import sys
import time
import urllib.request

API_URL = 'https://script.google.com/macros/s/AKfycbwkCp5fv-lmzBs0gvr39XHUSKYtVvUqsabZykczzbEfms2GPgVf_fNoXIty3vWg02JQew/exec'
AGENT = os.environ.get('DLTA_AGENT', 'Tom')
KEYCHAIN_SERVICE = 'dlta-dialer'
DAILY_CAP = 75
START_HOUR, END_HOUR = 9, 20
STATE_DIR = os.path.expanduser('~/Library/Application Support/dlta-drip-sender')
LOG_PATH = os.path.expanduser('~/Library/Logs/dlta-drip-sender.log')

# Tries iMessage first, then SMS (works when the iPhone with the DLTA SIM has
# Text Message Forwarding on for this Mac). Prints "ok" or the error.
APPLESCRIPT = '''
on run argv
  set thePhone to item 1 of argv
  set theText to item 2 of argv
  tell application "Messages"
    try
      set svc to 1st account whose service type = iMessage
      send theText to participant thePhone of svc
      return "ok"
    on error errA
      try
        set svc to 1st account whose service type = SMS
        send theText to participant thePhone of svc
        return "ok"
      on error errB
        return "error: " & errA & " / " & errB
      end try
    end try
  end tell
end run
'''


def log(msg):
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    line = '%s %s' % (datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line)
    with open(LOG_PATH, 'a') as f:
        f.write(line + '\n')


def pin_from_keychain():
    r = subprocess.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', AGENT, '-w'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('No PIN in Keychain for %s. Run install.sh first.' % AGENT)
    return r.stdout.strip()


def api(payload):
    req = urllib.request.Request(API_URL, data=json.dumps(payload).encode(), method='POST',
                                 headers={'Content-Type': 'text/plain'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def sent_today_path():
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, 'sent-%s.txt' % datetime.date.today().isoformat())


def sent_today():
    p = sent_today_path()
    return int(open(p).read().strip() or 0) if os.path.exists(p) else 0


def bump_sent():
    n = sent_today() + 1
    with open(sent_today_path(), 'w') as f:
        f.write(str(n))
    return n


def e164(phone):
    d = ''.join(ch for ch in str(phone) if ch.isdigit())
    if len(d) == 10:
        d = '1' + d
    return '+' + d


def send_imessage(phone, text):
    r = subprocess.run(['osascript', '-e', APPLESCRIPT, e164(phone), text], capture_output=True, text=True, timeout=60)
    out = (r.stdout or r.stderr).strip()
    return out == 'ok', out


def main():
    args = sys.argv[1:]
    dry = '--dry-run' in args
    if '--test' in args:
        phone = args[args.index('--test') + 1]
        ok, out = send_imessage(phone, 'DLTA drip sender test from the office iMac.')
        log('test to %s: %s' % (phone, out))
        return 0 if ok else 1

    now = datetime.datetime.now()
    if not (START_HOUR <= now.hour < END_HOUR) and not dry:
        return 0
    left = DAILY_CAP - sent_today()
    if left <= 0 and not dry:
        log('daily cap of %d reached' % DAILY_CAP)
        return 0

    login = api({'action': 'login', 'name': AGENT, 'pin': pin_from_keychain()})
    if not login.get('ok'):
        log('login failed for %s: %s' % (AGENT, login.get('error')))
        return 1
    token = login['token']
    q = api({'action': 'dripQueue', 'token': token})
    if not q.get('ok'):
        log('queue failed: %s' % q.get('error'))
        return 1
    items = q.get('items', [])
    if not items:
        return 0
    log('%d drip text(s) due for %s, sending up to %d' % (len(items), AGENT, left))

    sent = 0
    for i, it in enumerate(items[:max(left, 0) if not dry else len(items)]):
        label = '%s, %s (step %s)' % (it.get('name'), it.get('address'), it.get('step'))
        if dry:
            log('DRY RUN would send to %s: %s | %s' % (it['phone'], label, it['text']))
            continue
        if datetime.datetime.now().hour >= END_HOUR:
            log('8pm reached, stopping')
            break
        ok, out = send_imessage(it['phone'], it['text'])
        if not ok:
            log('NOT sent to %s: %s | %s' % (it['phone'], label, out))
            continue
        mark = api({'action': 'dripSent', 'token': token, 'sheet': it['sheet'], 'row': it['row'],
                    'lead_id': it.get('lead_id', ''), 'step': it['step'], 'text': it['text']})
        bump_sent()
        sent += 1
        log('sent to %s: %s%s' % (it['phone'], label, '' if mark.get('ok') else ' (mark failed: %s)' % mark.get('error')))
        if i < len(items) - 1:
            time.sleep(random.randint(20, 60))
    if not dry:
        log('done: %d sent, %d today' % (sent, sent_today()))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # keep launchd runs from dying silently
        log('ERROR %s: %s' % (type(e).__name__, e))
        sys.exit(1)
