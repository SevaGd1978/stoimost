import path from 'node:path';
import {
  AccountError,
  COOKIE,
  clearSessionCookie,
  parseCookies,
  publicUser,
  roleLabel,
  sessionCookie,
  validatePassword,
  verifyPassword,
} from './accounts.js';
import { authenticate, cookieSecure } from './auth.js';

function fail(res, err) {
  const status = err instanceof AccountError ? err.status || 400 : 500;
  res.status(status).json({ error: err.message || 'Ошибка' });
}

function setSession(req, res, session) {
  res.set('Set-Cookie', sessionCookie(session.id, { secure: cookieSecure(req) }));
}

export function mountAuthRoutes(app, { store, auth, rootDir }) {
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.sendFile(path.join(rootDir, 'public', 'login.html'));
  });

  app.get('/api/setup', (_req, res) => {
    res.json({ needsSetup: store.users.length === 0 });
  });

  app.post('/api/setup', (req, res) => {
    try {
      if (store.users.length) throw new AccountError('Администратор уже создан', 403);
      const user = store.createUser({
        login: req.body?.login,
        name: req.body?.name || 'Администратор',
        password: req.body?.password,
        role: 'admin',
      });
      const session = store.openSession(user.id);
      setSession(req, res, session);
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/login', (req, res) => {
    try {
      const user = authenticate(store, auth.limiter, req.body?.login, req.body?.password);
      const session = store.openSession(user.id);
      setSession(req, res, session);
      res.json({ user: publicUser(user), roleLabel: roleLabel(user.role) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) store.closeSession(token);
    res.set('Set-Cookie', clearSessionCookie(cookieSecure(req)));
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    res.json({ user: req.user, roleLabel: roleLabel(req.user.role) });
  });

  app.post('/api/me/password', (req, res) => {
    try {
      const user = store.userById(req.user.id);
      if (!user || !verifyPassword(req.body?.current, user)) {
        throw new AccountError('Текущий пароль неверный', 401);
      }
      validatePassword(req.body?.next);
      store.updateUser(user.id, { password: req.body.next });
      const session = store.openSession(user.id);
      setSession(req, res, session);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/users', auth.requireAdmin, (_req, res) => {
    res.json(store.users.map(publicUser));
  });

  app.post('/api/users', auth.requireAdmin, (req, res) => {
    try {
      const user = store.createUser({
        login: req.body?.login,
        name: req.body?.name,
        password: req.body?.password,
        role: req.body?.role === 'admin' ? 'admin' : 'employee',
      });
      res.status(201).json(publicUser(user));
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch('/api/users/:id', auth.requireAdmin, (req, res) => {
    try {
      const id = req.params.id;
      if (id === req.user.id && (req.body?.disabled === true || (req.body?.role && req.body.role !== 'admin'))) {
        throw new AccountError('Нельзя снять с себя права администратора');
      }
      const patch = {};
      if (req.body?.name != null) patch.name = req.body.name;
      if (req.body?.role != null) patch.role = req.body.role;
      if (req.body?.disabled != null) patch.disabled = Boolean(req.body.disabled);
      if (req.body?.password) patch.password = req.body.password;
      const user = store.updateUser(id, patch);
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
      res.json(publicUser(user));
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete('/api/users/:id', auth.requireAdmin, (req, res) => {
    try {
      if (req.params.id === req.user.id) throw new AccountError('Нельзя удалить свою учётную запись');
      const ok = store.removeUser(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Пользователь не найден' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}
