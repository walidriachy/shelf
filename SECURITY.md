# Security

Shelf handles people's tokens (Claude, Replicate, Cloudflare R2, GitHub) and their saved pages, so security reports are very welcome.

**Please don't open a public issue for a security problem.** Report it privately instead: on the repo page go to **Security → Report a vulnerability** (GitHub private vulnerability reporting). Include what you found, how to reproduce it, and what could happen.

You'll get a reply as soon as possible, and credit in the fix if you'd like it.

## What Shelf promises

- Tokens and keys are stored only in `settings.json` on each computer. They are never written to the library folder, never uploaded to backups, and never shown back in full in the app.
- Saved copies and Shelf Pages open with the internet blocked and without Node.js access.
- Share links are signed, time-limited links to a private bucket in your own Cloudflare account; Stop sharing deletes the file.
- Shelf sends link content only to the AI provider and storage you turned on.
