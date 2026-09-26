/* Tender Spy — клиент. Ванильный JS, без сборки. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    mode: 'live',
    settings: null,
    platforms: [],
    watchlist: { companies: [], nomenclature: [] },
    status: null,
    stats: null,
    tenders: [],
    browserNotify: localStorage.getItem('ts.browserNotify') === '1',
  };

  // ---------- helpers ----------
  const fmtPrice = (n) => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function daysLeft(iso) {
    if (!iso) return null;
    return Math.ceil((Date.parse(iso) - Date.now()) / 86400000);
  }

  // ---------- навигация ----------
  function showView(name) {
    $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'watchlist') loadQueries();
    if (name === 'analytics') loadAnalytics();
    if (name === 'log') loadRuns();
    location.hash = name;
  }
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ---------- state ----------
  async function loadState() {
    const s = await api('/api/state');
    Object.assign(state, { mode: s.mode, platforms: s.platforms || [], settings: s.settings, watchlist: s.watchlist, status: s.status, stats: s.stats, lastRun: s.lastRun });
    renderStatus();
    renderWatchlist();
    renderSettings();
    fillFilterSelects();
  }

  function renderStatus() {
    const { status, stats, mode } = state;
    const enabled = state.platforms.filter((p) => state.settings?.platforms?.[p.id] !== false).length;
    $('#st-mode').textContent = mode === 'demo' ? 'демо (без сети)' : `ЕИС + площадок: ${enabled} (live)`;
    $('#st-last').textContent = state.lastRun ? fmtDateTime(state.lastRun.finishedAt) : '—';
    $('#st-next').textContent = status?.nextRunAt ? fmtDateTime(status.nextRunAt) : '—';
    $('#st-tg').textContent = status?.telegram ? (state.settings?.notifyTelegram ? 'вкл' : 'настроен, выкл') : 'не настроен';
    $('#s-open').textContent = stats?.open ?? 0;
    $('#s-unseen').textContent = stats?.unseen ?? 0;
    $('#s-contracts').textContent = stats?.contracts ?? 0;
    $('#s-fav').textContent = stats?.favorites ?? 0;
    const badge = $('#badge-unseen');
    badge.hidden = !(stats?.unseen > 0);
    badge.textContent = stats?.unseen ?? 0;
    document.title = (stats?.unseen ? `(${stats.unseen}) ` : '') + 'Tender Spy';
    $('#scan-progress').hidden = !status?.running;
    $('#btn-scan').disabled = Boolean(status?.running);
    $('#source-note').textContent =
      mode === 'demo'
        ? 'Сервер запущен в демо-режиме: карточки сгенерированы локально и лишь имитируют выдачу ЕИС. Запустите без флага --demo для реальных данных.'
        : `Данные берутся из RSS расширенного поиска ЕИС (zakupki.gov.ru) по ключевым словам и кодам ОКПД2, а также из открытых реестров площадок: ${state.platforms.map((p) => p.name).join(', ')}. Площадки ищут только по ключевым словам, продажа имущества в выдачу не попадает. Извещение, найденное и в ЕИС, и на площадке, показывается одной карточкой. Поиск по ИНН не выполняется.`;
  }

  // ---------- лента ----------
  function filterParams() {
    const p = new URLSearchParams();
    const q = $('#f-q').value.trim();
    if (q) p.set('q', q);
    const nomen = $('#f-nomen').value;
    if (nomen) p.set('nomen', nomen);
    p.set('kind', $('#f-kind').value);
    p.set('law', $('#f-law').value);
    p.set('source', $('#f-source').value);
    p.set('sort', $('#f-sort').value);
    const minPrice = $('#f-min').value.trim();
    const maxPrice = $('#f-max').value.trim();
    if (minPrice) p.set('minPrice', minPrice);
    if (maxPrice) p.set('maxPrice', maxPrice);
    if ($('#f-new').checked) p.set('onlyNew', '1');
    if ($('#f-open').checked) p.set('onlyOpen', '1');
    if ($('#f-fav').checked) p.set('favorite', '1');
    if ($('#f-arch').checked) p.set('archived', '1');
    return p;
  }

  async function loadFeed() {
    const p = filterParams();
    const data = await api(`/api/tenders?${p}`);
    state.tenders = data.items;
    $('#btn-csv').href = `/api/tenders.csv?${p}`;
    $('#feed-summary').textContent = `Показано ${data.items.length} из ${data.total}`;
    renderFeed();
  }

  function whyChip(m) {
    const label = m.type === 'company' ? `ИНН ${m.ref} · ${m.label}${m.via === 'contract' ? ' (контракт)' : ''}` : m.type === 'okpd2' ? `ОКПД2 ${m.ref}` : `«${m.label}»`;
    return `<span class="why ${m.type === 'company' ? 'company' : ''} ${m.strong === false ? 'weak' : ''}" title="${m.strong === false ? 'Совпадение по выдаче ЕИС, в тексте карточки не подтверждено' : 'Подтверждено в тексте карточки'}">${esc(label)}</span>`;
  }

  function sourceName(id) {
    if (!id || id === 'zakupki') return 'ЕИС';
    return state.platforms.find((p) => p.id === id)?.name || id;
  }

  function sourceTags(t) {
    const links = t.links && Object.keys(t.links).length ? t.links : { [t.source || 'zakupki']: t.url };
    const ids = Object.keys(links).sort((a, b) => (a === 'zakupki' ? -1 : b === 'zakupki' ? 1 : 0));
    return ids
      .map((id) => `<a class="tag src" href="${esc(links[id])}" target="_blank" rel="noopener" title="Открыть на площадке">${esc(sourceName(id))}</a>`)
      .join('');
  }

  function renderTender(t) {
    const left = daysLeft(t.deadlineAt);
    const dlClass = left == null ? '' : left < 0 ? 'over' : left <= 3 ? 'soon' : '';
    const dlText = t.deadlineAt ? (t.kind === 'contract' ? `исполнение до ${fmtDate(t.deadlineAt)}` : left < 0 ? `подача завершена ${fmtDate(t.deadlineAt)}` : `подача до ${fmtDate(t.deadlineAt)} (${left} дн.)`) : '';
    return `
      <article class="tender ${t.seen ? '' : 'unseen'} ${t.archived ? 'archived' : ''}" data-id="${esc(t.id)}">
        <div>
          <div class="tender-top">
            ${t.seen ? '' : '<span class="tag new">новое</span>'}
            <span class="tag kind-${t.kind}">${t.kind === 'contract' ? 'контракт' : 'извещение'}</span>
            ${t.law !== 'other' ? `<span class="tag law-${t.law}">${t.law}-${t.law === '615' ? 'ПП' : 'ФЗ'}</span>` : ''}
            ${t.stage ? `<span class="tag ${t.isOpen ? 'stage-open' : 'stage-closed'}">${esc(t.stage)}</span>` : ''}
            ${sourceTags(t)}
            <span>№ ${esc(t.number)}</span>
            ${t.platformNumber ? `<span>· на площадке ${esc(t.platformNumber)}</span>` : ''}
            ${t.method ? `<span>· ${esc(t.method)}</span>` : ''}
            <span>· размещено ${fmtDate(t.publishedAt)}</span>
          </div>
          <div class="tender-title"><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a></div>
          <div class="tender-meta">
            ${t.customer ? `<span>Заказчик: <b>${esc(t.customer)}</b></span>` : ''}
            ${t.supplier ? `<span>Поставщик: <b>${esc(t.supplier)}</b></span>` : ''}
            ${t.region ? `<span>${esc(t.region)}</span>` : ''}
          </div>
          <div class="tender-why">${t.matches.map(whyChip).join('')}</div>
        </div>
        <div class="tender-right">
          <div class="price">${fmtPrice(t.price)} <small>₽</small></div>
          <div class="deadline ${dlClass}">${esc(dlText)}</div>
          <div class="tender-actions">
            <button class="btn btn-sm btn-icon fav ${t.favorite ? 'active' : ''}" data-act="favorite" title="В избранное">★</button>
            <button class="btn btn-sm btn-icon" data-act="seen" title="${t.seen ? 'Отметить как новое' : 'Прочитано'}">${t.seen ? '↺' : '✓'}</button>
            <button class="btn btn-sm btn-icon" data-act="archive" title="${t.archived ? 'Вернуть из архива' : 'В архив'}">${t.archived ? '📤' : '🗄️'}</button>
          </div>
        </div>
      </article>`;
  }

  function renderFeed() {
    const list = $('#feed-list');
    list.innerHTML = state.tenders.map(renderTender).join('');
    $('#feed-empty').hidden = state.tenders.length > 0;
  }

  $('#feed-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.tender');
    const t = state.tenders.find((x) => x.id === card.dataset.id);
    if (!t) return;
    const patch =
      btn.dataset.act === 'favorite' ? { favorite: !t.favorite } : btn.dataset.act === 'seen' ? { seen: !t.seen } : { archived: !t.archived, seen: true };
    try {
      await api(`/api/tenders/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: patch });
      await Promise.all([loadFeed(), loadState()]);
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // клик по ссылке — считаем прочитанным
  $('#feed-list').addEventListener('click', (e) => {
    const a = e.target.closest('.tender-title a');
    if (!a) return;
    const card = a.closest('.tender');
    const t = state.tenders.find((x) => x.id === card.dataset.id);
    if (t && !t.seen) api(`/api/tenders/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { seen: true } }).then(() => Promise.all([loadFeed(), loadState()]));
  });

  let feedTimer;
  const debouncedFeed = () => {
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => loadFeed().catch((e) => toast(e.message, 'err')), 200);
  };
  ['#f-q', '#f-min', '#f-max'].forEach((s) => $(s).addEventListener('input', debouncedFeed));
  ['#f-nomen', '#f-kind', '#f-law', '#f-source', '#f-sort', '#f-new', '#f-open', '#f-fav', '#f-arch'].forEach((s) => $(s).addEventListener('change', debouncedFeed));

  $('#btn-mark-seen').addEventListener('click', async () => {
    const r = await api('/api/tenders/mark-all-seen', { method: 'POST' });
    toast(`Отмечено прочитанными: ${r.marked}`, 'ok');
    await Promise.all([loadFeed(), loadState()]);
  });

  $('#btn-archive-old').addEventListener('click', async () => {
    if (!confirm('Убрать из ленты в архив все просмотренные и закрытые закупки?\nИзбранные и новые открытые останутся. Архив — галочка «Архив» в фильтрах.')) return;
    const r = await api('/api/tenders/archive-old', { method: 'POST' });
    toast(r.archived ? `Убрано в архив: ${r.archived}` : 'Нечего убирать', 'ok');
    await Promise.all([loadFeed(), loadState()]);
  });

  function fillFilterSelects() {
    const ns = $('#f-nomen');
    const curN = ns.value;
    ns.innerHTML = '<option value="">Вся номенклатура</option>' + state.watchlist.nomenclature.map((n) => `<option value="${esc(n.keyword || n.okpd2)}">${esc(n.keyword || `ОКПД2 ${n.okpd2}`)}</option>`).join('');
    ns.value = curN;
    const ss = $('#f-source');
    const curS = ss.value;
    ss.innerHTML =
      '<option value="all">Все площадки</option><option value="zakupki">ЕИС</option>' +
      state.platforms.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    ss.value = [...ss.options].some((o) => o.value === curS) ? curS : 'all';
  }

  // ---------- наблюдение ----------
  function renderWatchlist() {
    $('#nomen-list').innerHTML =
      state.watchlist.nomenclature
        .map(
          (n) => `
        <div class="item" data-id="${esc(n.id)}">
          <div class="item-main">
            <div class="item-title">${esc(n.keyword || `ОКПД2 ${n.okpd2}`)}</div>
            <div class="item-sub">${n.okpd2 ? `ОКПД2 <code>${esc(n.okpd2)}</code>` : 'полнотекстовый поиск'}</div>
          </div>
          <button class="btn btn-sm" data-act="feed" title="Показать в ленте">📡</button>
          <button class="btn btn-sm btn-danger" data-act="del" title="Удалить">✕</button>
        </div>`,
        )
        .join('') || '<div class="muted small">Добавьте ключевые слова или ОКПД2.</div>';
  }

  // Экспорт и импорт Watchlist (JSON)
  $('#btn-export-wl').addEventListener('click', async () => {
    try {
      const data = await api('/api/watchlist/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tender-spy-watchlist-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Список наблюдения экспортирован', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(bin);
  }

  function resetImportFile() {
    const input = $('#import-file');
    if (input) input.value = '';
    const name = $('#import-file-name');
    if (name) name.textContent = 'Файл не выбран';
  }

  $('#import-file')?.addEventListener('change', () => {
    const file = $('#import-file').files[0];
    $('#import-file-name').textContent = file ? file.name : 'Файл не выбран';
  });

  $('#btn-import-wl').addEventListener('click', () => {
    $('#modal-import').hidden = false;
  });
  $('#btn-import-close').addEventListener('click', () => {
    $('#modal-import').hidden = true;
    resetImportFile();
  });
  $('#btn-import-confirm').addEventListener('click', async () => {
    const file = $('#import-file')?.files?.[0];
    const replace = $('#import-replace').checked;
    if (file) {
      if (file.size > 2 * 1024 * 1024) return toast('Файл больше 2 МБ', 'err');
      try {
        const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        const res = await api('/api/nomenclature/import', { method: 'POST', body: { filename: file.name, data, replace } });
        const invalid = res.invalid?.length ? `, не разобрано строк: ${res.invalid.length}` : '';
        toast(`Добавлено позиций: ${res.added}, уже были: ${res.skipped}${invalid}`, 'ok');
        $('#modal-import').hidden = true;
        $('#import-json-input').value = '';
        resetImportFile();
        await loadState();
        loadQueries();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    const raw = $('#import-json-input').value.trim();
    if (!raw) return toast('Выберите файл или вставьте JSON', 'err');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return toast(`Невалидный JSON: ${e.message}`, 'err');
    }
    try {
      const payload = Array.isArray(parsed) ? { nomenclature: parsed } : parsed;
      const res = await api('/api/watchlist/import', { method: 'POST', body: { ...payload, replace } });
      toast(`Импортировано позиций номенклатуры: ${res.nomenclature?.added || 0}`, 'ok');
      $('#modal-import').hidden = true;
      $('#import-json-input').value = '';
      await loadState();
      loadQueries();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#form-nomen').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const n = await api('/api/nomenclature', { method: 'POST', body: Object.fromEntries(fd) });
      toast(`Добавлено: ${n.keyword || `ОКПД2 ${n.okpd2}`}`, 'ok');
      e.target.reset();
      await loadState();
      loadQueries();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#nomen-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const item = btn.closest('.item');
    const n = state.watchlist.nomenclature.find((x) => x.id === item.dataset.id);
    if (btn.dataset.act === 'del') {
      await api(`/api/nomenclature/${n.id}`, { method: 'DELETE' });
      await loadState();
      loadQueries();
    } else {
      $('#f-nomen').value = n.keyword || n.okpd2;
      showView('feed');
      loadFeed();
    }
  });

  async function loadQueries() {
    const qs = await api('/api/queries').catch(() => []);
    $('#queries-preview').innerHTML = qs.length
      ? qs.map((q) => `<div><b>${esc(q.label)}</b>${esc(q.url)}</div>`).join('')
      : '<div>Список наблюдения пуст — запросов нет.</div>';
  }

  // ---------- настройки ----------
  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    $('#set-interval').value = s.pollIntervalMin;
    $('#set-onlyopen').checked = s.onlyOpen;
    $('#set-price-min').value = s.priceMin != null ? fmtPrice(s.priceMin) : '';
    $('#set-price-max').value = s.priceMax != null ? fmtPrice(s.priceMax) : '';
    $('#set-fz44').checked = s.laws.fz44;
    $('#set-fz223').checked = s.laws.fz223;
    $('#set-fz615').checked = s.laws.fz615;
    $('#set-platforms').innerHTML = state.platforms
      .map(
        (p) => `<label class="switch"><input type="checkbox" data-platform="${esc(p.id)}" ${s.platforms?.[p.id] !== false ? 'checked' : ''} />
          ${esc(p.name)} <span class="hint">${esc(new URL(p.site).hostname.replace(/^www\./, ''))}</span></label>`,
      )
      .join('');
    $('#set-telegram').checked = s.notifyTelegram;
    $('#set-telegram').disabled = !state.status?.telegram;
    $('#tg-hint').textContent = state.status?.telegram ? '' : '(токен не задан)';
    $('#set-browser').checked = state.browserNotify;
  }

  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          pollIntervalMin: Number($('#set-interval').value),
          onlyOpen: $('#set-onlyopen').checked,
          priceMin: $('#set-price-min').value.trim() || null,
          priceMax: $('#set-price-max').value.trim() || null,
          searchContracts: false,
          laws: { fz44: $('#set-fz44').checked, fz223: $('#set-fz223').checked, fz615: $('#set-fz615').checked },
          platforms: Object.fromEntries($$('#set-platforms input[data-platform]').map((el) => [el.dataset.platform, el.checked])),
        },
      });
      toast('Настройки сохранены', 'ok');
      await loadState();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#set-telegram').addEventListener('change', async (e) => {
    await api('/api/settings', { method: 'PATCH', body: { notifyTelegram: e.target.checked } });
    await loadState();
  });

  $('#btn-test-tg').addEventListener('click', async () => {
    $('#btn-test-tg').disabled = true;
    try {
      const res = await api('/api/telegram/test', { method: 'POST' });
      toast(res.message || 'Тест успешен!', 'ok');
    } catch (err) {
      toast(`Ошибка Telegram: ${err.message}`, 'err');
    } finally {
      $('#btn-test-tg').disabled = false;
    }
  });

  $('#set-browser').addEventListener('change', async (e) => {
    if (e.target.checked) {
      if (!('Notification' in window)) {
        toast('Браузер не поддерживает уведомления', 'err');
        e.target.checked = false;
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('Разрешение на уведомления не выдано', 'err');
        e.target.checked = false;
        return;
      }
    }
    state.browserNotify = e.target.checked;
    localStorage.setItem('ts.browserNotify', state.browserNotify ? '1' : '0');
  });

  // ---------- аналитика ----------
  async function loadAnalytics() {
    try {
      const data = await api('/api/analytics');
      $('#an-total-price').textContent = `${fmtPrice(data.totalPrice)} ₽`;
      $('#an-count').textContent = `${data.totalTenders} активных позиций`;
      $('#an-avg-price').textContent = `${fmtPrice(data.avgPrice)} ₽`;
      $('#an-max-price').textContent = `${fmtPrice(data.maxPrice)} ₽`;

      const sum44 = data.byLaw['44']?.sum || 0;
      const sum223 = data.byLaw['223']?.sum || 0;
      const totalLaws = sum44 + sum223 || 1;
      const pct44 = Math.round((sum44 / totalLaws) * 100);
      const pct223 = 100 - pct44;
      $('#an-laws-ratio').textContent = `${pct44}% / ${pct223}%`;
      $('#an-laws-sub').textContent = `44-ФЗ: ${fmtPrice(sum44)} ₽ · 223-ФЗ: ${fmtPrice(sum223)} ₽`;

      const lawsTb = $('#an-laws-table tbody');
      const rows = [
        { label: '44-ФЗ (госзакупки)', ...data.byLaw['44'] },
        { label: '223-ФЗ (госкомпании)', ...data.byLaw['223'] },
        { label: '615-ПП (капремонт)', ...data.byLaw['615'] },
        { label: 'Извещения (все)', ...data.byKind.notice },
        { label: 'Контракты (выигранные)', ...data.byKind.contract },
      ];
      lawsTb.innerHTML = rows
        .map((r) => `<tr><td>${esc(r.label)}</td><td>${r.count || 0}</td><td>${fmtPrice(r.sum || 0)} ₽</td></tr>`)
        .join('');

      const stagesTb = $('#an-stages-table tbody');
      const stKeys = Object.keys(data.byStage || {});
      stagesTb.innerHTML = stKeys.length
        ? stKeys
            .map((k) => `<tr><td>${esc(k)}</td><td>${data.byStage[k].count}</td><td>${fmtPrice(data.byStage[k].sum)} ₽</td></tr>`)
            .join('')
        : '<tr><td colspan="3" class="muted">Нет данных</td></tr>';

      const custTb = $('#an-customers-table tbody');
      custTb.innerHTML = data.topCustomers?.length
        ? data.topCustomers
            .map((c) => `<tr><td>${esc(c.name)}</td><td>${c.count}</td><td>${fmtPrice(c.sum)} ₽</td></tr>`)
            .join('')
        : '<tr><td colspan="3" class="muted">Нет заказчиков</td></tr>';

      const suppTb = $('#an-suppliers-table tbody');
      suppTb.innerHTML = data.topSuppliers?.length
        ? data.topSuppliers
            .map((s) => `<tr><td>${esc(s.name)}</td><td>${s.count}</td><td>${fmtPrice(s.sum)} ₽</td></tr>`)
            .join('')
        : '<tr><td colspan="3" class="muted">Нет поставщиков</td></tr>';
    } catch (err) {
      toast(`Ошибка аналитики: ${err.message}`, 'err');
    }
  }

  $('#btn-refresh-analytics').addEventListener('click', () => loadAnalytics());

  // ---------- журнал ----------
  async function loadRuns() {
    const runs = await api('/api/runs');
    const tb = $('#runs-table tbody');
    tb.innerHTML = runs.length
      ? runs
          .map(
            (r) => `<tr>
          <td>${fmtDateTime(r.startedAt)}</td>
          <td>${r.trigger === 'timer' ? 'таймер' : 'вручную'}</td>
          <td>${r.queriesRun}</td>
          <td>${r.found}</td>
          <td><b>${r.added}</b></td>
          <td>${(r.errors || []).map((e) => `<div class="err">${esc(e.query)}: ${esc(e.message)}</div>`).join('') || '—'}</td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="6" class="muted">Опросов ещё не было</td></tr>';
  }

  // ---------- опрос ----------
  $('#btn-scan').addEventListener('click', async () => {
    $('#btn-scan').disabled = true;
    $('#scan-progress').hidden = false;
    try {
      const { run } = await api('/api/scan', { method: 'POST' });
      if (run.skipped) toast('Опрос уже идёт', '');
      else if (run.errors?.length && !run.found) toast(`Опрос завершён с ошибками: ${run.errors[0].message}`, 'err');
      else toast(`Найдено ${run.found}, новых ${run.added}`, run.added ? 'ok' : '');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      await Promise.all([loadState(), loadFeed()]);
    }
  });

  // ---------- SSE ----------
  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('run:start', () => {
      $('#scan-progress').hidden = false;
      $('#btn-scan').disabled = true;
    });
    es.addEventListener('run:done', async (e) => {
      const { run, added } = JSON.parse(e.data);
      await Promise.all([loadState(), loadFeed()]);
      if (added.length && state.browserNotify && Notification.permission === 'granted') {
        const first = added[0];
        const n = new Notification(`Tender Spy: ${added.length} новых закупок`, {
          body: `${first.title}\n${first.customer || ''} · ${fmtPrice(first.price)} ₽`,
          icon: '/favicon.ico',
        });
        n.onclick = () => {
          window.focus();
          window.open(first.url, '_blank');
        };
      }
      if (run.trigger === 'timer' && added.length) toast(`Автоопрос: ${added.length} новых закупок`, 'ok');
    });
    es.onerror = () => {
      es.close();
      setTimeout(connectEvents, 5000);
    };
  }

  // ---------- init ----------
  (async () => {
    try {
      await loadState();
      await loadFeed();
      connectEvents();
      const view = location.hash.replace('#', '');
      if (['feed', 'watchlist', 'analytics', 'settings', 'log'].includes(view)) showView(view);
      else if (!state.watchlist.nomenclature.length) showView('watchlist');
    } catch (err) {
      toast(`Не удалось загрузить: ${err.message}`, 'err');
    }
  })();
})();
