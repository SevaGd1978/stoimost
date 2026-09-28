import crypto from 'node:crypto';

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * HTTP Basic-авторизация на весь сайт, если задан пароль (TENDER_SPY_PASSWORD).
 * Имя пользователя — любое, если не задано TENDER_SPY_USER. Без пароля — пропускает всех.
 */
export function basicAuth({ password, user = '', realm = 'Tender Spy', open = [] } = {}) {
  if (!password) return (_req, _res, next) => next();
  return (req, res, next) => {
    if (open.includes(req.path)) return next();
    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme?.toLowerCase() === 'basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const u = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const p = sep >= 0 ? decoded.slice(sep + 1) : '';
      if (safeEqual(p, password) && (!user || safeEqual(u, user))) return next();
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).send('Нужен пароль Tender Spy');
  };
}
