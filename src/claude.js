// Uses the Claude Code app installed on this computer, so Shelf runs on your own Claude subscription.
// Optional: paste a token from `claude setup-token` to use a specific account.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
let cached;

function candidates() {
  const home = os.homedir();
  if (isWin) {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(local, 'Programs', 'claude', 'claude.exe'),
      path.join(appdata, 'npm', 'claude.cmd'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
  ];
}

// Apps opened from the Dock or Start menu don't see your terminal's PATH, so look in the usual places.
function findClaude() {
  if (cached !== undefined) return cached;
  cached = candidates().find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  if (!cached) {
    try {
      const out = isWin
        ? execFileSync('where', ['claude'], { encoding: 'utf8', timeout: 5000 })
        : execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 8000 });
      const p = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (p && fs.existsSync(p)) cached = p;
    } catch { /* not installed */ }
  }
  return cached;
}

function runClaude(settings, system, prompt) {
  const bin = findClaude();
  if (!bin) return Promise.reject(new Error('Claude Code is not installed on this computer'));
  const args = [
    '-p', '--output-format', 'text',
    '--model', (settings.claudeModel || 'haiku').trim(),
    '--system-prompt', system,
    '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
  ];
  const env = { ...process.env, PATH: [path.dirname(bin), process.env.PATH || '', isWin ? '' : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'].filter(Boolean).join(path.delimiter) };
  if (settings.claudeToken) env.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeToken;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env, shell: isWin && bin.endsWith('.cmd'), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude took too long')); }, 300000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) return resolve(out);
      const msg = (err || out).trim().split('\n').pop() || `Claude exited with code ${code}`;
      if (/expired|could not be refreshed/i.test(msg)) return reject(new Error('Claude’s sign-in on this computer has expired. Run "claude setup-token" in Terminal and paste the token in Settings (it lasts a year). Shelf finishes these links by itself once Claude works again.'));
      reject(new Error(/not logged in|login|authenticat|401/i.test(msg) ? 'Claude is not signed in on this computer. Run "claude setup-token" in Terminal and paste the token in Settings (it lasts a year). Shelf finishes these links by itself once Claude works again.' : msg));
    });
    child.stdin.end(prompt);
  });
}

module.exports = { findClaude, runClaude };
