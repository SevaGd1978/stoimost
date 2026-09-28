import { COOKIE, hashPassword, loginLimiter, parseCookies, publicUser, verifyPassword, AccountError, normalizeLogin } from './accounts.js';

const OPEN = new Set(['/health', '/login', '/login.html', '/styles.css', '/api/login', '/api/setup', '/api/logout']);

const DUMMY = hashPassword('tender-spy-dummy-password');

export function authenticate(store, limiter, loginRaw, password) {
  const login = normalizeLogin(loginRaw);
  if (!login) throw new AccountError('Неверный логин или пароль', 401);
  limiter.check(login);
  const user = store.findUserByLogin(login);
  const okPassword = verifyPassword(password ?? '', user || DUMMY);
  if (!user || !okPassword) {
    limiter.fail(login);
    throw new AccountError('Неверный логин или пароль', 401);
  }
  if (user.disabled) {
    limiter.fail(login);
    throw new AccountError('Учётная запись отключена', 403);
  }
  limiter.ok(login);
  return user;
}

export function cookieSecure(req) {
  return Boolean(req.secure || req.get?.('x-forwarded-proto') === 'https');
}

/**
 * Сессия в cookie. Без входа API отвечает 401, страницы переадресуются на /login.
 * /health и страница входа открыты.
 */
export function createAuth({ store, limiter = loginLimiter() } = {}) {
  function attach(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const user = token ? store.sessionUser(token) : null;
    if (user) req.user = publicUser(user);
    if (OPEN.has(req.path)) return next();
    if (!req.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Нужно войти' });
      const accept = String(req.get?.('accept') || '');
      if (req.method === 'GET' && (accept.includes('text/html') || req.path === '/' || req.path === '/index.html')) {
        return res.redirect('/login');
      }
      return res.status(401).send('Нужно войти');
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.user?.role === 'admin') return next();
    return res.status(403).json({ error: 'Недостаточно прав: это может только администратор' });
  }

  return { attach, requireAdmin, limiter, store };
}
