# Decisions

Each choice made while planning timecapsule, why, and what was turned down.

## Your own Cloudflare account, on the free plan

- Decided — each person deploys their own copy on their own Cloudflare account; it must fit the free plan
- Why — privacy means owning where the letters live; nobody else runs a server in between
- Rejected — a hosted service; Cloudflare's $5 Workers plan; a regular server app, kept only as the fallback had the free plan not fit

## Letter text and details encrypted, files not

- Decided — letter text is encrypted with AES-256-GCM and a key held as a Worker secret; photos and videos sit in a private R2 bucket, not encrypted by the app
- Why — the text is the private part; files must stay as they are so Resend can fetch them by link
- Decided with it (2026-10-23) — the subject, each recipient's address and each file name are encrypted too; a subject like "To Emma on her wedding day" is as private as the text
- Not encrypted — the send time, because the send job must find due letters without opening each one
- Accepted — this does not protect against Cloudflare itself; the README and [security.md](security.md) say so

## Login with Cloudflare Access

- Decided — Access lets in only the owner's email; the app also verifies Access's signed token on every request
- Why — checking the token means a request that gets past Access some other way is still refused
- Rejected — the app's own login; trusting the email header Access adds

## Install with an agent or the command line, then one setup page

- Decided — switch Zero Trust and R2 on, install with a coding agent or from the command line, then one setup page: save the encryption key, type the owner email and sending domain and paste the Resend key, paste the Zero Trust team name, paste a token made from a pre-filled link
- Why — as few steps as possible; the pasted token proves the person owns the account, and the app makes its own storage key and login with it, then deletes it
- Rejected — a setup script; making keys or picking permissions by hand; Cloudflare's public OAuth clients, which need a hosted, verified app forever; a fifth token permission to read the team name
- Rejected (2026-10-27, #160) — the Deploy to Cloudflare button; its page was harder than an agent or a terminal (see Updates from tagged releases)
- Decided (2026-10-27, #173) — the owner email, sending domain and Resend key are asked on the setup page, not stored at install; they were at install only because the Deploy button asked for them. Everything the person types is on one page, and no secret goes through an agent
- Accepted — a wrong but real team name refuses every login; the page says to copy it from the dashboard

## Email through Resend, files fetched by link

- Decided — Resend sends each letter; it fetches the files from signed R2 links that work for 25 hours and never appear in the email
- Why — building a 25 MB email inside the Worker took 50–60 ms of CPU on a local test run, and the free plan allows 10 ms
- Rejected — Cloudflare Email Sending, which on the free plan reaches only verified addresses; sending files as links

## Markdown turned into HTML in the owner's browser

- Decided — the browser converts and cleans the letter on Save; the server encrypts and stores the finished HTML and never runs Markdown
- Why — on the server, a 50,000-character letter took 11–72 ms, up to 176 ms, far past the free CPU allowance
- Accepted — a letter's HTML is only as clean as the browser made it; the Letter page lets no script run

## One letter per minute

- Decided — a check runs every minute and sends at most one due letter; five letters due at 9:00 go out from 9:00 to 9:04
- Why — no single run goes past the free CPU allowance
- Decided with it — a failed send is tried again an hour later without holding up the others; a letter Resend refuses as invalid twice is marked failed; bounces are not tracked

## Send time is a date and a whole hour

- Decided — a date, an hour picked from a list, and a time zone; no minutes
- Why — a letter to the future is about the day, not the minute; a short list of hours keeps the picker simple
- Decided with it — the zone's rules are applied at each check, so a later change to them is followed; a skipped hour sends when the clock jumps; a repeated hour sends at its first occurrence

## Limits

- Decided — 50,000 characters of text; 25 MB of files per letter; the owner plus 20 recipients; at least 7 days and up to 20 years ahead; editable for 48 hours after writing
- Why 7 days — a letter sent tomorrow is not a time capsule
- Why 48 hours — a sealed letter should not keep changing; two days is room to fix a mistake
- Decided with it — every limit stops the input on screen and is also refused by the server

## No separate title

- Decided — what the owner writes at the top is the email's subject, up to 200 characters

## Refuse requests from other websites

- Decided — every request that saves, changes or deletes something is refused unless the browser says it came from the app's own pages
- Why — Access's login does not stop this: a page on another site sends the request from the owner's own logged-in browser, so Access lets it through
- Replaces — an earlier call to have no guard, on the grounds that Access's login was the gate (reversed 2026-10-23)

## Health emails and Export

- Decided — an email to the owner when a letter fails for good; a monthly status email; one zip export built in the browser, any size, with no import

## Updates from tagged releases

- Decided — a copy updates by checking out the latest release, tagged `v` plus the version, and deploying it, by the agent or by hand (AGENTS.md); the public repo's default branch only ever holds a release
- Why — it ends with the same `npm run deploy` as the install, which applies database changes first; nothing runs in the person's GitHub
- Rejected (2026-10-27, #160) — the Deploy to Cloudflare button with an Update workflow in the copy it makes. Cloudflare's Deploy page asks about ten questions (resource names, location hints, preview builds, advanced settings), gives no sign it scrolls, and lets a newcomer break things; it was harder than an agent or a terminal, and we cannot change it. The update workflow existed only for copies the button made

## Recovery with the saved key

- Decided — the encryption key saved at setup must be enough to get the letters back after the app is deleted and deployed again
- Why — the database can outlive the Worker; the key is the one thing the owner is told to keep
- Decided with it — the setup page comes back as Restore timecapsule, takes the saved key, and accepts only a key that opens the letters, or any well-formed key if there are none

## Plain code, one package

- Decided — TypeScript with no web framework and hand-written CSS; marked, in the browser, is the only package in the running app
- Why — every package is someone else's code running beside private letters, and each one has to be trusted and kept up to date; the app is small enough to do without them
- Accepted — the login check, the signed file links, the time-zone maths, the HTML cleaner, the zip export and the date picker are written by hand; the first three are tested against outside references (a token Access really issued, AWS's published signing example, the runtime's time-zone data) and the zip is opened by the system's own unzip
