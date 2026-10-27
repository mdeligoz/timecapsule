# AGENTS.md

Steps for a coding agent that installs, updates or looks after a person's copy of timecapsule. It needs Node.js 24 or newer and git. After the clone in Install step 1, run every command from the repository's folder.

## Rules

- Never ask the person to paste a secret into the chat. Secrets go into a file or a Wrangler prompt that the person fills in themselves.
- Never change the `LETTER_KEY` secret to a new value. Letters locked with the old key can no longer be opened.
- Do not edit `wrangler.jsonc`. Wrangler finds the database and the bucket by their names, `timecapsule`.
- Install scripts stay off (`.npmrc`). Do not run `npm install`; use `npm ci`.

## Install

Before you start, the person has done the Get ready steps of the README's Install section: Zero Trust and R2 switched on, a domain verified at Resend, and a Resend API key with sending access.

1. Clone the repository and install its packages:

   ```sh
   git clone https://github.com/mdeligoz/timecapsule.git
   cd timecapsule
   npm ci
   ```

2. Check whether Wrangler is already logged in to the person's Cloudflare account:

   ```sh
   npx wrangler whoami
   ```

   If it names their account, go on; a warning about missing permissions does not stop the steps below. If it is not logged in, log in. A browser opens; the person approves.

   ```sh
   npx wrangler login
   ```

3. Make the database and the storage bucket. `CI=true` stops Wrangler from editing `wrangler.jsonc`.

   ```sh
   CI=true npx wrangler d1 create timecapsule
   CI=true npx wrangler r2 bucket create timecapsule
   ```

4. Deploy. This applies the database migrations, then deploys. In a terminal, Wrangler asks before it changes the database, and the answer is yes; run without a terminal, it answers yes by itself. Note the workers.dev address it prints.

   ```sh
   npm run deploy
   ```

5. Send the person to the workers.dev address from step 4. The setup page asks them to save the encryption key, type their email address and sending domain, paste their Resend API key, paste their Zero Trust team name, and create and paste a setup token. Setup stores all of it. Nothing more is needed from you, and no secret goes through you.

## Update

Updates only ever go to a release: a tag of the form `v1.2.3`. Tags such as `v0.2.0-rc1` are not releases. This prints the latest release:

```sh
git fetch --tags
git tag --list --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1
```

The AGENTS.md on disk is the installed release's. Read this section from the latest release before you go on, as its steps may have changed:

```sh
git show <tag>:AGENTS.md
```

Check for changes the person made. `git status` shows edits not yet committed; the second command lists commits they made that are in no release. If either shows anything, stop and ask them what to keep before you go on.

```sh
git status
git log --oneline HEAD --not --remotes --tags
```

Check out the latest release, install and deploy. Checking out a tag leaves the copy off any branch; git's warning about it is expected, and the copy stays on the tag.

```sh
git checkout <tag>
npm ci
npm run deploy
```

`npm run deploy` applies any new database migrations before it deploys, as in Install step 4. Secrets are kept. If Wrangler says an update of Wrangler itself is available, leave it: `npm ci` keeps the versions this release was tested with.

Last, ask the person to open Settings: the line at the foot reads `timecapsule v` and the new version.

## Replace the Resend API key

The person makes a new key in Resend, with sending access. Ask them to run this themselves and paste the key at Wrangler's prompt:

```sh
npx wrangler secret put RESEND_API_KEY
```

Then they delete the old key in Resend.

## Change the sending domain

The new domain must be verified at Resend first. Then:

```sh
npx wrangler secret put SEND_DOMAIN
```

## The app was deleted and deployed again

If the Worker was deleted while its database stayed, every secret is gone and the letters cannot be opened until the app is restored. Do not make a new database or bucket: the letters and files are in the old ones.

1. Do Install step 4: deploy.
2. Send the person to the workers.dev address. The setup page now says Restore timecapsule. It asks them to paste the encryption key they saved during setup, type their email address and sending domain, paste their Resend API key and their Zero Trust team name, and create and paste a setup token. It only accepts the key that opens their letters; with no letters, it accepts any well-formed key. Setup does the rest.

## Restore the encryption key

Only if the app's `LETTER_KEY` secret was deleted or overwritten by mistake, and the app is otherwise running. Ask the person to run this themselves and paste the key they saved during setup, exactly as saved:

```sh
npx wrangler secret put LETTER_KEY
```

Never make up a new key: letters locked with the old one cannot be opened with it.
