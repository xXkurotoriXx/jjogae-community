export const DEFAULT_COMMUNITY_SETTINGS = Object.freeze({
  youtubeSubscriptionStart: "",
  chzzkSubscriptionStart: ""
});

function trimmedValue(value) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

export function normalizeSubscriptionStartDate(value) {
  const text = trimmedValue(value);
  if (!text) return "";

  let parts;
  if (/^\d{8}$/.test(text)) {
    parts = [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8)];
  } else {
    const match = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (!match) return "";
    parts = match.slice(1);
  }

  const [year, month, day] = parts.map(Number);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeCommunitySettings(value = {}) {
  return {
    youtubeSubscriptionStart: normalizeSubscriptionStartDate(value.youtubeSubscriptionStart),
    chzzkSubscriptionStart: normalizeSubscriptionStartDate(value.chzzkSubscriptionStart)
  };
}

export function validateCommunitySettings(value = {}) {
  const fields = [
    ["youtubeSubscriptionStart", "YouTube 구독 시작일"],
    ["chzzkSubscriptionStart", "치지직 구독 시작일"]
  ];
  const normalized = {};
  for (const [key, label] of fields) {
    const raw = trimmedValue(value[key]);
    const startDate = normalizeSubscriptionStartDate(raw);
    if (raw && !startDate) {
      throw new Error(`${label}을 YYYYMMDD 또는 YYYY-MM-DD 형식의 실제 날짜로 입력해 주세요.`);
    }
    normalized[key] = startDate;
  }
  return normalized;
}
