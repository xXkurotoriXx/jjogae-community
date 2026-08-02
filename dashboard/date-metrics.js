const DAY_MS = 86_400_000;

function daySerial(year, month, day) {
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function paddedDay(value) {
  return String(Math.max(0, value)).padStart(3, "0");
}

export function elapsedDayText(startDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return "미설정";
  const [year, month, day] = startDate.split("-").map(Number);
  const today = daySerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const difference = today - daySerial(year, month, day);
  if (difference < 0) return `D-${paddedDay(Math.abs(difference))}일`;
  return `D+${paddedDay(difference + 1)}일`;
}

export function annualCountdown(month, day, now = new Date()) {
  const today = daySerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
  let targetYear = now.getFullYear();
  let target = daySerial(targetYear, month, day);
  if (target < today) {
    targetYear += 1;
    target = daySerial(targetYear, month, day);
  }
  const remaining = target - today;
  return {
    text: `D-${paddedDay(remaining)}일`,
    targetDate: `${targetYear}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`
  };
}
