/**
 * WebChat Channel for NanoClaw
 * Provides a browser-based chat UI with real-time agent visibility via WebSocket.
 * Serves static HTML and streams SDK events (tool calls, thinking, text) to connected clients.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { WEBCHAT_PORT, WEBCHAT_TOKEN, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const WEBCHAT_JID = 'webchat@web.nanoclaw';
const WEBCHAT_GROUP_FOLDER = 'webchat';
const STREAM_POLL_MS = 100;

interface AuthenticatedWebSocket extends WebSocket {
  authenticated?: boolean;
  groupFolder?: string;
}

export class WebChatChannel implements Channel {
  name = 'webchat';
  private opts: ChannelOpts;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<AuthenticatedWebSocket> = new Set();
  private streamPollers: Map<string, NodeJS.Timeout> = new Map();
  private connected = false;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!WEBCHAT_TOKEN) {
      logger.warn('WEBCHAT_TOKEN not set in .env — webchat channel disabled');
      return;
    }

    const webDir = path.join(process.cwd(), 'web');

    this.server = http.createServer((req, res) => {
      // Serve static files from web/
      const url = req.url === '/' ? '/index.html' : req.url || '/index.html';
      const filePath = path.join(webDir, url);

      // Security: prevent path traversal
      if (!filePath.startsWith(webDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(filePath);
      const contentTypes: Record<string, string> = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': contentTypes[ext] || 'application/octet-stream',
        });
        res.end(data);
      });
    });

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws: AuthenticatedWebSocket) => {
      logger.info('WebChat: new connection, awaiting auth');

      // First message must be auth
      ws.once('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'auth' && msg.token === WEBCHAT_TOKEN) {
            ws.authenticated = true;
            ws.groupFolder = WEBCHAT_GROUP_FOLDER;
            this.clients.add(ws);
            ws.send(JSON.stringify({ type: 'connected' }));
            logger.info('WebChat: client authenticated');

            // Start listening for subsequent messages
            ws.on('message', (data) => this.handleMessage(ws, data.toString()));
            ws.on('close', () => {
              this.clients.delete(ws);
              logger.info('WebChat: client disconnected');
            });
          } else {
            logger.warn('WebChat: auth failed');
            ws.close(4001, 'Unauthorized');
          }
        } catch {
          ws.close(4002, 'Invalid message');
        }
      });

      // Disconnect if no auth within 10 seconds
      setTimeout(() => {
        if (!ws.authenticated) {
          ws.close(4003, 'Auth timeout');
        }
      }, 10000);
    });

    // Auto-register webchat group if not already registered
    const groups = this.opts.registeredGroups();
    if (!groups[WEBCHAT_JID]) {
      this.opts.onChatMetadata(
        WEBCHAT_JID,
        new Date().toISOString(),
        'WebChat',
        'webchat',
        false,
      );
      logger.info('WebChat: auto-registered webchat group');
    }

    this.server.listen(WEBCHAT_PORT, '0.0.0.0', () => {
      this.connected = true;
      logger.info({ port: WEBCHAT_PORT }, 'WebChat channel started');
    });

    // Start polling for stream events
    this.startStreamPoller(WEBCHAT_GROUP_FOLDER);
  }

  private handleMessage(ws: AuthenticatedWebSocket, raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'message' && typeof msg.text === 'string') {
        const text = msg.text.trim();
        if (!text) return;

        const timestamp = new Date().toISOString();
        const messageId = `webchat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Deliver as inbound message (same as WhatsApp would)
        this.opts.onMessage(WEBCHAT_JID, {
          id: messageId,
          chat_jid: WEBCHAT_JID,
          sender: 'user@webchat',
          sender_name: 'User',
          content: text,
          timestamp,
          is_from_me: true,
          is_bot_message: false,
        });

        // Echo back to confirm receipt
        this.broadcast({
          type: 'user_message',
          text,
          timestamp,
        });
      }
    } catch (err) {
      logger.warn({ err }, 'WebChat: failed to parse client message');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (jid !== WEBCHAT_JID) return;
    this.broadcast({ type: 'message', text });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@web.nanoclaw');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const timer of this.streamPollers.values()) {
      clearInterval(timer);
    }
    this.streamPollers.clear();
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (jid !== WEBCHAT_JID) return;
    this.broadcast({ type: 'typing', isTyping });
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN && client.authenticated) {
        client.send(data);
      }
    }
  }

  /**
   * Poll the IPC output directory for stream events written by the agent-runner.
   * Each event is a numbered JSON file that gets read, broadcast to clients, and deleted.
   */
  private startStreamPoller(groupFolder: string): void {
    const outputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'output');

    const poll = () => {
      try {
        if (!fs.existsSync(outputDir)) return;
        const files = fs
          .readdirSync(outputDir)
          .filter((f) => f.endsWith('.json'))
          .sort();

        for (const file of files) {
          const filePath = path.join(outputDir, file);
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            fs.unlinkSync(filePath);
            const event = JSON.parse(content);
            this.broadcast({ type: 'stream', event });
          } catch {
            // File may have been consumed by another reader or is corrupt
            try {
              fs.unlinkSync(filePath);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* output dir may not exist yet */
      }
    };

    const timer = setInterval(poll, STREAM_POLL_MS);
    this.streamPollers.set(groupFolder, timer);
  }
}

// Self-register
registerChannel('webchat', (opts: ChannelOpts) => {
  if (!WEBCHAT_TOKEN) return null;
  return new WebChatChannel(opts);
});
