# Tech stack

## Platform (Cloudflare)

- Workers — runs the app; runtime behaviour pinned by a fixed compatibility date
- Cron Trigger — runs every minute; sends at most one due letter per run, so no run spikes past the free CPU limit
- D1 — letters (text, subject, recipients and file names encrypted), send times, settings
- R2 — photos and videos; private bucket; not encrypted by the app (Cloudflare encrypts at rest)
- Access — login gate in front of the whole app; owner's email only
- Worker secrets — all stored by setup: owner email, sending domain and Resend API key as typed on its page (#173), then encryption key, Access team and audience, R2 account id, bucket name, R2 key id and secret, the setup-done mark
- Static Assets — CSS and browser scripts

## Email

- Resend — sends each letter once, over its HTTPS API; no SDK
- Sending domain — the person's own domain, verified in Resend by hand; its DNS records (SPF, DKIM, bounce MX) go in as DNS-only records, through Resend's "Sign in to Cloudflare" button or by hand; a DMARC record is recommended
- Attachments — Resend fetches each file from a presigned R2 link that expires after 25 hours; every try within Resend's 24 hours for a key reuses the first try's links, so a retry is the same email; links never appear in the email
- Recipients — the owner goes in To and everyone else in BCC; replies go to the owner
- Idempotency key — one per letter, so a retry never sends twice
- Retries — one hour later; a letter Resend refuses as invalid gets one more try, then fails; a letter waiting for its retry never blocks the others
- Bounces — not tracked; a letter is a one-off send
- Failure alert — one email to the owner when Resend refuses a letter for good, with Resend's reason; tried once
- Monthly status email — on the first run of each month in the owner's zone; skipped when there is nothing to report; tried once

## Security

- Letter text — AES-256-GCM with the runtime's built-in Web Crypto
- Access token — verified by the app on every request
- HTML cleaning — in the owner's browser, with its built-in DOMParser; keeps only allowed tags and http, https and mailto links
- Presigned links — signed with AWS Signature Version 4 in the app's own code
- Logs — never contain letter text
- Letter page and exported pages — let no script run
- What this protects and what it does not — [security.md](security.md)

## App code

- TypeScript
- No web framework — hand-written routing; text templates with HTML escaping
- CSS — hand-written, no framework; one stylesheet, also bundled into the Worker as text for the pages shown before login, where Access guards the stylesheet too
- Look — "Sealed letter": paper and serif type, an envelope-and-wax-seal logo, light and dark
- Fonts — Fraunces (headings) and Source Serif 4 (text), served from `public/fonts` under the SIL Open Font License, Latin and Latin Extended; no font service is called
- marked — Markdown to HTML, run in the owner's browser for the preview and on Save; the only package in the running app
- Letter HTML — the browser sends the cleaned HTML on Save; the server encrypts and stores it, and never runs Markdown
- Editor — Markdown, with toolbar buttons that insert the syntax and a preview
- Time zones — send time stored as local date and whole hour plus the IANA zone name; resolved with the built-in Intl data at each check
- Clock changes — a skipped local hour sends at the first moment after the clock change; a repeated local hour sends at its first occurrence
- Time-zone picker — every zone the Workers runtime knows, plus UTC, which its list leaves out; the server refuses any other zone
- Export — one zip built by hand in the owner's browser, with no package and Zip64 on every entry, so any size

## Limits

- Furthest send time — 20 years
- Recipients — 20 per letter, plus the owner
- Files — 25 MB per letter in total
- Letter text — 50,000 characters

## Development tools (never deployed)

- npm — install scripts off; exact versions pinned in the lock file
- Wrangler — local runtime and deploys
- Vitest 5 with @cloudflare/vitest-plugin — tests run in the Workers runtime; the plugin replaced @cloudflare/vitest-pool-workers, which is deprecated
- Playwright — browser tests of the full write-to-send flow
- Biome — code checks and formatting

## CI and repo

- GitHub Actions — type check, Biome, unit tests, browser tests and a vulnerability check on every PR, every push to `dev` and `prod`, and every release tag (`v1.2.3`)
- Releases — tagged; deployed copies only ever update to a tagged release

## Deploy and update

- Install — with a coding agent given the README's prompt, or by hand from the command line: clone, `npm ci`, create D1 and R2 by name, `npm run deploy` (migrations, then deploy); no secret is stored at install
- No Deploy to Cloudflare button (owner, 2026-10-27, #160): Cloudflare's page asks about ten questions, with location hints, preview builds and advanced settings, and no sign it scrolls; it was harder than an agent or a terminal, and we cannot change it
- Setup page — shown on the first visit, at the app's workers.dev address; four steps on one page: save the encryption key (shown once, with a Copy button and an "I have saved it" box), type the owner email and sending domain and paste the Resend API key, paste the Zero Trust team name, and paste a token made from a pre-filled Cloudflare "create token" link
- Team name — pasted by the owner, not read by the app, so the token needs no fifth permission; setup checks the team exists, not that it is the owner's, so a wrong but real team would refuse every login
- Done by the app with that token — checks the token belongs to the app's own account, clears what an earlier stopped try left, creates a narrow R2 key for file links on the bucket the running version uses, creates the Access application for the owner's email, stores the settings as secrets with the setup-done mark last, then deletes the token; the setup page then switches off
- A stop before the settings are stored removes what that try made and deletes the token; the page keeps the same encryption key for the next try
- Restore — if the setup-done mark is missing more than 10 minutes after setup finished, the app was deployed again and lost its settings; the setup page then asks for the saved encryption key instead of showing a new one, accepts only a key that opens the oldest letter, and runs the same steps; within the 10 minutes it says to wait, as the settings may still be reaching Cloudflare's servers
- One setup at a time — a second click while setup runs is refused; a run that never finished stops blocking after five minutes
- Before setup finishes — every page except the setup page is refused
- Manual steps — switch Zero Trust on; switch R2 on; Resend signup, domain and API key
- Agent prompt — in the README; the agent deploys with Wrangler and sends the person to the same setup page
- AGENTS.md — deploy, key replacement and update steps for coding agents
- Updates — the agent, or the person, fetches the tags, checks out the newest release and runs `npm ci` and `npm run deploy` (AGENTS.md); migrations apply first, secrets are kept
- Releases are tagged `v` plus the version in `package.json`; only tags of the form `v1.2.3` are releases, and the public repo's default branch only ever holds a release

## Proven before anything depends on it

- Resend attaching files fetched from presigned R2 links, up to 25 MB in total — proven 2026-10-18: 1, 4 and 20 MB files arrived as attachments in Gmail, no link in the email; the largest single file tested was 20 MB
- Markdown conversion and HTML cleaning in the browser keep the server within the free CPU allowance — proven 2026-10-18
- The pre-filled token link, and the app itself, with that one token, setting its own secrets, creating the R2 key and the Access application, and deleting the token afterwards — proven 2026-10-18 on a real Cloudflare account

## Setup token

- Kind — an account-owned token; the user-level "create tokens" permission cannot be pre-filled in a link
- Link — `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<JSON>&name=timecapsule%20setup`
- Account Settings Read (`account_settings` read) — lists the accounts the token reaches
- Workers Scripts Write (`workers_scripts` edit) — finds the running Worker version and its bucket's name, and stores the secrets
- Account API Tokens Write (`account_api_tokens` edit) — creates the R2 key and deletes the setup token
- Access: Apps and Policies Write (`access` edit) — creates the Access app; `access_acct` is a different permission (organizations, identity providers and groups)
- Own account — the token's account is the one whose Worker versions include the running version id
- R2 key — an account-owned token with "Workers R2 Storage Bucket Item Write" on one bucket; key id is the token id, secret is the SHA-256 hex of its value; refused on other buckets (HTTP 403)
- Deleted token — Cloudflare refuses it right after deletion

## Free CPU limit (measured 2026-10-18)

- The 10 ms is an allowance that refills over time, not a cap on each request; this is observed, not documented
- A single request was refused only past about 1 second of CPU
- Back-to-back requests are refused some of the time: at 11 ms, 2 of 148; at 25 ms, 19 of 150; at 50 ms, 32 of 150
- Server-side Markdown conversion and cleaning of a 50,000-character letter: 11–72 ms typical, up to 176 ms; this is why it runs in the browser
- Browser conversion and cleaning of a 50,000-character letter at slow-phone speed (6× CPU slowdown): 99–135 ms
- Save of the largest letter: 9 ms typical; letters list with 200 letters: 7 ms; open a letter: 3 ms; 25 MB upload: 1 ms
- Sending one letter with 3 files and 20 recipients: 8 ms; working out send times for 200 waiting letters adds about 7 ms
