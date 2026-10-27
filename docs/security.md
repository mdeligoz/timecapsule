# What timecapsule protects, and what it does not

timecapsule keeps your letters on your own Cloudflare account and locks their text with a key only your app holds. It does not protect you from Cloudflare, from anyone who gets into your Cloudflare account or your email, or from the email services that carry a letter once it is sent.

## Protected

- Letter text — encrypted with AES-256-GCM before it is stored, both the text as sent and the Markdown kept for editing
- A letter's subject, recipients' addresses and file names — encrypted the same way
- The key — a Cloudflare secret on your Worker; Cloudflare's dashboard never shows a secret's value once it is stored
- A copy of the database — shows only scrambled letter text, subjects, addresses and file names without the key, including the copies Cloudflare keeps for restoring it
- Login — Cloudflare Access lets in only your email address; the app checks Access's signed login token again on every request and refuses anything else
- Other people on the internet — every page and file is refused without your login; there is no public page once setup is done
- Setup — finishes only with a token made on the app's own Cloudflare account; it then deletes that token and switches itself off
- The storage key — the key the app uses for file links works on its one bucket and nothing else
- Recipients — you are in To and everyone else in BCC, so recipients never see each other's addresses
- A letter's text on screen — the Letter page and the exported pages let no script run, so a letter cannot carry code into your browser
- Logs — never contain letter text
- Other websites — a page on another site cannot make your logged-in browser save, change or delete anything: the app refuses every such request your browser says came from somewhere other than the app's own pages

## Not protected

- Cloudflare itself — the app, its key and your letters all run on Cloudflare, so Cloudflare could read them
- Your Cloudflare account — anyone who gets in can put new code on the Worker that reads the key, and then every letter
- Your email account — by default Access logs you in with a code sent to your email, so anyone who can read your email can log in
- Photos and videos — stored in a private bucket on your account, not encrypted by the app; Cloudflare encrypts all stored data on its side, but holds that key itself
- A letter's send time, file types and sizes, and how many recipients and files it has — stored as they are, so the send job can find the letters that are due without opening each one
- The length of each subject, address and file name — encryption hides the words, not how long they are
- Copies of deleted letters — Cloudflare keeps the database's history for 7 days on the free plan, so a deleted letter stays in it that long, encrypted as it was
- A sent letter — Resend and every recipient's email provider see it in full, as with any email; Resend keeps each email for 30 days
- File links — Resend fetches each file from a signed link that works for 25 hours; anyone who gets hold of the link in that time can fetch the file; the links never appear in the email
- A lost key — letters cannot be opened without it; there is no reset, so save it when setup shows it; after the app is deleted and deployed again, setup accepts only the key that opens the letters, or any well-formed key if there are none

## Reporting a problem

See [SECURITY.md](../SECURITY.md).
