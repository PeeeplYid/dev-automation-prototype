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

test('weeklyHours sums two shifts 08:00-16:00 each to 16', () => {
  assert.equal(weeklyHours([{ start: '08:00', end: '16:00' }, { start: '08:00', end: '16:00' }]), 16);
});

test('weeklyHours for an empty list returns 0', () => {
  assert.equal(weeklyHours([]), 0);
});
