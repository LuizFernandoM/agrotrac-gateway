import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const project = 'agrotrac-gwtest-' + randomUUID().slice(0, 8);
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://gateway.test';
const host = 'gateway.test';
const protocol = 'agrotrac.live.v1';
const sockets = new Set();
const passed = [];
let port;
let resources;
let stopped;
let failure;

function docker(args, expectedStatus = 0) {
  const res = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 240_000 });
  if (res.error) throw res.error;
  assert.equal(res.status, expectedStatus, args.join(' ') + '\n' + res.stdout + res.stderr);
  return res;
}

function compose(args, expectedStatus) {
  return docker(['compose', '-p', project, '-f', 'compose.test.yaml', ...args], expectedStatus);
}

function http(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: {
      Host: host, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      const timestamps = [];
      res.on('data', (chunk) => { chunks.push(chunk); timestamps.push(performance.now()); });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const json = res.headers['content-type']?.includes('application/json') && text ? JSON.parse(text) : undefined;
          resolve({ status: res.statusCode, headers: res.headers, headersDistinct: res.headersDistinct, text, json, timestamps });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(35_000, () => req.destroy(new Error('client test timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function expect(path, status, options) {
  const res = await http(path, options);
  assert.equal(res.status, status, path + ' (' + (options?.method ?? 'GET') + ') ' + res.text.slice(0, 160));
  return res;
}

async function login(username, client = 'web') {
  const res = await expect('/v1/live/auth/login', 200, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(client === 'web' ? { Origin: origin } : {}) },
    body: JSON.stringify({ username, password: 'fixture-only', client }),
  });
  assert.equal(res.headers['cache-control'], 'no-store');
  if (client === 'mobile') return { Authorization: 'Bearer ' + res.json.access_token };
  assert.match(res.headers['set-cookie'][0], /HttpOnly/);
  return { Cookie: res.headers['set-cookie'][0].split(';')[0], Origin: origin, 'X-CSRF-Token': res.json.csrf_token };
}

function ws(headers, offered = protocol) {
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/live', offered, {
    headers: { Host: host, ...headers }, handshakeTimeout: 8000,
  });
  const messages = [];
  socket.on('message', (data) => messages.push(data.toString()));
  socket.on('error', () => {});
  sockets.add(socket);
  return { socket, messages };
}

async function until(check, deadline = 5000) {
  const start = performance.now();
  while (performance.now() - start < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('fixture deadline exceeded');
}

async function upgradeDenied(headers, status, offered) {
  const { socket } = ws(headers, offered);
  const [, res] = await once(socket, 'unexpected-response', { signal: AbortSignal.timeout(9000) });
  assert.equal(res.statusCode, status);
  res.resume();
  socket.terminate();
}

function multipart(photo, json = Buffer.from('{}')) {
  return Buffer.concat([
    Buffer.from('--fixture-boundary\r\nContent-Disposition: form-data; name="payload"\r\n\r\n'), json,
    Buffer.from('\r\n--fixture-boundary\r\nContent-Disposition: form-data; name="photo"; filename="fixture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'), photo,
    Buffer.from('\r\n--fixture-boundary--\r\n'),
  ]);
}

try {
  compose(['up', '--build', '-d']);
  const ids = compose(['ps', '-a', '-q']).stdout.trim().split(/\s+/);
  resources = JSON.parse(docker(['inspect', ...ids]).stdout).map((entry) => ({
    id: entry.Id.slice(0, 12), name: entry.Name.slice(1), networks: Object.keys(entry.NetworkSettings.Networks),
    bindings: entry.HostConfig.PortBindings,
  }));
  console.log(JSON.stringify({ project, resources }));
  const binding = compose(['port', 'gateway', '8080']).stdout.trim();
  assert.match(binding, /^127\.0\.0\.1:[1-9][0-9]*$/);
  port = Number(binding.split(':')[1]);
  assert.equal(resources.filter(({ bindings }) => bindings && Object.keys(bindings).length).length, 1);
  const version = compose(['exec', '-T', 'gateway', 'nginx', '-V']).stderr;
  assert.match(version, /nginx\/1\.28\.2/);
  assert.match(version, /--with-http_auth_request_module/);
  console.log(version.split('\n').find((line) => line.includes('nginx version')) + ' --with-http_auth_request_module');
  console.log(compose(['exec', '-T', 'gateway', 'nginx', '-t']).stderr.trim());
  assert.match(compose(['exec', '-T', '-e', 'LIVE_UPSTREAM=invalid;arg', 'gateway', '/bin/sh', '/usr/local/bin/agrotrac-entrypoint', 'nginx', '-t'], 64).stderr, /Invalid or missing LIVE_UPSTREAM/);
  await until(async () => (await http('/health/ready').catch(() => ({}))).status === 200);
  await expect('/health/live', 200);
  passed.push('image, nginx -V/-t, env validation, loopback and readiness');

  const web = await expect('/?source=fixture', 200);
  assert.match(web.text, /AgroTrac Web Fixture/);
  assert.match(web.headers['content-type'], /^text\/html\b/);
  assert.equal(web.headers['cache-control'], 'no-store');
  assert.equal(web.headers['x-content-type-options'], 'nosniff');
  assert.equal((await expect('/', 200, { method: 'HEAD' })).text, '');
  assert.match((await expect('/assets/fixture.js?v=1', 200)).headers['content-type'], /^(application|text)\/javascript\b/);
  assert.match((await expect('/assets/fixture.css', 200)).headers['content-type'], /^text\/css\b/);
  for (const path of ['/silos', '/index.html', '/assets/', '/assets/missing.js', '/assets//fixture.js', '/assets/%66ixture.js', '/assets/nested/../fixture.js', '/v1/unknown.js', '/health/unknown.js', '/internal/unknown.js', '/live/unknown.js']) {
    await expect(path, 404);
  }
  await expect('/', 405, { method: 'POST' });
  await expect('/assets/fixture.js', 405, { method: 'POST' });
  passed.push('mounted SPA shell, static MIME, HEAD and Web route isolation');

  const core = '/v1/core/bookings';
  const audit = '/v1/audit/weighings/sync';
  const loginPath = '/v1/live/auth/login';
  assert.equal((await expect(core, 401, { headers: { Authorization: 'Bearer invalid' } })).headers['www-authenticate'], 'Bearer');
  const operator = await login('operator');
  const admin = await login('admin');
  const mobile = await login('operator', 'mobile');
  await expect('/v1/live/auth/session', 200, { headers: operator });
  assert.equal((await expect('/v1/audit/events', 403, { headers: operator })).json.error.code, 'FORBIDDEN');
  await expect('/v1/audit/events', 200, { headers: admin });
  await expect(core, 403, { method: 'POST', headers: { Cookie: operator.Cookie, Origin: origin }, body: '{}' });
  await expect(core, 403, { method: 'POST', headers: { ...operator, Origin: 'http://wrong.test' }, body: '{}' });
  const correlation = randomUUID();
  const target = core + '?status=OPEN&encoded=%2F';
  const result = await expect(target, 201, { method: 'POST', headers: {
    ...operator, 'Content-Type': 'application/json', 'X-Correlation-Id': correlation,
    'X-Agrotrac-Role': 'admin', 'X-Agrotrac-User-Id': 'forged', 'X-Original-Method': 'GET',
    'X-Original-URI': '/not-the-request', 'X-Forwarded-For': 'forged, forged', 'X-Forwarded-Proto': 'https', Forwarded: 'for=forged',
  }, body: '{}' });
  assert.equal(result.json.url, target);
  assert.equal(result.json.method, 'POST');
  assert.equal(result.json.bytes, 2);
  assert.equal(result.json.mutations, 1);
  assert.equal(result.json.correlation, correlation);
  assert.deepEqual(result.json.rejectedHeaders, []);
  assert.equal(result.json.proto, 'http');
  assert.doesNotMatch(result.json.forwardedFor, /forged/);
  for (const path of [core + '/', '/v1/core//bookings', '/v1/core/%62ookings', '/v1/core/a/../bookings', '/v1/corex/bookings', '/v1/core/admin', '/_agrotrac_auth', '/internal/auth/verify', '/v1/live/internal/auth/verify', '/v1/core/health/live']) {
    await expect(path, 404, { headers: admin });
  }
  await expect(core, 405, { method: 'PUT', headers: admin });
  await expect('/health/live', 405, { method: 'POST' });
  await expect(core, 400, { headers: { ...admin, Host: 'wrong.test' } });
  const expired = await login('expiry');
  await delay(650);
  await expect('/v1/live/auth/session', 401, { headers: expired });
  passed.push('Host, namespace, URI and method allowlist, metadata, cookie/CSRF, role, bearer and expiry fixture');

  const validId = 'abcdef01-2345-4678-aabc-def012345678';
  const invalidIds = [
    validId.toUpperCase(),
    validId.replace('-4678-', '-1678-'),
    validId.replace('-4678-', '-5678-'),
    validId.replace('-aabc-', '-7abc-'),
    validId.replace('-aabc-', '-cabc-'),
  ];
  for (const [method, prefix, suffix] of [
    ['GET', '/v1/core/silos/', ''],
    ['GET', '/v1/core/windows/', ''],
    ['GET', '/v1/core/bookings/', ''],
    ['DELETE', '/v1/core/bookings/', ''],
    ['PATCH', '/v1/core/windows/', '/status'],
    ['GET', '/v1/audit/weighings/', '/romaneio'],
  ]) {
    const path = prefix + validId + suffix;
    await expect(path, 401, { method });
    const response = await expect(path + '?fixture=id', 200, { method, headers: admin });
    assert.equal(response.json.url, path + '?fixture=id');
    for (const id of invalidIds) {
      await expect(prefix + id + suffix, 404, { method, headers: admin });
    }
  }
  passed.push('canonical UUIDv4 route IDs, including cancellation, status and romaneio, rejected at edge');

  const kib = 1024;
  const mib = 1024 * kib;
  const photo = Buffer.alloc(10 * mib, 65);
  const form = multipart(photo, Buffer.alloc(64 * kib, 32));
  const formHeaders = { ...mobile, 'Content-Type': 'multipart/form-data; boundary=fixture-boundary', 'Idempotency-Key': randomUUID() };
  const formRequest = { method: 'POST', headers: formHeaders, body: form };
  const uploaded = await expect(audit, 201, formRequest);
  assert.deepEqual(uploaded.json, {
    photoHash: createHash('sha256').update(photo).digest('hex'), photoBytes: photo.length,
    jsonBytes: 64 * kib, bodyBytes: form.length,
  });
  await expect(audit, 200, formRequest);
  await expect(audit, 409, { ...formRequest, body: multipart(Buffer.alloc(64, 66)) });
  assert.equal((await expect(audit, 413, { ...formRequest, body: multipart(Buffer.alloc(10 * mib + 1)) })).json.code, 'FIXTURE_PART_LIMIT');
  assert.equal((await expect(audit, 413, { ...formRequest, body: multipart(Buffer.alloc(1), Buffer.alloc(64 * kib + 1)) })).json.code, 'FIXTURE_PART_LIMIT');
  await expect(audit, 413, { ...formRequest, body: Buffer.alloc(12 * mib + 1) });
  await expect(audit, 400, { ...formRequest, headers: { ...formHeaders, 'Content-Type': 'multipart/form-data' } });
  const attachment = await expect('/v1/audit/weighings/' + randomUUID() + '/romaneio', 200, { headers: mobile });
  assert.equal(attachment.headers['cache-control'], 'no-store');
  const exactLogin = JSON.stringify({ username: 'operator', password: 'fixture-only', client: 'mobile' }).padEnd(16 * kib);
  await expect(loginPath, 200, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: exactLogin });
  await expect(loginPath, 413, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(16 * kib + 1) });
  await expect(loginPath, 415, { method: 'POST', body: '{}' });
  await expect(core, 201, { method: 'POST', headers: mobile, body: Buffer.alloc(64 * kib) });
  await expect(core, 413, { method: 'POST', headers: mobile, body: Buffer.alloc(64 * kib + 1) });
  passed.push('multipart integrity, 201/200/409, size boundaries and attachment cache policy');

  const snapshot = await expect('/v1/live/snapshot', 200, { headers: operator });
  assert.equal(snapshot.headers['cache-control'], 'no-store');
  await upgradeDenied({ Origin: origin }, 401);
  await upgradeDenied({ ...operator, Origin: 'http://wrong.test' }, 403);
  await upgradeDenied(operator, 400, 'wrong.protocol');
  const one = ws(operator);
  const two = ws(admin);
  await Promise.all([once(one.socket, 'open'), once(two.socket, 'open')]);
  assert.equal(one.socket.protocol, protocol);
  assert.equal(two.socket.protocol, protocol);
  await until(() => one.messages.length === 1 && two.messages.length === 1);
  one.socket.send(JSON.stringify({ type: 'fixture-update' }));
  await until(() => one.messages.length === 3 && two.messages.length === 3);
  for (const connection of [one, two]) {
    const frames = connection.messages.map((message) => JSON.parse(message));
    assert.deepEqual(frames.map(({ type }) => type), ['snapshot', 'update', 'checkpoint']);
    assert.equal(frames[0].snapshots, snapshot.json.snapshots);
  }
  const pong = once(two.socket, 'pong', { signal: AbortSignal.timeout(5000) });
  two.socket.ping('edge-probe');
  assert.equal((await pong)[0].toString(), 'edge-probe');
  const closed = once(one.socket, 'close', { signal: AbortSignal.timeout(5000) });
  await expect('/v1/live/auth/logout', 204, { method: 'POST', headers: operator });
  assert.equal((await closed)[0], 1008);
  await expect('/v1/live/auth/session', 401, { headers: operator });
  assert.equal(two.socket.readyState, WebSocket.OPEN);
  passed.push('two real upgrades, subprotocol, frames without REST polling, origin and logout closure fixture');

  const mutationCount = (await expect(core, 200, { headers: mobile })).json.mutations;
  for (const token of ['fixture-unavailable', 'fixture-bad-status', 'fixture-timeout']) {
    const response = await expect(core, 503, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: '{}' });
    assert.equal(response.json.error.code, 'SERVICE_UNAVAILABLE');
  }
  assert.equal((await expect(core, 200, { headers: mobile })).json.mutations, mutationCount);
  const stream = await expect(core + '?fixture=stream', 200, { headers: mobile });
  assert.equal(stream.text, 'firstsecond');
  assert.ok(stream.timestamps.at(-1) - stream.timestamps[0] >= 400);
  const start = performance.now();
  await expect(core + '?fixture=timeout', 503, { headers: mobile });
  assert.ok(performance.now() - start >= 7500);

  const loginRequest = {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'fixture-rate-limited', password: 'fixture-only', client: 'mobile' }),
  };
  const upstream429 = await expect(loginPath, 429, loginRequest);
  assert.deepEqual(upstream429.headersDistinct['retry-after'], ['17']);
  assert.deepEqual(upstream429.json, { error: { code: 'UPSTREAM_RATE_LIMITED' } });
  assert.equal(upstream429.headers['cache-control'], 'no-store');
  const invalidLogin = { ...loginRequest, body: '{}' };
  const burst = await Promise.all(Array.from({ length: 24 }, () => http(loginPath, invalidLogin)));
  assert.ok(burst.some(({ status }) => status === 429));
  assert.ok(burst.some(({ status }) => status === 401));
  for (const response of burst) {
    if (response.status === 429) {
      assert.deepEqual(response.headersDistinct['retry-after'], ['1']);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(response.json, { error: { code: 'RATE_LIMITED' } });
    } else {
      assert.equal(response.status, 401);
      assert.equal(response.headers['retry-after'], undefined);
    }
  }
  passed.push('isolated login burst, sanitized edge 429 and single Retry-After, upstream 429 preserved, no header on 401');

  compose(['stop', '-t', '10', 'fixture']);
  await expect('/health/live', 200);
  await expect('/health/ready', 503);
  await expect(core, 503, { headers: mobile });
  const logs = compose(['logs', '--no-color', 'gateway']).stdout;
  assert.doesNotMatch(logs, /encoded=|Bearer|fixture_session|fixture-only|wrong[.]test|[/]v1[/]/);
  passed.push('strict 204, fail-closed without mutation, streaming, upstream read timeout, network outage, sanitized logs');
} catch (error) {
  failure = error;
} finally {
  for (const socket of sockets) socket.terminate();
  try {
    compose(['stop', '-t', '10']);
    const ids = compose(['ps', '-a', '-q']).stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) {
      stopped = JSON.parse(docker(['inspect', ...ids]).stdout).map(({ Name, State }) => ({ name: Name.slice(1), state: State.Status, exit: State.ExitCode }));
      assert.ok(stopped.every(({ state, exit }) => state === 'exited' && exit === 0), JSON.stringify(stopped));
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'test and teardown failed') : error;
  }
}

console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', project, port, passed, stopped }));
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
