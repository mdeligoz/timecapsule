# Product

## Screens

- Letters — home; Waiting and Sent tabs; sort by writing date or send time; Write a new letter button; every screen has a menu of Letters, Write and Settings
- Write letter — subject, Markdown editor with toolbar and preview (the preview takes the editor's place), send date from the app's own calendar with quick picks of 1, 5, 10 and 20 years, send hour picked from a list (no minutes; hours under 7 days or over 20 years after writing greyed out), time zone, recipients with the owner shown as the first line, files added by button or by dropping them anywhere on the page; also used to edit
- Letter — one letter; waiting: subject and send time, Reveal shows the text; sent: full text and files; Edit and Delete
- Settings — time zone, failure alert on or off, monthly status email on or off, Export, and the running version ("timecapsule v0.1.0") at the foot
- Login — Cloudflare Access's page, not the app's
- Setup page — first visit only; switches off once setup is done; comes back as Restore timecapsule if the app is deployed again and loses its settings, and asks for the saved encryption key

## Letters

- Subject — the email's subject; there is no separate title; defaults to "A letter from" plus the date written, e.g. "A letter from Jan 1st, 2022"; editable; up to 200 characters
- Send time — date and a whole hour plus time zone; at least 7 days and at most 20 years after writing
- Recipients — the owner plus up to 20 others; Save stops on screen with more, counting each address once and never the owner, and the server refuses more
- Recipient addresses — Save refuses, on screen and on the server, an address Resend would refuse (a stray, leading or doubled dot, brackets, a domain not ending in two or more letters) and names it; a domain in other scripts, such as пример.рф, is taken as typed and stored in its coded form (xn--e1afmkfd.xn--p1ai), the only form Resend takes; letters other than Latin before the @ are refused, as Resend refuses them
- Files — up to 25 MB per letter in total; JPG, PNG, GIF, WebP, HEIC, MP4, MOV, PDF; a file that would take the total past 25 MB is refused on screen before it is sent, and the server refuses it too
- Unsaved files — a file added to a letter that is never saved is deleted 7 days and an hour after it was added; a save refuses a file added more than 7 days ago and marks it on the screen
- Text — Markdown, up to 50,000 characters; typing and the toolbar stop there, and the server refuses more
- Editing — subject, text, send time, recipients and files editable for 48 hours after writing, then locked
- Deleting — any time, with a confirm step; removes the letter and its files
- Waiting letters — text hidden until Reveal
- Sent letters — kept and readable with their files until deleted

## Delivery

- Send check — every minute; sends one letter whose send time has passed
- One-off send — bounces are not tracked
- Recipients — the owner goes in To and everyone else in BCC
- Email — sender "Timecapsule" at letters@ the owner's domain; footer "Written on [date], sent with timecapsule", dated in the owner's zone like the subject; replies go to the owner
- Attachments — always attached, never sent as links
- Failure — a letter Resend refuses as invalid twice is marked failed and shown on Letters
- Error or no answer from Resend — the letter stays waiting and is retried an hour later

## Health and data

- Failure alert — email to the owner when a letter fails, with Resend's reason; tried once; can be switched off
- Monthly status email — letters waiting, the next send time (marked late when it has passed and the letter is still being tried) and letters not sent until deleted, on the first run of each month in the owner's zone; skipped when there is nothing to report; the first one goes on the 1st after install or after switching it on; tried once; can be switched off
- Export — one zip, built in the browser, with a folder per letter (written date and subject): the letter as a web page, the text as sent with its details, plus its files; waiting letters' text included; any size; no import

## Owner

- One owner per install; no accounts
- Owner email — from the Access login
- Time zone — from the browser, changeable in Settings
