const fmtPrice = (n) =>
  n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`;

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatTelegramMessage(tenders) {
  const head = `🕵️ <b>Tender Spy</b>: новых закупок — ${tenders.length}\n`;
  const lines = tenders.slice(0, 10).map((t) => {
    const why = t.matches.map((m) => (m.type === 'company' ? `ИНН ${m.ref}` : m.label)).join(', ');
    return (
      `\n• <a href="${escapeHtml(t.url)}">${escapeHtml(t.title).slice(0, 120)}</a>\n` +
      `  ${t.law === 'other' ? '' : `${t.law}-ФЗ · `}${escapeHtml(t.customer || t.supplier || '')}\n` +
      `  ${fmtPrice(t.price)} · ${escapeHtml(t.stage || '')} · причина: ${escapeHtml(why)}`
    );
  });
  const tail = tenders.length > 10 ? `\n\n…и ещё ${tenders.length - 10}` : '';
  return head + lines.join('') + tail;
}

export class TelegramNotifier {
  constructor({ token, chatId, fetchImpl = fetch, log = console }) {
    this.token = token;
    this.chatId = chatId;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  async send(text) {
    if (!this.enabled) return false;
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.log.warn?.(`[telegram] HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return { ok: false, status: res.status, error: errText.slice(0, 200) };
    }
    return { ok: true };
  }

  async testConnection() {
    if (!this.enabled) return { ok: false, error: 'Токен бота или Chat ID не заданы' };
    try {
      const msg = `🕵️ <b>Tender Spy</b>\nТестовое уведомление: связь с Telegram успешно настроена! 🚀\nВремя: ${new Date().toLocaleString('ru-RU')}`;
      const res = await this.send(msg);
      if (res && res.ok) return { ok: true };
      return { ok: false, error: res?.error || `HTTP ${res?.status || 'error'}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async notifyNewTenders(tenders) {
    if (!tenders.length) return false;
    const res = await this.send(formatTelegramMessage(tenders));
    return Boolean(res && res.ok);
  }
}
