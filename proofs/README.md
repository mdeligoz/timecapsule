# Proofs

Three small programs, each run once on 2026-10-18 before the app was built, to check that a risky part of the design works on the real services. They are frozen: the app does not use their code, and they no longer run in CI. The facts they found are in [docs/tech-stack.md](../docs/tech-stack.md).

## resend-attach

- Question — can Resend attach a letter's files by fetching them from signed links to a private R2 bucket, so the files never pass through the Worker?
- How — `npm run send` uploads a 1, 4 and 20 MB file (25 MB, the per-letter limit), signs a link to each, and asks Resend to send one email with them attached
- Answer — yes; all three arrived as attachments in Gmail, with no link in the email
- Kept — Resend's real accepted and refused answers, in `fixtures/`; the app's send tests use copies of them

## cpu-limit

- Question — does the app fit the free plan's 10 ms of CPU per request?
- How — a cut-down app deployed as a Worker; CPU time per request read from `wrangler tail`, 30–50 requests per measurement
- Answer — yes, if letters are turned into HTML in the browser; on the server, a 50,000-character letter took 11–72 ms, up to 176 ms
- Also found — the 10 ms is an allowance that refills over time, not a cap on each request; the numbers are in docs/tech-stack.md, under "Free CPU limit"

## token-setup

- Question — can one token, made from a pre-filled Cloudflare link, let the app set itself up: store its secrets, create its storage key and its login, then delete the token?
- How — a Worker on a real Cloudflare account, run through the whole setup with a real token
- Answer — yes; the four permissions it needs and how the storage key is made are in docs/tech-stack.md, under "Setup token"

## Running them

Each folder has its own `package.json`; `npm install` then `npm test` runs its tests. Running them against the real services needs your own Cloudflare account, given to `npm run send` in `resend-attach` through environment variables along with a Resend key, and to the other two by deploying them with Wrangler.
