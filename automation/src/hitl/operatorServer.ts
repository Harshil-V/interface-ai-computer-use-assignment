import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ControlLease } from './ControlLease.ts';
import { InterventionStateError, InterventionStore, type InterventionResolution } from './interventions.ts';

const OPERATOR_UI_PATH = path.join(import.meta.dirname, 'operator-ui', 'index.html');
const JSON_INDENT = 2;
const DEFAULT_NOTE = '';

export interface OperatorServerOptions {
  /** `0` lets the OS assign a free port; the actual port is on the returned handle. */
  readonly port: number;
  readonly lease: ControlLease;
  readonly interventions: InterventionStore;
  /** Screenshots are only ever served from inside this directory — a path-traversal guard, not a convenience. */
  readonly evidenceRootDir: string;
}

export interface OperatorServerHandle {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The minimal local operator surface: one static page, a status endpoint it polls,
 * and the two actions ("take control" / "hand back") that move the same
 * `ControlLease` and `InterventionStore` a live replay or discovery run is checking
 * inside `driver.act()`. No framework, no streaming — this is intentionally thin;
 * the real engineering is the control model in `ControlLease.ts`/`interventions.ts`,
 * not this transport.
 */
export async function startOperatorServer(options: OperatorServerOptions): Promise<OperatorServerHandle> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, options).catch((cause) => sendServerError(res, cause));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port,
    url: `http://localhost:${port}/`,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: OperatorServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');

  if (req.method === 'GET' && url.pathname === '/') {
    return await serveOperatorPage(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/intervention') {
    return sendJson(res, 200, interventionContext(options));
  }
  if (req.method === 'GET' && url.pathname === '/api/screenshot') {
    return await serveScreenshot(res, url, options);
  }
  if (req.method === 'POST' && url.pathname === '/api/take-control') {
    return await handleTakeControl(req, res, options);
  }
  if (req.method === 'POST' && url.pathname === '/api/hand-back') {
    return await handleHandBack(req, res, options);
  }

  sendJson(res, 404, { error: `No such route: ${req.method} ${url.pathname}.` });
}

async function serveOperatorPage(res: ServerResponse): Promise<void> {
  const html = await readFile(OPERATOR_UI_PATH, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function interventionContext(options: OperatorServerOptions): Record<string, unknown> {
  const current = options.interventions.current();
  return {
    leaseOwner: options.lease.current(),
    intervention: current ?? null,
    screenshotUrl:
      current?.screenshotPath === undefined || current.screenshotPath === null
        ? null
        : `/api/screenshot?file=${encodeURIComponent(current.screenshotPath)}`,
  };
}

async function serveScreenshot(
  res: ServerResponse,
  url: URL,
  options: OperatorServerOptions,
): Promise<void> {
  const requested = url.searchParams.get('file');
  if (requested === null) {
    return sendJson(res, 400, { error: 'Missing "file" query parameter.' });
  }

  const resolved = path.resolve(requested);
  const root = path.resolve(options.evidenceRootDir);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    return sendJson(res, 403, { error: 'Refusing to serve a file outside the evidence directory.' });
  }

  try {
    const png = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  } catch {
    sendJson(res, 404, { error: `No screenshot at ${requested}.` });
  }
}

async function handleTakeControl(
  req: IncomingMessage,
  res: ServerResponse,
  options: OperatorServerOptions,
): Promise<void> {
  const body = await readJsonBody(req);
  const interventionId = stringField(body, 'interventionId') ?? options.interventions.current()?.interventionId;
  if (interventionId === undefined) {
    return sendJson(res, 409, { error: 'No active intervention to take control of.' });
  }

  try {
    const record = options.interventions.takeControl(interventionId);
    options.lease.acquire('human');
    sendJson(res, 200, { intervention: record, leaseOwner: options.lease.current() });
  } catch (cause) {
    sendJson(res, 409, { error: messageOf(cause) });
  }
}

async function handleHandBack(
  req: IncomingMessage,
  res: ServerResponse,
  options: OperatorServerOptions,
): Promise<void> {
  const body = await readJsonBody(req);
  const interventionId = stringField(body, 'interventionId') ?? options.interventions.current()?.interventionId;
  const resolution = stringField(body, 'resolution');
  if (interventionId === undefined) {
    return sendJson(res, 409, { error: 'No active intervention to hand back.' });
  }
  if (resolution !== 'resumed' && resolution !== 'abandoned') {
    return sendJson(res, 400, { error: 'Field "resolution" must be "resumed" or "abandoned".' });
  }

  try {
    const note = stringField(body, 'note') ?? DEFAULT_NOTE;
    const record = options.interventions.resolve(interventionId, resolution as InterventionResolution, note);
    // The human is, by definition, done acting the moment they hand back — releasing
    // here (rather than leaving that to whoever is awaiting resolution) means the
    // lease reflects reality immediately, not after the engine gets its next turn.
    options.lease.release();
    sendJson(res, 200, { intervention: record, leaseOwner: options.lease.current() });
  } catch (cause) {
    sendJson(res, 409, { error: messageOf(cause) });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function stringField(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(data, null, JSON_INDENT)}\n`);
}

function sendServerError(res: ServerResponse, cause: unknown): void {
  if (!res.headersSent) {
    sendJson(res, 500, { error: messageOf(cause) });
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof InterventionStateError || cause instanceof Error ? cause.message : String(cause);
}
