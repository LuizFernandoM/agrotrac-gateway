import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

const origin = 'http://gateway.test';
const protocol = 'agrotrac.live.v1';
const sessions = new Map();
const uploads = new Map();
const coreIdRoute = /^\/v1\/core\/(?:silos|windows|bookings)\/([^/]+)(?:\/status)?$/;
const romaneioRoute = /^\/v1\/audit\/weighings\/([^/]+)\/romaneio$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const forbiddenHeaders = ['authorization', 'cookie', 'x-csrf-token', 'x-agrotrac-role', 'x-agrotrac-user-id', 'x-original-method', 'x-original-uri', 'forwarded'];
let mutations = 0;
let snapshots = 0;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function read(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sessionToken(req) {
  return req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers.cookie?.replace(/^fixture_session=/, '');
}

function verify(req, method, path) {
  const resourceId = coreIdRoute.exec(path)?.[1] ?? romaneioRoute.exec(path)?.[1];
  if (resourceId && !uuidV4.test(resourceId)) return 403;
  const token = sessionToken(req);
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) return 401;
  const cookie = Boolean(req.headers.cookie);
  const mutation = ['POST', 'PATCH', 'DELETE'].includes(method);
  if (path === '/live' && (!cookie || req.headers.origin !== origin)) return 403;
  if (cookie && mutation && (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrf)) return 403;
  const admin = (method === 'POST' && /^\/v1\/core\/(silos|windows)$/.test(path)) || method === 'PATCH' || path === '/v1/audit/events';
  return admin && session.role !== 'admin' ? 403 : 204;
}

const live = createServer(async (req, res) => {
  if (req.url === '/internal/auth/verify') {
    const { headers } = req;
    const method = headers['x-original-method'];
    const path = headers['x-original-uri'];
    if (req.method !== 'GET' || (await read(req)).length || headers['content-length'] || !/^(GET|POST|PATCH|DELETE)$/.test(method) || !/^\/(v1\/|live$)/.test(path) || path.includes('?') || headers['x-forwarded-proto'] !== 'http' || !headers['x-forwarded-for'] || headers['x-forwarded-for'].includes(',') || headers['x-agrotrac-role']) {
      return send(res, 503);
    }
    const fixtureMode = sessionToken(req);
    if (fixtureMode === 'fixture-unavailable') return send(res, 503);
    if (fixtureMode === 'fixture-bad-status') return send(res, 200);
    if (fixtureMode === 'fixture-timeout') await delay(4000);
    const status = verify(req, method, path);
    const meta = status === 204 ? { 'X-Agrotrac-User-Id': 'fixture', 'X-Agrotrac-Role': sessions.get(fixtureMode).role } : {};
    if (status === 401 && headers.authorization) meta['WWW-Authenticate'] = 'Bearer';
    return send(res, status, undefined, meta);
  }
  if (req.url === '/health/ready') return send(res, 200, { status: 'ready' });
  if (req.url === '/v1/live/auth/login') {
    const { username, password, client } = JSON.parse(await read(req));
    if (username === 'fixture-rate-limited') {
      return send(res, 429, { error: { code: 'UPSTREAM_RATE_LIMITED' } }, { 'Retry-After': '17' });
    }
    if (!['operator', 'admin', 'expiry'].includes(username) || password !== 'fixture-only' || (client === 'web' && req.headers.origin !== origin)) return send(res, 401, { error: { code: 'UNAUTHENTICATED' } });
    const token = randomBytes(24).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    const role = username === 'admin' ? 'admin' : 'operator';
    const expires = Date.now() + (username === 'expiry' ? 600 : 300000);
    sessions.set(token, { csrf, role, expires });
    const view = { user: { id: username, role }, expires_at: new Date(expires).toISOString() };
    return client === 'web'
      ? send(res, 200, { ...view, csrf_token: csrf }, { 'Set-Cookie': 'fixture_session=' + token + '; Path=/; HttpOnly; SameSite=Lax' })
      : send(res, 200, { ...view, access_token: token, token_type: 'Bearer' });
  }
  if (req.url === '/v1/live/auth/session') return send(res, 200, { user: { role: sessions.get(sessionToken(req)).role } });
  if (req.url === '/v1/live/auth/logout') {
    const token = sessionToken(req);
    sessions.delete(token);
    for (const socket of sockets.clients) if (socket.token === token) socket.close(1008);
    return send(res, 204);
  }
  if (req.url === '/v1/live/snapshot') return send(res, 200, { transport: 'http', snapshots: ++snapshots }, { 'Cache-Control': 'public' });
  send(res, 404);
});

const sockets = new WebSocketServer({ noServer: true, handleProtocols: (offered) => offered.has(protocol) ? protocol : false });
live.on('upgrade', (req, networkSocket, head) => {
  if (req.url !== '/live' || verify(req, 'GET', '/live') !== 204 || req.headers['sec-websocket-protocol'] !== protocol) {
    networkSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  sockets.handleUpgrade(req, networkSocket, head, (socket) => {
    socket.token = sessionToken(req);
    socket.send(JSON.stringify({ type: 'snapshot', snapshots }));
    socket.on('message', () => {
      for (const client of sockets.clients) {
        client.send(JSON.stringify({ type: 'update' }));
        client.send(JSON.stringify({ type: 'checkpoint' }));
      }
    });
  });
});

const core = createServer(async (req, res) => {
  const body = await read(req);
  if (req.method === 'POST') mutations++;
  if (req.url.includes('fixture=timeout')) await delay(9000);
  if (req.url.includes('fixture=stream')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('first');
    await delay(600);
    res.end('second');
    return;
  }
  send(res, req.method === 'POST' ? 201 : 200, {
    url: req.url, method: req.method, bytes: body.length, mutations,
    rejectedHeaders: forbiddenHeaders.filter((name) => name in req.headers),
    forwardedFor: req.headers['x-forwarded-for'], proto: req.headers['x-forwarded-proto'],
    correlation: req.headers['x-correlation-id'] ?? null,
  });
});

const audit = createServer(async (req, res) => {
  if (req.method !== 'POST') return send(res, 200, { url: req.url });
  const body = await read(req);
  const boundary = /^multipart\/form-data; boundary=([A-Za-z0-9-]+)$/.exec(req.headers['content-type'])?.[1];
  if (!boundary) return send(res, 400, { code: 'BAD_BOUNDARY' });
  const delimiter = Buffer.from('\r\n--' + boundary);
  const jsonStart = body.indexOf('\r\n\r\n') + 4;
  const jsonEnd = body.indexOf(delimiter, jsonStart);
  const photoStart = body.indexOf('\r\n\r\n', jsonEnd + delimiter.length) + 4;
  const photoEnd = body.indexOf(delimiter, photoStart);
  if (jsonStart < 4 || jsonEnd < 0 || photoStart < 4 || photoEnd < 0) return send(res, 400, { code: 'BAD_BOUNDARY' });
  const photo = body.subarray(photoStart, photoEnd);
  const jsonBytes = jsonEnd - jsonStart;
  if (photo.length > 10 * 1024 ** 2 || jsonBytes > 64 * 1024) return send(res, 413, { code: 'FIXTURE_PART_LIMIT' });
  const key = req.headers['idempotency-key'];
  const hash = createHash('sha256').update(body).digest('hex');
  const photoHash = createHash('sha256').update(photo).digest('hex');
  const prior = uploads.get(key);
  if (prior && prior !== hash) return send(res, 409, { code: 'CONFLICT' });
  uploads.set(key, hash);
  send(res, prior ? 200 : 201, { photoHash, photoBytes: photo.length, jsonBytes, bodyBytes: body.length });
});

const servers = [core.listen(3001), live.listen(3002), audit.listen(3003)];
process.on('SIGTERM', () => {
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});
