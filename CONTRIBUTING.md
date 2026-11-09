# Contributing to Shelf

Thanks for helping. Shelf is a small Electron app with no framework and no build step for the code, so it's quick to get into.

## Ways to help

- **Report a bug or ask for something:** open an [issue](https://github.com/walidriachy/shelf/issues). Say what you did, what you expected and what happened, plus your OS (Mac/Windows and version). Screenshots help. Never paste tokens, keys or private links.
- **Pick something from the [roadmap](ROADMAP.md):** items marked **help wanted** are good first picks. Comment on (or open) an issue first so two people don't build the same thing.
- **Test on Windows** or with a real Cloudflare R2 account and report what you find. That alone is very useful.

## Working on the code

### If you're not a collaborator (most people)

1. **Fork** the repo on GitHub (button at the top right), then clone your fork:
   ```bash
   git clone https://github.com/<you>/shelf.git
   cd shelf
   npm install
   npm start
   ```
2. Make a branch: `git checkout -b fix/short-description` (or `feature/…`).
3. Make your change, try it in the app (see *Testing* below), commit with a clear message.
4. Push to your fork and open a **pull request** against `main`. Describe what changed, why, and how you tested it. Add a screenshot for anything visible.
5. The maintainer reviews it. Small fixes are usually merged quickly; bigger ones may get questions or change requests first.

### If you've been added as a collaborator

The maintainer can add people under **Settings → Collaborators** on GitHub (or `gh api -X PUT repos/walidriachy/shelf/collaborators/<username>`). Collaborators clone the main repo directly, but still:

- work on a branch, never directly on `main`;
- open a pull request and get one review before merging;
- don't publish releases or change repo settings without agreeing with the maintainer.

## How the code is laid out

| File | What it does |
| --- | --- |
| `src/main.js` | The app: windows, the link queue (read → analyse → save), IPC handlers, sync scheduling, the local bridge for the Chrome extension, Shelf Page windows, sharing. |
| `src/store.js` | The library on disk: one JSON file per link in `links/`, `categories.json`, saved copies in `archive/<id>/`. Atomic writes; deleted links leave a small "tombstone" so deletes sync. |
| `src/library.js` | Finding iCloud Drive / Google Drive / Dropbox / OneDrive folders, and moving/merging libraries. |
| `src/reader.js` | Reads a link: renders web pages in a hidden window, exports Google files, downloads PDFs, reads YouTube videos (details, chapters, transcript). |
| `src/notion.js` | Captures a Notion page's real structure and rebuilds it as a Shelf Page (static HTML + `shelf-page.css`). |
| `src/page-preload.js` | The editor inside a Shelf Page window (Edit / Save / Reset, toolbar, Export / Share). |
| `src/share.js` | Bundles a Shelf Page into one self-contained HTML file. |
| `src/ai.js`, `src/claude.js` | AI analysis and Ask, through the Claude Code CLI or Replicate. |
| `src/r2.js` | Cloudflare R2: hand-written AWS SigV4 signing, backup/sync, one-token connect, signed share links. |
| `src/sync.js` | GitHub Gist backup. |
| `src/renderer/` | The main window (plain HTML/CSS/JS). |
| `extension/` | The Chrome extension. |

## Rules that keep Shelf safe

- **Never commit secrets or personal data.** Tokens and keys only ever live in `settings.json` in the user-data folder, never in the repo, never in the library folder, never in the cloud. If you add a setting that holds a secret, keep it there and leave it out of `publicSettings()` in `main.js`.
- Anything shown from a saved page runs with the **internet blocked** and no Node access (see `openCopy` and `openShelfPage`). Keep it that way.
- Generated HTML must only allow `http(s)` and `mailto` links (`safe()` in `notion.js`); saved edits are cleaned of scripts and `on*` attributes.
- Don't add telemetry or send user content anywhere except the AI provider and storage the user chose.
- Keep dependencies to a minimum.

## Testing

There's no automated test suite yet (it's on the roadmap, and very welcome). Until then, please test by hand and say how in your PR. Useful helpers:

- `SHELF_DATA=/tmp/shelf-test npm start`: use a separate, throwaway data folder so you don't touch your real library.
- `SHELF_SNAPSHOT=/tmp/shot.png SHELF_SNAPSHOT_DELAY=6000 SHELF_SNAPSHOT_JS="…"`: screenshot the main window after a delay, optionally running some JavaScript first.
- `SHELF_TEST_PAGE=<folder containing steps.json>`: opens the first Shelf Page, runs each step's JavaScript, writes screenshots and a `result.txt`, then quits.

Only one copy of Shelf can run at a time. Quit the installed app before starting a dev copy.

## Style

- Plain modern JavaScript (CommonJS in the main process), 2-space indent, no semicolon debates; match the file you're in.
- Comments explain *why*, in plain words.
- UI text is short and plain: say what happens, no jargon.

## License

By contributing, you agree that your contribution is released under the project's [MIT License](LICENSE).
