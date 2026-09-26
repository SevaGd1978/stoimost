/**
 * Проверка контрольных чисел ИНН (10 знаков — юрлица, 12 — ИП/физлица).
 * Алгоритм — приказ ФНС № ММВ-7-6/435@.
 */
const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const W11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checksum(digits, weights) {
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  return (sum % 11) % 10;
}

export function normalizeInn(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function isValidInn(value) {
  const inn = normalizeInn(value);
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
  const d = inn.split('').map(Number);
  if (inn.length === 10) return checksum(d, W10) === d[9];
  return checksum(d, W11) === d[10] && checksum(d, W12) === d[11];
}
