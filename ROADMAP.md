# Roadmap

Where Shelf is, and what's left. Items marked **(help wanted)** are good places to start contributing; open an issue before starting anything large so work isn't duplicated.

## Done in 1.0

- Save links from the app, the clipboard shortcut and the Chrome extension.
- AI reads every link and writes a title, category (creating new ones when needed), tags, summary, key points and full notes. Runs on your own Claude subscription through Claude Code, or a Replicate token, or keywords only.
- Exact offline copies: page snapshots, screenshots, original PDFs, Google Docs/Sheets/Slides exports.
- **Shelf Pages**: Notion pages, Google Docs, Word files, PDFs and Google Slides rebuilt as Shelf's own editable pages (Notion with sub-pages and databases). Editable, with "your version" and Reset to original.
- **Share**: export a Shelf Page as one self-contained HTML file, or as a 7-day signed link through your Cloudflare R2.
- **YouTube**: title, chapters, description and full transcript; AI notes with timestamps.
- **Connected links**: tie a video to the PDF, Notion page or Drive file that explains it.
- **Ask**: answers from what you saved, including the full text of every copy.
- Library in iCloud Drive, Google Drive, Dropbox, OneDrive or any folder; backup to Cloudflare R2 (10 GB free) and GitHub Gist.

## 1. Before handing it to other people

These matter most if Shelf is going to be used by anyone else.

- [ ] **Sign and notarize the Mac app** so it opens without the "can't be opened" warning. Needs an Apple Developer account ($99/year). Then turn on notarization in `electron-builder`.
- [ ] **Sign the Windows installer** so SmartScreen doesn't warn (code-signing certificate, or Azure Trusted Signing).
- [ ] **Publish downloads on GitHub Releases**, built by GitHub Actions for Mac (arm64 + Intel) and Windows on every version tag. **(help wanted)**
- [ ] **Auto-update** with `electron-updater` reading GitHub Releases.
- [ ] **Test on a real Windows PC**: install, library in OneDrive/Google Drive, the clipboard shortcut, Shelf Pages, sharing. **(help wanted)**
- [ ] **Test Cloudflare R2 with a real account**: one-token connect (confirm the token page's permission key), first backup, restore on a second computer, share links opening in Safari/Chrome/phones.
- [ ] **Test GitHub Gist backup** end to end.
- [ ] **Automated tests**: SigV4 signing (AWS test vectors), Notion rendering against saved `page.json` fixtures, the share bundle, store merge rules, YouTube caption parsing. Run them in CI. **(help wanted)**
- [ ] **Publish the Chrome extension** on the Chrome Web Store instead of "Load unpacked".

## 2. Sharing

- [ ] Links that don't expire: optional public bucket (r2.dev or your own domain) or a tiny Cloudflare Worker that serves `share/…` files.
- [ ] Optional password or "anyone with the link until I stop it" per share.
- [ ] A list of everything you've shared, with expiry dates, in Settings.
- [ ] Export as PDF and as Markdown (for importing into Obsidian, Notion, etc.).
- [ ] Share any saved link's notes and copy, not only Shelf Pages.

## 3. Shelf Pages

- [ ] PDFs: detect tables and multi-column layouts; keep figures as pictures in the text, not only in *Original pages*.
- [ ] Google Sheets as a Shelf Page (an editable table per tab).
- [ ] Word: keep text colours (the converter drops them today).

- [ ] Calendar and timeline database views (shown as tables today).
- [ ] Formulas and rollups computed, not only their saved values.
- [ ] Editing inside databases (add/edit rows and properties).
- [ ] Slash menu ("/" to insert blocks) and drag to reorder blocks.
- [ ] "Update from Notion" that pulls the latest page and keeps your edits where possible.
- [ ] Optional: send your edited version back to your own Notion (for people who use Notion).
- [ ] More than 40 sub-pages / 300 rows per database, with a progress bar.

## 4. Reading more kinds of links

- [ ] YouTube playlists and channels (save each video, connected together).
- [ ] Videos without captions: optional local transcription (Whisper) so the AI still understands them.
- [ ] Other video sites: Vimeo, Loom, TikTok, Instagram Reels.
- [ ] X/Twitter threads, Reddit threads, GitHub repositories (README, stars, language), Figma community files.
- [ ] Private Notion pages and Google files: clearer "sign in to read this" flow right on the card.
- [ ] YouTube and Notion are read through their web pages, not official APIs. If either changes, reading can break: keep an eye on it and fix quickly. **(help wanted)**

## 5. Organizing and finding

- [ ] AI suggests connections ("this PDF looks like the guide for that video").
- [ ] Collections / boards you arrange yourself, and read / to-do status.
- [ ] Ask with follow-up questions, and answers that cite the exact part of the saved copy (or the video timestamp).
- [ ] Offline semantic search (local embeddings) so Ask works well without AI turned on.

## 6. Sync and safety

- [ ] Optional end-to-end encryption of the R2 backup (a passphrase only you know).
- [ ] Field-by-field merge when the same link is edited on two computers at once (today the newest change wins).
- [ ] Clearer "backup health" in Settings: last backup, size used of the free 10 GB, errors.

## 7. Everywhere else

- [ ] Firefox, Edge and Safari extensions.
- [ ] A phone companion (iOS share sheet / Android share) that drops links into the same library.
- [ ] Accessibility pass (keyboard navigation everywhere, screen reader labels) and translations.
