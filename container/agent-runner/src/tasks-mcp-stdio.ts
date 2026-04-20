/**
 * Stdio MCP Server for Google Tasks
 * Reads OAuth client + tokens from /home/node/.tasks-mcp/
 * Exposes read+write tools against the Google Tasks API.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const CRED_DIR = process.env.TASKS_MCP_DIR || '/home/node/.tasks-mcp';
const KEYS_PATH = path.join(CRED_DIR, 'oauth.keys.json');
const TOKENS_PATH = path.join(CRED_DIR, 'tokens.json');

type OAuthKeys = {
  client_id: string;
  client_secret: string;
};

type Tokens = {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
};

function loadKeys(): OAuthKeys {
  const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  const k = raw.installed || raw.web || raw;
  if (!k.client_id || !k.client_secret) {
    throw new Error(`Invalid OAuth keys at ${KEYS_PATH}`);
  }
  return { client_id: k.client_id, client_secret: k.client_secret };
}

function loadTokens(): Tokens {
  const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
  if (!raw.refresh_token) {
    throw new Error(`No refresh_token in ${TOKENS_PATH} — run the auth script`);
  }
  return raw;
}

function saveTokens(tokens: Tokens): void {
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  } catch {
    // mount may be read-only — fine, we'll just refresh again next call
  }
}

let cachedAccessToken: string | undefined;
let cachedExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && cachedExpiresAt > now + 60_000) {
    return cachedAccessToken;
  }
  const keys = loadKeys();
  const tokens = loadTokens();
  const body = new URLSearchParams({
    client_id: keys.client_id,
    client_secret: keys.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedExpiresAt = now + data.expires_in * 1000;
  saveTokens({ ...tokens, access_token: data.access_token, expiry_date: cachedExpiresAt });
  return cachedAccessToken;
}

async function api<T = unknown>(
  method: string,
  pathAndQuery: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://tasks.googleapis.com/tasks/v1${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Tasks API ${method} ${pathAndQuery} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function textResult(obj: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({
  name: 'tasks',
  version: '1.0.0',
});

server.tool(
  'list_tasklists',
  'List all Google Task lists (names + IDs). Use this first to discover which list to read/write.',
  {},
  async () => {
    const data = await api<{ items?: { id: string; title: string }[] }>('GET', '/users/@me/lists');
    const items = data.items || [];
    return textResult(items.map((l) => ({ id: l.id, title: l.title })));
  },
);

server.tool(
  'list_tasks',
  'List tasks in a specific task list. By default hides completed tasks. Returns title, due date, notes, status, id.',
  {
    tasklist_id: z.string().describe('The ID of the task list (get via list_tasklists)'),
    show_completed: z.boolean().optional().describe('Include completed tasks (default false)'),
    show_hidden: z.boolean().optional().describe('Include hidden tasks (default false)'),
    due_min: z.string().optional().describe('RFC3339 lower bound on due date (e.g. 2026-04-20T00:00:00Z)'),
    due_max: z.string().optional().describe('RFC3339 upper bound on due date'),
  },
  async (args) => {
    const params = new URLSearchParams();
    params.set('showCompleted', String(args.show_completed ?? false));
    params.set('showHidden', String(args.show_hidden ?? false));
    params.set('maxResults', '100');
    if (args.due_min) params.set('dueMin', args.due_min);
    if (args.due_max) params.set('dueMax', args.due_max);
    const data = await api<{ items?: Array<Record<string, unknown>> }>(
      'GET',
      `/lists/${encodeURIComponent(args.tasklist_id)}/tasks?${params}`,
    );
    const items = (data.items || []).map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes,
      due: t.due,
      status: t.status,
      completed: t.completed,
      updated: t.updated,
    }));
    return textResult(items);
  },
);

server.tool(
  'create_task',
  'Create a new task. Returns the created task with its ID.',
  {
    tasklist_id: z.string().describe('ID of the task list to add to'),
    title: z.string().describe('Task title (what needs to be done)'),
    notes: z.string().optional().describe('Optional longer notes/description'),
    due: z.string().optional().describe('RFC3339 due date (e.g. 2026-04-25T00:00:00Z). Google Tasks only stores the date portion.'),
  },
  async (args) => {
    const body: Record<string, unknown> = { title: args.title };
    if (args.notes) body.notes = args.notes;
    if (args.due) body.due = args.due;
    const task = await api(
      'POST',
      `/lists/${encodeURIComponent(args.tasklist_id)}/tasks`,
      body,
    );
    return textResult(task);
  },
);

server.tool(
  'update_task',
  'Update an existing task. Provide the fields you want to change; omit others.',
  {
    tasklist_id: z.string(),
    task_id: z.string(),
    title: z.string().optional(),
    notes: z.string().optional(),
    due: z.string().optional().describe('RFC3339 due date'),
    status: z.enum(['needsAction', 'completed']).optional(),
  },
  async (args) => {
    const body: Record<string, unknown> = { id: args.task_id };
    if (args.title !== undefined) body.title = args.title;
    if (args.notes !== undefined) body.notes = args.notes;
    if (args.due !== undefined) body.due = args.due;
    if (args.status !== undefined) body.status = args.status;
    const task = await api(
      'PATCH',
      `/lists/${encodeURIComponent(args.tasklist_id)}/tasks/${encodeURIComponent(args.task_id)}`,
      body,
    );
    return textResult(task);
  },
);

server.tool(
  'complete_task',
  'Mark a task as completed. Convenience wrapper over update_task with status=completed.',
  {
    tasklist_id: z.string(),
    task_id: z.string(),
  },
  async (args) => {
    const task = await api(
      'PATCH',
      `/lists/${encodeURIComponent(args.tasklist_id)}/tasks/${encodeURIComponent(args.task_id)}`,
      { id: args.task_id, status: 'completed' },
    );
    return textResult(task);
  },
);

server.tool(
  'delete_task',
  'Delete a task permanently.',
  {
    tasklist_id: z.string(),
    task_id: z.string(),
  },
  async (args) => {
    await api(
      'DELETE',
      `/lists/${encodeURIComponent(args.tasklist_id)}/tasks/${encodeURIComponent(args.task_id)}`,
    );
    return textResult({ deleted: args.task_id });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
