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
