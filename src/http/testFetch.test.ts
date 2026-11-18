import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { testFetch } from './testFetch.js';

function listen(handler: http.RequestListener) {
  const server = http.createServer(handler).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('every request says Connection: close, and the caller\'s method, headers and body still arrive', async () => {
  const seen: { connection?: string; header?: string; method?: string; body: string }[] = [];
  const server = listen((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ connection: req.headers.connection, header: req.headers['x-client-id'] as string | undefined, method: req.method, body });
      res.end('ok');
    });
  });
  try {
    await (await testFetch(`${server.base}/a`, { method: 'POST', headers: { 'X-Client-Id': 'abc', 'content-type': 'application/json' }, body: '{"a":1}' })).text();
    await (await testFetch(`${server.base}/b`)).text();
    assert.deepEqual(seen.map((s) => s.connection), ['close', 'close']);
    assert.deepEqual([seen[0]!.method, seen[0]!.header, seen[0]!.body], ['POST', 'abc', '{"a":1}']);
  } finally {
    await server.close();
  }
});

test('a server that never answers fails in seconds with a TimeoutError, not after undici\'s 300 s', async () => {
  const server = listen(() => {}); // takes the request and says nothing
  try {
    const started = Date.now();
    await assert.rejects(() => testFetch(server.base, { timeoutMs: 150 }), (error: Error) => error.name === 'TimeoutError');
    assert.ok(Date.now() - started < 5_000, 'it failed at the test\'s own deadline');
  } finally {
    await server.close();
  }
});

test('a caller\'s own abort signal still works alongside the deadline', async () => {
  const server = listen(() => {});
  try {
    const controller = new AbortController();
    const pending = testFetch(server.base, { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await assert.rejects(() => pending, (error: Error) => error.name === 'AbortError');
    assert.ok(Date.now() - started < 2_000, 'the abort won, not the 5 s deadline');
  } finally {
    await server.close();
  }
});
