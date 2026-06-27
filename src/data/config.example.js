// DLTA adapter config — COPY this file to config.js and fill in real values.
//
//   cp src/data/config.example.js src/data/config.js
//
// config.js is gitignored so the Espo key is never committed. Load it BEFORE
// adapter.js in index.html so window.DLTA_CONFIG exists when the adapter reads it:
//
//   <script src="src/data/config.js"></script>
//   <script type="module" src="src/data/adapter.js"></script>
//
// SECURITY: this is a static client-side app, so whatever you put here ships to
// the browser. For an internal tool behind the Cloudflare tunnel that is fine.
// To avoid exposing the key, point ESPO_BASE_URL at a thin relay instead of Espo
// directly; the adapter does not care which it is talking to.

window.DLTA_CONFIG = {
  ESPO_BASE_URL: 'https://crm.dltaleads.com',

  // Auth: 'apikey' sends X-Api-Key; 'basic' sends username + password.
  ESPO_AUTH_MODE: 'apikey',

  // For ESPO_AUTH_MODE = 'apikey' (Espo Admin > API Users > the API key):
  ESPO_API_KEY: 'PUT_YOUR_ESPO_API_KEY_HERE',

  // For ESPO_AUTH_MODE = 'basic' instead:
  ESPO_BASIC_USER: '',
  ESPO_BASIC_PASS: ''
};
