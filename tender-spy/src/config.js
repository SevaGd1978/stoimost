import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const argv = new Set(process.argv.slice(2));

function envInt(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  rootDir,
  port: envInt('PORT', 3100),
  dataFile: process.env.TENDER_SPY_DATA || path.join(rootDir, 'data', 'db.json'),
  /** demo — встроенные примеры без выхода в сеть; live — запросы к ЕИС */
  mode: argv.has('--demo') || process.env.TENDER_SPY_MODE === 'demo' ? 'demo' : 'live',
  /** Интервал автоопроса источников, минут */
  pollIntervalMin: envInt('TENDER_SPY_POLL_MIN', 30),
  /** Пауза между запросами к ЕИС, мс (защита от бана по частоте) */
  requestDelayMs: envInt('TENDER_SPY_REQUEST_DELAY_MS', 1500),
  requestTimeoutMs: envInt('TENDER_SPY_REQUEST_TIMEOUT_MS', 25000),
  userAgent:
    process.env.TENDER_SPY_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  zakupkiBase: process.env.TENDER_SPY_ZAKUPKI_BASE || 'https://zakupki.gov.ru',
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  /** Сколько дней хранить тендеры, которые больше не попадают в выборку */
  retentionDays: envInt('TENDER_SPY_RETENTION_DAYS', 90),
};
