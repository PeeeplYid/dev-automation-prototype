// Shift helpers. Times are "HH:MM" strings (24 h). A shift may cross midnight.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toMinutes(time) {
  const m = TIME.exec(time);
  if (!m) throw new RangeError(`Invalid time "${time}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function shiftMinutes(start, end) {
  let minutes = toMinutes(end) - toMinutes(start);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes;
}

// Length of a shift in hours; an end before the start means the shift ends the next day.
export function shiftHours(start, end) {
  return shiftMinutes(start, end) / 60;
}

// Net shift length in hours after removing an unpaid break; a break longer
// than the shift is invalid.
/**
 * @param {string} start - shift start time as "HH:MM"
 * @param {string} end - shift end time as "HH:MM"; before `start` means the shift ends the next day
 * @param {number} [breakMinutes=0] - unpaid break length in minutes; must not exceed the shift length
 */
export function netHours(start, end, breakMinutes = 0) {
  const minutes = shiftMinutes(start, end);
  if (breakMinutes > minutes) {
    throw new RangeError(`Break of ${breakMinutes} minutes exceeds shift length of ${minutes} minutes`);
  }
  return (minutes - breakMinutes) / 60;
}
