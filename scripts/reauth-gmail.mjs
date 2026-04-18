import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { google } from 'googleapis';

const credDir = path.join(os.homedir(), '.gmail-mcp');
const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
const tokensPath = path.join(credDir, 'credentials.json');

const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
const cfg = keys.installed || keys.web || keys;
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;

const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, REDIRECT);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
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
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    res.end('Gmail re-auth successful. You can close this tab.');
    console.log('\n✓ Wrote fresh tokens to', tokensPath);
    console.log('  refresh_token present:', !!tokens.refresh_token);
    console.log('  scopes:', tokens.scope);
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.end(`Error: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nOpen this URL in a browser to authorize:\n');
  console.log(authUrl);
  console.log('\nWaiting for callback on', REDIRECT, '...');
});
