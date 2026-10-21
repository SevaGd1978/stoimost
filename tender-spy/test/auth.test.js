import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Store } from '../src/store.js';
import { createAuth, authenticate } from '../src/auth.js';
import { mountAuthRoutes } from '../src/auth-routes.js';
import {
  ensureBootstrapAdmin,
  hashPassword,
  loginLimiter,
  publicUser,
  tenderPatchFor,
  verifyPassword,
} from '../src/accounts.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-spy-auth-')), 'db.json');
}

function cookieOf(res) {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/ts_session=([^;]+)/);
  return m ? `ts_session=${m[1]}` : '';
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeApp(store) {
  const auth = createAuth({ store });
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(auth.attach);
  mountAuthRoutes(app, { store, auth, rootDir });
  app.get('/styles.css', (_req, res) => res.type('css').send('body{}'));
  app.patch('/api/settings', auth.requireAdmin, (_req, res) => res.json({ ok: true }));
  app.get('/api/tenders', (_req, res) => res.json({ ok: true, user: reqUser(_req) }));
  app.get('/', (_req, res) => res.type('html').send('<html>app</html>'));
  return app;
}

function reqUser(_req) {
  return _req.user;
}

test('пароль хранится как scrypt, проверка не зависит от регистра логина', () => {
  const store = new Store(tmpFile());
  const user = store.createUser({ login: 'Seva', name: 'Сева', password: 'correct-horse', role: 'admin' });
  assert.equal(user.login, 'seva');
  assert.notEqual(user.hash, 'correct-horse');
  assert.equal(verifyPassword('correct-horse', user), true);
  assert.equal(verifyPassword('wrong-password', user), false);
  assert.equal(JSON.stringify(publicUser(user)).includes(user.hash), false);

  const again = new Store(store.file);
  assert.equal(verifyPassword('correct-horse', again.findUserByLogin('SEVA')), true);
  assert.throws(() => store.createUser({ login: 'seva', password: 'another-password', role: 'employee' }), /уже есть/);
  assert.throws(() => store.createUser({ login: 'ab', password: 'another-password', role: 'employee' }), /Логин/);
  assert.throws(() => store.createUser({ login: 'okname', password: 'short', role: 'employee' }), /Пароль/);
});

test('последнего администратора нельзя удалить, понизить или отключить', () => {
  const store = new Store(tmpFile());
  const empty = new Store(tmpFile());
  assert.throws(() => empty.createUser({ login: 'first', password: 'password1', role: 'employee' }), /Первый пользователь/);
  const admin = store.createUser({ login: 'admin', password: 'password1', role: 'admin' });
  const emp = store.createUser({ login: 'clerk', name: 'Сотрудник', password: 'password1', role: 'employee' });
  assert.throws(() => store.removeUser(admin.id), /администратор/);
  assert.throws(() => store.updateUser(admin.id, { role: 'employee' }), /администратор/);
  assert.throws(() => store.updateUser(admin.id, { disabled: true }), /администратор/);
  const second = store.createUser({ login: 'boss', password: 'password1', role: 'admin' });
  assert.equal(store.updateUser(admin.id, { role: 'employee' }).role, 'employee');
  assert.equal(store.removeUser(emp.id), true);
  assert.equal(store.userById(second.id).role, 'admin');
});

test('сессия истекает, отключение пользователя её гасит, смена пароля закрывает старые входы', () => {
  const store = new Store(tmpFile());
  const admin = store.createUser({ login: 'admin', password: 'password1', role: 'admin' });
  const session = store.openSession(admin.id);
  assert.equal(store.sessionUser(session.id).login, 'admin');
  store.db.sessions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(store.sessionUser(session.id), null);

  const fresh = store.openSession(admin.id);
  store.updateUser(admin.id, { password: 'password2' });
  assert.equal(store.sessionUser(fresh.id), null);
  assert.equal(verifyPassword('password2', store.userById(admin.id)), true);
});

test('ensureBootstrapAdmin создаёт администратора один раз и только если задан пароль', () => {
  const store = new Store(tmpFile());
  assert.equal(ensureBootstrapAdmin(store, { password: '' }), null);
  assert.equal(store.users.length, 0);
  const user = ensureBootstrapAdmin(store, { login: 'Owner', password: 'from-env-1' });
  assert.equal(user.login, 'owner');
  assert.equal(user.role, 'admin');
  assert.equal(ensureBootstrapAdmin(store, { login: 'other', password: 'from-env-2' }), null);
  assert.equal(store.users.length, 1);
  assert.throws(() => ensureBootstrapAdmin(new Store(tmpFile()), { password: 'short' }), /Пароль/);
});

test('сотрудник не может проставить archived', () => {
  assert.deepEqual(tenderPatchFor('employee', { seen: true, archived: true, comment: 'a' }), { seen: true, comment: 'a' });
  assert.deepEqual(tenderPatchFor('admin', { archived: true }), { archived: true });
});

test('вход, роли и страница без сессии', async () => {
  const store = new Store(tmpFile());
  const app = makeApp(store);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, opts = {}) =>
    fetch(base + url, {
      redirect: 'manual',
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  try {
    assert.equal((await call('/health')).status, 200);
    assert.equal((await call('/styles.css')).status, 200);
    assert.equal((await call('/api/tenders')).status, 401);
    const home = await call('/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/login');
    const loginPage = await call('/login');
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /form-setup/);

    const setup = await call('/api/setup');
    assert.equal((await setup.json()).needsSetup, true);
    const created = await call('/api/setup', { method: 'POST', body: { login: 'admin', name: 'Админ', password: 'password1' } });
    assert.equal(created.status, 201);
    const adminCookie = cookieOf(created);
    assert.match(created.headers.get('set-cookie'), /HttpOnly/);
    assert.match(created.headers.get('set-cookie'), /SameSite=Lax/);
    const me = await (await call('/api/me', { headers: { cookie: adminCookie } })).json();
    assert.equal(me.user.role, 'admin');
    assert.equal(me.user.hash, undefined);

    assert.equal((await call('/api/setup', { method: 'POST', body: { login: 'x', password: 'password1' } })).status, 403);
    const added = await call('/api/users', {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: { login: 'clerk', name: 'Клерк', password: 'password2', role: 'employee' },
    });
    assert.equal(added.status, 201);
    const listed = await (await call('/api/users', { headers: { cookie: adminCookie } })).json();
    assert.equal(listed.length, 2);
    assert.equal(listed.some((u) => u.salt || u.hash), false);

    const bad = await call('/api/login', { method: 'POST', body: { login: 'clerk', password: 'nope-nope' } });
    assert.equal(bad.status, 401);
    const empLogin = await call('/api/login', { method: 'POST', body: { login: 'Clerk', password: 'password2' } });
    assert.equal(empLogin.status, 200);
    const empCookie = cookieOf(empLogin);
    assert.equal((await call('/api/tenders', { headers: { cookie: empCookie } })).status, 200);
    const denied = await call('/api/settings', { method: 'PATCH', headers: { cookie: empCookie }, body: { onlyOpen: true } });
    assert.equal(denied.status, 403);
    assert.equal((await call('/api/users', { headers: { cookie: empCookie } })).status, 403);
    assert.equal((await call('/api/settings', { method: 'PATCH', headers: { cookie: adminCookie }, body: {} })).status, 200);

    const self = await call(`/api/users/${me.user.id}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie },
      body: { role: 'employee' },
    });
    assert.equal(self.status, 400);

    const out = await call('/api/logout', { method: 'POST', headers: { cookie: empCookie } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await call('/api/tenders', { headers: { cookie: empCookie } })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('authenticate: отключённый пользователь и лимит попыток', () => {
  const store = new Store(tmpFile());
  const admin = store.createUser({ login: 'admin', password: 'password1', role: 'admin' });
  const clerk = store.createUser({ login: 'clerk', password: 'password2', role: 'employee' });
  store.updateUser(clerk.id, { disabled: true });
  const limiter = loginLimiter({ maxFails: 2, windowMs: 60_000 });
  assert.throws(() => authenticate(store, limiter, 'clerk', 'password2'), /отключена/);
  assert.equal(authenticate(store, limiter, 'admin', 'password1').id, admin.id);
  const strict = loginLimiter({ maxFails: 2, windowMs: 60_000 });
  assert.throws(() => authenticate(store, strict, 'admin', 'wrong-pass'), /Неверный/);
  assert.throws(() => authenticate(store, strict, 'admin', 'wrong-pass'), /Неверный/);
  assert.throws(() => authenticate(store, strict, 'admin', 'password1'), /15 минут/);
  assert.equal(hashPassword('password1').hash.length, 64);
});
