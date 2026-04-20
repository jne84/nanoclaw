import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { google } from 'googleapis';

const credDir = path.join(os.homedir(), '.tasks-mcp');
fs.mkdirSync(credDir, { recursive: true });
const keysPath = path.join(credDir, 'oauth.keys.json');
const tokensPath = path.join(credDir, 'tokens.json');
const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
const cfg = keys.installed || keys.web || keys;
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;

const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, REDIRECT);

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/tasks.readonly',
];

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
  hd: 'eksponent.com',
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) {
      res.end(`OAuth error: ${err}. You can close this tab.`);
      console.error('OAuth error:', err);
      process.exit(1);
    }
    if (!code) {
      res.end('Waiting for OAuth callback...');
      return;
    }
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    res.end('Auth successful. You can close this tab.');

    const idToken = tokens.id_token;
    let email = '(unknown)';
    if (idToken) {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());
      email = payload.email;
      console.log('\nAuthenticated as:', email, '(hd:', payload.hd || 'none', ')');
    }

    const tasks = google.tasks({ version: 'v1', auth: oauth2 });
    const lists = await tasks.tasklists.list({ maxResults: 50 });
    const items = lists.data.items || [];
    console.log(`\nFound ${items.length} task list(s):`);
    for (const l of items) {
      console.log(`  - ${l.title} (id: ${l.id})`);
      try {
        const t = await tasks.tasks.list({ tasklist: l.id, maxResults: 5, showCompleted: false });
        const count = (t.data.items || []).length;
        console.log(`      ${count} open task(s)${count ? ':' : ''}`);
        for (const task of t.data.items || []) {
          console.log(`      • ${task.title}${task.due ? ` (due ${task.due})` : ''}`);
        }
      } catch (e) {
        console.log('      (failed to list tasks:', e.message, ')');
      }
    }

    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    console.log('\nTokens saved to', tokensPath);
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.end(`Error: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nOpen this URL in a browser (make sure to pick josef.neman@eksponent.com):\n');
  console.log(authUrl);
  console.log('\nWaiting for callback on', REDIRECT, '...');
});
