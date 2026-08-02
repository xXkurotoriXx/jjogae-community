const UNIT_FACTORS = {
  "": 1,
  "천": 1_000,
  "만": 10_000,
  "억": 100_000_000,
  "k": 1_000,
  "m": 1_000_000,
  "b": 1_000_000_000
};

export function parsePublicSubscriberCountText(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!/^(?:구독자|subscribers?)\s|\s(?:명|subscribers?)$/i.test(raw)) {
    return { count: null, text: "" };
  }
  if (/비공개|hidden/i.test(raw)) return { count: null, text: "비공개" };

  const compact = raw
    .replace(/^(?:구독자|subscribers?)\s*/i, "")
    .replace(/\s*(?:명|subscribers?)$/i, "")
    .trim();
  const match = compact.match(/^([\d,.]+)\s*(천|만|억|[KMB])?$/i);
  if (!match) return { count: null, text: "" };

  const value = Number(match[1].replaceAll(",", ""));
  const unit = (match[2] || "").toLowerCase();
  const factor = UNIT_FACTORS[unit];
  if (!Number.isFinite(value) || !factor) return { count: null, text: "" };

  const count = Math.round(value * factor);
  return {
    count,
    text: `${count.toLocaleString("ko-KR")}명`
  };
}
