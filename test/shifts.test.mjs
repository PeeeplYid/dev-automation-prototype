import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinutes, shiftHours, weeklyHours } from '../src/shifts.mjs';

test('toMinutes converts HH:MM', () => {
  assert.equal(toMinutes('07:30'), 450);
});

test('toMinutes rejects invalid input', () => {
  assert.throws(() => toMinutes('25:00'), RangeError);
});

test('shiftHours for a day shift', () => {
  assert.equal(shiftHours('08:00', '16:30'), 8.5);
});

test('shiftHours for a night shift across midnight', () => {
  assert.equal(shiftHours('22:00', '06:00'), 8);
});
