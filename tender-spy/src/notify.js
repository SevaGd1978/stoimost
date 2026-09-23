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
      this.log.warn?.(`[telegram] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  }

  async notifyNewTenders(tenders) {
    if (!tenders.length) return false;
    return this.send(formatTelegramMessage(tenders));
  }
}
