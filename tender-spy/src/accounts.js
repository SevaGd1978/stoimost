import crypto from 'node:crypto';

export const ROLES = ['admin', 'employee'];
export const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
export const COOKIE = 'ts_session';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function normalizeLogin(login) {
  return String(login ?? '').trim().toLowerCase();
}

export function validateLogin(login) {
  const v = normalizeLogin(login);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(v)) {
    throw new AccountError('Логин: 3–32 символа, латиница, цифры, точка, _ и -');
  }
  return v;
}

export function validatePassword(password) {
  const p = String(password ?? '');
  if (p.length < 8 || p.length > 200) throw new AccountError('Пароль: от 8 до 200 символов');
  return p;
}

export function validateName(name, login) {
  const n = String(name ?? '').trim();
  if (!n) return login;
  if (n.length > 80) throw new AccountError('Имя не длиннее 80 символов');
  return n;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifyPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(stored.salt, 'hex');
    expected = Buffer.from(stored.hash, 'hex');
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== 32) return false;
  const calc = crypto.scryptSync(String(password ?? ''), salt, 32, SCRYPT);
  return crypto.timingSafeEqual(calc, expected);
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
  };
}

export function roleLabel(role) {
  return role === 'admin' ? 'Администратор' : 'Сотрудник';
}

/** Сотрудник не архивирует карточки: архив общий для всех. */
export function tenderPatchFor(role, body = {}) {
  const next = { ...body };
  if (role !== 'admin') delete next.archived;
  return next;
}

export function newSession(userId, now = Date.now()) {
  return {
    id: crypto.randomBytes(32).toString('hex'),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_MS).toISOString(),
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function sessionCookie(token, { secure = false, maxAge = Math.floor(SESSION_MS / 1000) } = {}) {
  const bits = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearSessionCookie(secure = false) {
  return sessionCookie('', { secure, maxAge: 0 });
}

/** Нельзя оставить систему без действующего администратора. */
export function assertKeepsAdmin(users, { id, patch = {}, removing = false } = {}) {
  const next = users.map((u) => (u.id === id ? { ...u, ...patch } : { ...u }));
  const list = removing ? next.filter((u) => u.id !== id) : next;
  const admins = list.filter((u) => u.role === 'admin' && !u.disabled);
  if (!admins.length) throw new AccountError('Должен остаться хотя бы один действующий администратор');
}

export function loginLimiter({ windowMs = 15 * 60 * 1000, maxFails = 8 } = {}) {
  const fails = new Map();
  return {
    check(login, now = Date.now()) {
      const rec = fails.get(login);
      if (rec && rec.until > now && rec.count >= maxFails) {
        throw new AccountError('Слишком много неудачных попыток. Подождите 15 минут', 429);
      }
    },
    fail(login, now = Date.now()) {
      const rec = fails.get(login);
      if (!rec || rec.until <= now) fails.set(login, { count: 1, until: now + windowMs });
      else rec.count += 1;
    },
    ok(login) {
      fails.delete(login);
    },
  };
}

/** Первый администратор из переменных окружения, только пока в базе нет пользователей. */
export function ensureBootstrapAdmin(store, { login = 'admin', password = '' } = {}) {
  if (store.users.length || !password) return null;
  return store.createUser({
    login: login || 'admin',
    name: 'Администратор',
    password,
    role: 'admin',
  });
}
