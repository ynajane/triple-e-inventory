'use strict';

// Request values must be decimal scalars, never JavaScript-coercible arrays/booleans.
// Existing peso text fields may include their documented separators.
module.exports = function decimalNumber(value, { money = false } = {}) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const raw = money ? value.replace(/[,\u20b1\s]/g, '') : value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
};
