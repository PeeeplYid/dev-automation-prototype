// Shift helpers. Times are "HH:MM" strings (24 h). A shift may cross midnight.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toMinutes(time) {
  const m = TIME.exec(time);
  if (!m) throw new RangeError(`Invalid time "${time}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Length of a shift in hours; an end before the start means the shift ends the next day.
export function shiftHours(start, end) {
  let minutes = toMinutes(end) - toMinutes(start);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes / 60;
}

// Hours of a shift that fall within the recurring 22:00–06:00 night window.
export function nightHours(start, end) {
  const sMin = toMinutes(start);
  let eMin = toMinutes(end);
  if (eMin <= sMin) eMin += 24 * 60;

  let minutes = 0;
  // Three day offsets suffice: shiftHours caps shift length at 24h, so the
  // shift can never span more than one full night window boundary.
  for (const d of [-1, 0, 1]) {
    const nightStart = d * 1440 + 1320;
    const nightEnd = nightStart + 480;
    minutes += Math.max(0, Math.min(eMin, nightEnd) - Math.max(sMin, nightStart));
  }
  return minutes / 60;
}
