import crypto from 'node:crypto';
import { parsePriceBound } from './tenders.js';

/** Воронка участия в закупке — встроенная CRM под эту ленту, без внешнего сервиса. */
export const CRM_STAGES = [
  { id: 'selected', label: 'Отобрано' },
  { id: 'study', label: 'Изучаем' },
  { id: 'proposal', label: 'Готовим заявку' },
  { id: 'submitted', label: 'Заявка подана' },
  { id: 'won', label: 'Победа' },
  { id: 'lost', label: 'Отказ' },
];

const STAGE_IDS = new Set(CRM_STAGES.map((s) => s.id));

export class CrmError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function stageLabel(id) {
  return CRM_STAGES.find((s) => s.id === id)?.label || id;
}

export function isOpenStage(id) {
  return id !== 'won' && id !== 'lost';
}

export function tenderSnapshot(tender) {
  return {
    title: tender.title || '',
    customer: tender.customer || '',
    price: tender.price ?? null,
    url: tender.url || '',
    number: tender.number || '',
    deadlineAt: tender.deadlineAt || null,
    law: tender.law || '',
    region: tender.region || '',
  };
}

function activity(actor, text) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    at: new Date().toISOString(),
    userId: actor?.id || '',
    name: actor?.name || actor?.login || 'Система',
    text: String(text).slice(0, 1000),
  };
}

export function pushActivity(deal, actor, text) {
  deal.activities = deal.activities || [];
  deal.activities.push(activity(actor, text));
  if (deal.activities.length > 80) deal.activities.splice(0, deal.activities.length - 80);
}

export function createDeal(tender, actor) {
  const now = new Date().toISOString();
  const deal = {
    id: tender.id,
    stage: 'selected',
    ownerId: actor?.id || '',
    bid: null,
    nextStep: '',
    nextStepAt: null,
    lostReason: '',
    createdAt: now,
    updatedAt: now,
    stageAt: now,
    snapshot: tenderSnapshot(tender),
    activities: [],
  };
  pushActivity(deal, actor, 'Взято в воронку');
  return deal;
}

function parseDay(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new CrmError('Дата следующего шага: ГГГГ-ММ-ДД');
  const day = s.slice(0, 10);
  if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new CrmError('Дата следующего шага не разобрана');
  return day;
}

/**
 * Правка карточки воронки. Пишет в историю смену этапа и ответственного.
 * users — учётные записи {id, name, login, disabled}.
 */
export function patchDeal(deal, patch = {}, { users = [], actor } = {}) {
  const notes = [];
  if (patch.stage != null && patch.stage !== deal.stage) {
    if (!STAGE_IDS.has(patch.stage)) throw new CrmError('Неизвестный этап воронки');
    deal.stage = patch.stage;
    deal.stageAt = new Date().toISOString();
    notes.push(`Этап: ${stageLabel(patch.stage)}`);
  }
  if ('ownerId' in patch) {
    const ownerId = patch.ownerId ? String(patch.ownerId) : '';
    if (ownerId && !users.some((u) => u.id === ownerId && !u.disabled)) throw new CrmError('Такого сотрудника нет');
    if (ownerId !== (deal.ownerId || '')) {
      deal.ownerId = ownerId;
      const person = users.find((u) => u.id === ownerId);
      notes.push(ownerId ? `Ответственный: ${person?.name || person?.login}` : 'Ответственный снят');
    }
  }
  if ('bid' in patch) {
    if (patch.bid == null || patch.bid === '') deal.bid = null;
    else {
      const bid = parsePriceBound(patch.bid);
      if (bid == null) throw new CrmError('Сумма предложения не разобрана');
      deal.bid = bid;
    }
  }
  if ('nextStep' in patch) deal.nextStep = String(patch.nextStep ?? '').trim().slice(0, 300);
  if ('nextStepAt' in patch) deal.nextStepAt = parseDay(patch.nextStepAt);
  if ('lostReason' in patch) deal.lostReason = String(patch.lostReason ?? '').trim().slice(0, 300);
  for (const text of notes) pushActivity(deal, actor, text);
  deal.updatedAt = new Date().toISOString();
  return deal;
}

export function presentDeal(deal, { tender, owner } = {}) {
  const snap = deal.snapshot || {};
  const card = tender
    ? {
        id: tender.id,
        title: tender.title || snap.title || '',
        customer: tender.customer || '',
        price: tender.price ?? null,
        url: tender.url || '',
        number: tender.number || '',
        deadlineAt: tender.deadlineAt || null,
        law: tender.law || '',
        region: tender.region || '',
        isOpen: tender.isOpen !== false,
      }
    : { id: deal.id, ...snap, isOpen: null };
  return {
    id: deal.id,
    stage: deal.stage,
    stageLabel: stageLabel(deal.stage),
    ownerId: deal.ownerId || '',
    ownerName: owner?.name || owner?.login || '',
    bid: deal.bid ?? null,
    nextStep: deal.nextStep || '',
    nextStepAt: deal.nextStepAt || null,
    lostReason: deal.lostReason || '',
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
    activities: deal.activities || [],
    card,
  };
}
