import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

const credDir = path.join(os.homedir(), '.spotify-mcp');
fs.mkdirSync(credDir, { recursive: true });
const configPath = path.join(credDir, 'spotify-config.json');

if (!fs.existsSync(configPath)) {
  console.error(`Missing ${configPath}.`);
  console.error('Create it first with your Spotify dev app credentials:');
  console.error(JSON.stringify({
    clientId: 'YOUR_CLIENT_ID',
    clientSecret: 'YOUR_CLIENT_SECRET',
    redirectUri: 'http://127.0.0.1:8888/callback',
  }, null, 2));
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
if (!config.clientId || !config.clientSecret) {
  console.error('clientId and clientSecret must be set in', configPath);
  process.exit(1);
}
const REDIRECT_URI = config.redirectUri || 'http://127.0.0.1:8888/callback';
const PORT = new URL(REDIRECT_URI).port || '8888';

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-position',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'streaming',
];

const state = crypto.randomBytes(16).toString('hex');
const authUrl = new URL('https://accounts.spotify.com/authorize');
authUrl.searchParams.set('client_id', config.clientId);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('show_dialog', 'true');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    if (!url.pathname.startsWith('/callback')) {
      res.end('Ready.');
      return;
    }
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const err = url.searchParams.get('error');
    if (err) {
      res.end(`OAuth error: ${err}. You can close this tab.`);
      console.error('OAuth error:', err);
      process.exit(1);
    }
    if (returnedState !== state) {
      res.end('State mismatch — possible CSRF. Aborting.');
      console.error('State mismatch');
      process.exit(1);
    }
    if (!code) {
      res.end('Waiting for OAuth callback...');
      return;
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      res.end(`Token exchange failed: ${text}`);
      console.error('Token exchange failed:', tokenRes.status, text);
      process.exit(1);
    }
    const tokens = await tokenRes.json();

    const updated = {
      ...config,
      redirectUri: REDIRECT_URI,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
    res.end('Spotify auth successful. You can close this tab.');
    console.log('\n✓ Wrote tokens to', configPath);
    console.log('  scopes:', tokens.scope);
    console.log('  expires in:', tokens.expires_in, 'seconds');
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.end(`Error: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
});

server.listen(Number(PORT), () => {
  console.log('\nOpen this URL in a browser to authorize Claw for Spotify:\n');
  console.log(authUrl.toString());
  console.log(`\nWaiting for callback on ${REDIRECT_URI} ...`);
});
