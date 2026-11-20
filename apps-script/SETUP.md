# DLTA Dialer API setup (multi-user logins and lead ownership)

The dialer no longer reads the Sheet with a public API key. Every read and write
goes through this Apps Script web app, which checks who is logged in and who
owns each lead.

## One-time setup (about 10 minutes)

1. Go to script.google.com while signed in as the Google account that owns the
   lead Sheet. Click New project. Name it "DLTA Dialer API".
2. Delete the starter code, paste in all of `Code.gs` from this folder, and save.
3. In the function dropdown at the top, pick `setup` and click Run. Approve the
   permissions prompt. This:
   - adds 4 columns after the existing 45: assigned_to, assigned_at,
     last_called_by, last_called_at (existing columns are never touched)
   - creates an "agents" tab with George (admin), Tom, Yaser, Guero (admin)
   - creates the login signing secret (stored in Script Properties, never in code)
4. Deploy > New deployment > type Web app.
   - Execute as: Me
   - Who has access: Anyone
   Click Deploy and copy the Web app URL (ends in /exec).
5. Put that URL into `API_URL` near the top of `index.html` on the
   multi-user-assignments branch, then merge the branch to publish.

## Logins

- Each person picks their name and types a 4-digit PIN. The first PIN they
  type becomes theirs. Only a salted hash is stored in the agents tab.
- Forgot PIN: in the Apps Script editor, run `resetPin` with their name (edit
  the call or use a one-line wrapper), or clear their pin_hash cell in the
  agents tab. They set a new PIN on their next login.
- Remove someone: set active to FALSE in the agents tab.
- 5 wrong PINs locks that name for 15 minutes.
- Logins last 12 hours.

## How ownership works

- My Leads: leads assigned to you. Pool: unclaimed leads. Admins also get All.
- Claim a pool lead with the Claim button, or just work it: the first save,
  status change or text on a pool lead claims it.
- Nobody can save on a lead someone else owns. Admins can reassign any lead,
  or send it back to the pool, from the lead screen.
- New Landvoice rows arrive with the 4 new columns blank, so they land in Pool.

## Updating the script later

Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
This keeps the same URL, so the dialer needs no change.

## Tests

`node tests/api.test.js` runs the backend against a fake Sheet.
