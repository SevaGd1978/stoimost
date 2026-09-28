import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicAuth } from '../src/auth.js';

function call(mw, { path = '/', auth } = {}) {
  const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, send() { return this; } };
  let passed = false;
  mw({ path, get: (h) => (h === 'authorization' ? auth : undefined) }, res, () => (passed = true));
  return { passed, res };
}
const basic = (s) => `Basic ${Buffer.from(s).toString('base64')}`;

test('basicAuth: без пароля пропускает всех', () => {
  assert.equal(call(basicAuth({})).passed, true);
});

test('basicAuth: пароль обязателен, /health открыт, имя любое', () => {
  const mw = basicAuth({ password: 'секрет', open: ['/health'] });
  const denied = call(mw);
  assert.equal(denied.passed, false);
  assert.equal(denied.res.statusCode, 401);
  assert.match(denied.res.headers['WWW-Authenticate'], /^Basic realm=/);
  assert.equal(call(mw, { auth: basic('кто угодно:неверно') }).passed, false);
  assert.equal(call(mw, { auth: basic('кто угодно:секрет') }).passed, true);
  assert.equal(call(mw, { path: '/health' }).passed, true);
});

test('basicAuth: с TENDER_SPY_USER проверяется и имя', () => {
  const mw = basicAuth({ password: 'p', user: 'seva' });
  assert.equal(call(mw, { auth: basic('seva:p') }).passed, true);
  assert.equal(call(mw, { auth: basic('other:p') }).passed, false);
  assert.equal(call(mw, { auth: basic('seva:p:x') }).passed, false);
});
