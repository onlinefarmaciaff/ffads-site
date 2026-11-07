// CSV для Excel: UTF-8 с BOM, разделитель «;», десятичная запятая.
// Защита от CSV-инъекций: текст, начинающийся с = + - @ (и их полноширинных вариантов),
// табуляции или перевода строки, предваряется апострофом — Excel не выполнит его как формулу.

const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;

export function textCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function numberCell(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  const trimmed = digits > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed.replace('.', ',');
}

// columns: [{ title, value: (row) => any, type: 'text' | 'number', digits }]
export function buildCsv(columns, rows) {
  const lines = [columns.map((c) => textCell(c.title)).join(';')];
  for (const row of rows) {
    lines.push(columns.map((c) => (c.type === 'number' ? numberCell(c.value(row), c.digits) : textCell(c.value(row)))).join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
