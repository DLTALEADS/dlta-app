# DLTA Dialer (app.dltaleads.com) Handoff, Nov 20, 2026

## 1. Goal and current phase

Get DLTA agents using app.dltaleads.com every day. Agents asked for logins and lead
assignment so nobody steps on anyone's leads. That shipped, along with automatic
follow-ups, a working calendar, per-agent Activity and Goals, and a 45-day drip
(text, call, postcard) that starts when an agent claims a lead. Tom's drip texts send
automatically from the office iMac. Phase now: drip is live with the first wording;
next is rewriting the texts with Tom and George, then Save the House (attorney referral).

## 2. Final decisions (verbatim where it matters)

- Data stays in the Google Sheet. No Supabase, no new database (2 to 3 active callers, 5 max).
- Users: George (admin), Tom (agent), Yaser (agent), Guero (admin). First PIN typed becomes the PIN.
- Lead ownership: claim from Pool, or working a pool lead claims it. Nobody can save on another agent's lead. Admins reassign.
- Follow-up rules (auto, agent can override): called 1 business day, callback 2 business days, text 2, door knock 3, mail or letter 7, not interested 60, DNC or listed cleared. A future date the agent picked is kept.
- Missed follow-ups: 6am daily sweep returns a lead to the Pool when its follow-up is 3+ days overdue with no call, or it was claimed 7+ days ago and never called. Reason is logged in call history.
- Drip starts on claim (whether or not the agent reached the person). Steps in days from claim: 0 text, 2 call, 4 text with infographic, 7 postcard, 10 text, 14 call, 21 text, 30 postcard, 45 text. Stops on Appt Set, Not Interested, DNC, Listed, Referred, or return to Pool.
- Texts sign with the logged-in agent's name, include the property address, stay short (about 160 chars).
- Texting: never Twilio. Tom's drip sends through Messages on the office iMac (DLTA line). Other agents: in-app one-tap send for now; a dedicated computer per agent if they commit one; iPhone Shortcuts later.
- Drip texts send 9am to 8pm only, max 75 a day per sender, 20 to 60 seconds apart.
- Guero chose to send the first 4 drip texts tonight with the current wording (leads got voicemails today).
- Landvoice DNC flags are unreliable and ignored.
- Goals: starting rates for distressed sellers are contact 10%, contact to appt 10%, appt to signed listing 40%, listing to close 70% (about 31 dials/day for $10k/month). Sliders saved per agent.
- Activity and Goals are per agent; admins can switch agent or see Everyone in Activity.
- Attorney partner: Steve Cole, Aaron Legal, steve@lawguy.com, office 630-925-4431 (paralegal Fiona answers most of the day), direct 630-903-4444. Open to foreclosure defense referrals and to sending Cook County sellers back.

## 3. File inventory (repo DLTALEADS/dlta-app, main branch, GitHub Pages)

| Path | What | State |
|---|---|---|
| index.html | The whole dialer app (single file) | live |
| apps-script/Code.gs | DLTA Dialer API (Google Apps Script web app): login, leads, claim, save, assign, appointments, drip, daily sweep | live, deployed |
| apps-script/SETUP.md | Setup, logins, follow-ups, drip, how to redeploy | final |
| tests/api.test.js | 21 backend tests against a fake Sheet (`node tests/api.test.js`) | passing |
| scripts/imac-drip-sender/dlta_drip_sender.py | iMac sender: pulls an agent's drip queue, sends via Messages | installed on iMac for Tom |
| scripts/imac-drip-sender/install.sh | Installs the launchd job and saves the agent PIN in Keychain | used |
| HANDOFF.md | This file | final |

Live pieces outside the repo:
- Apps Script project "DLTA Dialer API" at script.google.com (owner: the Google account that owns the lead Sheet). Web app URL: https://script.google.com/macros/s/AKfycbwkCp5fv-lmzBs0gvr39XHUSKYtVvUqsabZykczzbEfms2GPgVf_fNoXIty3vWg02JQew/exec
- Lead Sheet 1MlrW2RAdykKJFBbiIeNBlCwct7oepW_mrybhS3U1Wqw. Tabs: dlta-leads-formatted (45 original columns + assigned_to, assigned_at, last_called_by, last_called_at, drip_start, drip_step, drip_next, drip_status), remine-leads, agents, appointments, mailers.
- Office iMac (user owner): ~/dlta-drip-sender/dlta_drip_sender.py, ~/Library/LaunchAgents/com.dlta.drip-sender.plist (every 30 min), log ~/Library/Logs/dlta-drip-sender.log, Tom's PIN in Keychain (service dlta-dialer).

## 4. How to run it

- App: push to main, GitHub Pages publishes app.dltaleads.com in 1 to 2 minutes.
- Backend tests: `node tests/api.test.js` (Node, no deps).
- Update the Apps Script: open raw Code.gs from main, paste over Code.gs in the editor, save, run `setup`, then Deploy > Manage deployments > pencil > New version > Deploy (URL stays the same).
- iMac sender: `python3 ~/dlta-drip-sender/dlta_drip_sender.py --dry-run` (preview), `--test PHONE` (one test text), no flag sends what is due. Pause: `launchctl unload ~/Library/LaunchAgents/com.dlta.drip-sender.plist`. Resume: `launchctl load` same path.

## 5. Status

CONFIRMED this session:
- Logins and lead ownership live; Tom and Guero logged in on app.dltaleads.com; 3,016 leads load through the API.
- Texts show the logged-in agent's name (checked by Guero from both logins).
- Apps Script updated twice and redeployed; drip queue returned 4 texts for Tom on the iMac dry run.
- Personal scoreboard, Due tab, follow-up time picker, calendar, Goals fix, Activity per agent all merged (PRs 16 to 23).
- iMac sender installed for Tom; a manual run sent 2 texts.

ASSUMED (not verified):
- Why 2 of the 4 drip texts did not send (likely Android or landline numbers without Text Message Forwarding, or the run was still pausing between texts). Check the log.
- The 6am sweep trigger fires (installed by setup; first run Nov 21).
- Calendar appointments render correctly on the live Sheet (tested only against a fake backend).

## 6. Open issues and next steps

1. Check `tail -20 ~/Library/Logs/dlta-drip-sender.log` on the iMac for "NOT sent" lines; turn on Text Message Forwarding on the DLTA iPhone for the iMac if Android numbers failed.
2. Add a lock file to dlta_drip_sender.py so two runs can never overlap (possible duplicate texts today if a manual run overlaps the 30-min run).
3. Decide multi-number texting: proposal is first drip text to every number Landvoice marks mobile, then best phone only.
4. Rewrite the 9 drip texts: question at the end of each, "Reply STOP to opt out" in the first text, softer opener (not "I saw a court filing"), Tom Mackrola Homes team branding on Tom's line, Spanish versions. Draft as a doc for Tom and George, then load approved wording into DRIP_TEXTS in Code.gs.
5. Add a drip on/off switch (Script Property) so sending can be paused for everyone at once.
6. Hide the in-app drip card for agents whose texts send from the iMac (Tom) to avoid double sends.
7. Build Save the House / Refer to Attorney disposition: partner picker (Partners tab, per agent; Steve Cole first), homeowner-agreed checkbox, email summary to attorney with agent CC, log in history, status referred (stops drip).
8. Optional: text the homeowner the morning of an agent's timed follow-up ("I'll call around 2:30 today").
9. Lockdown: make the lead Sheet private (confirm the landvoice_runner service account is an editor first), delete the old Google API key, retire the old Apps Script (check n8n does not call it).
10. Later list: forms library in the Forms tab (Yaser), postcards plus Pimpy handoff and co-marketing with Steve, MLS history on leads (check MLS Grid license), EspoCRM keep or retire.

## 7. Waiting on Guero

- The iMac log output (issue 1).
- Yes or no on texting all mobile numbers (issue 3) and on the timed-follow-up morning text (issue 8).
- Tom and George's markup of the rewritten texts (issue 4).
- Steve's office email if Fiona watches a different inbox (issue 7).
