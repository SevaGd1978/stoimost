const DAY_MS = 86_400_000;

function cleanText(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function customerKey(tender) {
  if (tender?.customerInn) return `inn:${String(tender.customerInn).replace(/\D/g, '')}`;
  const customer = cleanText(tender?.customer).replace(/\s+/g, ' ');
  return customer ? `name:${customer}` : '';
}

export function daysUntil(iso, now = Date.now()) {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - now) / DAY_MS);
}

export function customerHistory(tender, tenders = []) {
  const key = customerKey(tender);
  if (!key) return { count: 0, contracts: 0, sum: 0, lastPublishedAt: null };
  const related = tenders.filter((item) => item?.id !== tender?.id && customerKey(item) === key);
  return {
    count: related.length,
    contracts: related.filter((item) => item.kind === 'contract').length,
    sum: related.reduce((sum, item) => sum + (Number.isFinite(item.price) ? item.price : 0), 0),
    lastPublishedAt: related.map((item) => item.publishedAt).filter(Boolean).sort().at(-1) || null,
  };
}

function matchSummary(tender) {
  const matches = Array.isArray(tender?.matches) ? tender.matches : [];
  return {
    strong: matches.filter((match) => match.type !== 'company' && match.strong !== false),
    weak: matches.filter((match) => match.type !== 'company' && match.strong === false),
    company: matches.filter((match) => match.type === 'company'),
  };
}

export function checklistFor(tender, { deal } = {}) {
  const matches = matchSummary(tender);
  const left = daysUntil(tender?.deadlineAt);
  const docsState = tender?.documents?.state;
  const openDeal = deal && deal.stage !== 'won' && deal.stage !== 'lost';

  return [
    {
      id: 'fit',
      label: 'Подтвердить соответствие номенклатуре',
      status: matches.strong.length ? 'done' : matches.weak.length || matches.company.length ? 'warn' : 'todo',
      hint: matches.strong.length ? 'Совпадение подтверждено в карточке закупки' : 'Проверьте предмет закупки вручную',
    },
    {
      id: 'deadline',
      label: 'Зафиксировать срок подачи и контрольную дату',
      status: tender?.kind === 'contract' || tender?.isOpen === false || (left != null && left < 0) ? 'todo' : left != null && left <= 3 ? 'warn' : left == null ? 'warn' : 'done',
      hint: tender?.kind === 'contract' ? 'Это уже контракт, подача не требуется' : left == null ? 'Срок в карточке не указан' : left < 0 ? 'Срок подачи завершён' : `Осталось дней: ${left}`,
    },
    {
      id: 'documents',
      label: 'Изучить документацию закупки',
      status: docsState === 'done' ? 'done' : docsState === 'running' || docsState === 'error' ? 'warn' : 'todo',
      hint: docsState === 'done' ? 'PDF уже собран' : docsState === 'running' ? 'Документы сейчас извлекаются' : docsState === 'error' ? 'Предыдущее извлечение завершилось ошибкой' : 'Соберите документы в один PDF из избранного',
    },
    {
      id: 'customer',
      label: 'Проверить заказчика',
      status: tender?.customerInn ? 'done' : tender?.customer ? 'warn' : 'todo',
      hint: tender?.customerInn ? `ИНН ${tender.customerInn} известен` : 'Для юридической проверки нужен ИНН',
    },
    {
      id: 'volume',
      label: 'Оценить историю и объём закупок заказчика',
      status: tender?.customer || tender?.customerInn ? 'todo' : 'warn',
      hint: tender?.customer ? 'Откройте «Объём закупок» в избранной карточке' : 'Заказчик не указан',
    },
    {
      id: 'ownership',
      label: 'Назначить ответственного и следующий шаг',
      status: openDeal && deal.ownerId && deal.nextStep ? 'done' : openDeal ? 'warn' : 'todo',
      hint: openDeal ? 'Закупка уже находится в воронке' : 'Добавьте закупку в воронку участия',
    },
    {
      id: 'economics',
      label: 'Рассчитать предложение и предел снижения',
      status: deal?.bid != null ? 'done' : openDeal ? 'warn' : 'todo',
      hint: deal?.bid != null ? 'Сумма предложения указана в воронке' : 'Зафиксируйте сумму предложения в карточке воронки',
    },
  ];
}

export function scoreTender(tender, { tenders = [], settings = {}, deal, now = Date.now() } = {}) {
  const reasons = [];
  const risks = [];
  let score = 0;

  const matches = matchSummary(tender);
  if (matches.strong.length >= 2) {
    score += 30;
    reasons.push('Несколько подтверждённых совпадений с номенклатурой');
  } else if (matches.strong.length === 1) {
    score += 26;
    reasons.push('Подтверждённое совпадение с номенклатурой');
  } else if (matches.weak.length) {
    score += 12;
    risks.push('Совпадение найдено в выдаче, но не подтверждено в тексте карточки');
  } else if (matches.company.length) {
    score += 8;
    risks.push('Карточка найдена по заказчику, а не по предмету закупки');
  } else {
    score += 3;
    risks.push('Нет явного совпадения с номенклатурой');
  }

  const left = daysUntil(tender?.deadlineAt, now);
  if (tender?.kind === 'contract') {
    score += 7;
    risks.push('Это уже заключённый контракт, а не открытая закупка');
  } else if (tender?.isOpen === false || (left != null && left < 0)) {
    risks.push('Подача заявок завершена');
  } else if (left == null) {
    score += 10;
    risks.push('Срок подачи не указан в карточке');
  } else if (left <= 2) {
    score += 6;
    risks.push(`До окончания подачи осталось не более ${Math.max(left, 0)} дн.`);
  } else if (left <= 6) {
    score += 12;
    reasons.push('Есть несколько дней на подготовку заявки');
  } else if (left <= 13) {
    score += 19;
    reasons.push('Достаточно времени на изучение и подготовку');
  } else {
    score += 25;
    reasons.push('Комфортный запас времени до окончания подачи');
  }

  const hasPriceRange = settings.priceMin != null || settings.priceMax != null;
  if (hasPriceRange) {
    if (tender?.price == null) {
      score += 4;
      risks.push('Цена не указана, соответствие диапазону не проверить');
    } else if ((settings.priceMin == null || tender.price >= settings.priceMin) && (settings.priceMax == null || tender.price <= settings.priceMax)) {
      score += 15;
      reasons.push('Цена входит в заданный рабочий диапазон');
    } else {
      risks.push('Цена вне заданного диапазона настроек');
    }
  } else if (tender?.price == null) {
    score += 4;
    risks.push('НМЦК или цена контракта не указана');
  } else {
    score += 10;
    reasons.push('Цена закупки указана');
  }

  const history = customerHistory(tender, tenders);
  if (history.count >= 5) {
    score += 15;
    reasons.push('По заказчику уже накоплена заметная история закупок');
  } else if (history.count >= 2) {
    score += 12;
    reasons.push('Заказчик уже встречался в собранной выборке');
  } else if (history.count === 1) {
    score += 9;
    reasons.push('Есть ещё одна закупка этого заказчика для сравнения');
  } else if (tender?.customerInn) {
    score += 6;
    reasons.push('Заказчика можно проверить по ИНН');
  } else if (tender?.customer) {
    score += 3;
  } else {
    risks.push('Заказчик не указан');
  }

  if (tender?.documents?.state === 'done') {
    score += 8;
    reasons.push('Документация уже собрана в PDF');
  } else if (tender?.documents?.state === 'running') {
    score += 5;
  } else if (tender?.documents?.state === 'error') {
    score += 2;
    risks.push('Документы не удалось извлечь в прошлый раз');
  } else {
    score += 3;
  }
  if (tender?.customerInn) score += 4;
  if (tender?.url) score += 3;
  if (deal && deal.stage !== 'lost') score += 0;

  const value = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: value,
    level: value >= 70 ? 'high' : value >= 45 ? 'medium' : 'low',
    label: value >= 70 ? 'высокая' : value >= 45 ? 'средняя' : 'низкая',
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 5),
    daysLeft: left,
    customerHistory: history,
  };
}

export function enrichTender(tender, context = {}) {
  if (!tender) return tender;
  const opportunity = scoreTender(tender, context);
  return {
    ...tender,
    opportunity: {
      ...opportunity,
      checklist: checklistFor(tender, context),
    },
  };
}
