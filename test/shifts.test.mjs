import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinutes, shiftHours, nightHours } from '../src/shifts.mjs';

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

test('nightHours for a shift crossing midnight (20:00–02:00) returns 4', () => {
  assert.equal(nightHours('20:00', '02:00'), 4);
});

test('nightHours for a day shift (08:00–16:00) returns 0', () => {
  assert.equal(nightHours('08:00', '16:00'), 0);
});

test('nightHours for a full night shift (22:00–06:00) returns 8', () => {
  assert.equal(nightHours('22:00', '06:00'), 8);
});
