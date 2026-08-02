export const RUPA_CHANNEL_ID = "3e948667805e7627459a599018d05853";
export const CHZZK_SUBSCRIPTION_CACHE_MS = 5 * 60 * 1000;
export const RUPA_SUBSCRIPTION_URL = `https://api.chzzk.naver.com/commercial/v1/subscribe/channels/${RUPA_CHANNEL_ID}`;

export class ChzzkSubscriptionSyncError extends Error {
  constructor(message, code = "SUBSCRIPTION_SYNC_FAILED") {
    super(message);
    this.name = "ChzzkSubscriptionSyncError";
    this.code = code;
  }
}

function safeText(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function dateOnly(value) {
  const raw = safeText(value, 80);
  const match = raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

export function isRupaSubscriptionFresh(state, nowMs = Date.now()) {
  const updatedAt = new Date(state?.updatedAt || 0).getTime();
  return state?.source === "chzzk-subscription-api"
    && state?.channelId === RUPA_CHANNEL_ID
    && Number.isFinite(updatedAt)
    && updatedAt > 0
    && nowMs - updatedAt < CHZZK_SUBSCRIPTION_CACHE_MS;
}

export function parseRupaSubscription(payload, now = new Date()) {
  const content = payload?.content;
  if (!content || typeof content !== "object") {
    throw new ChzzkSubscriptionSyncError("치지직 구독정보 응답 형식이 올바르지 않습니다.", "INVALID_RESPONSE");
  }

  const info = content.info;
  const updatedAt = now.toISOString();
  if (!info || typeof info !== "object") {
    return {
      source: "chzzk-subscription-api",
      channelId: RUPA_CHANNEL_ID,
      channelName: "아홀로 루파",
      subscribed: false,
      subscriptionDisabled: content.subscriptionDisabled === true,
      status: "NONE",
      deferred: false,
      tierNo: null,
      tierName: "",
      totalMonth: 0,
      renewalDate: "",
      renewalType: "",
      subscriptionGift: false,
      switchTierName: "",
      updatedAt,
      checkedAt: updatedAt,
      error: ""
    };
  }

  const channelId = safeText(info.channelId, 80) || RUPA_CHANNEL_ID;
  if (channelId !== RUPA_CHANNEL_ID) {
    throw new ChzzkSubscriptionSyncError("다른 채널의 구독정보가 반환되었습니다.", "CHANNEL_MISMATCH");
  }

  const tierNoValue = Number(info.tierNo);
  const totalMonthValue = Number(info.totalMonth);
  const status = safeText(info.status, 40).toUpperCase() || "UNKNOWN";
  const tierName = safeText(info.tierName, 120);
  const nextPublishYmdt = safeText(info.nextPublishYmdt, 80);
  const subscribed = status !== "NONE" && status !== "EXPIRED" && Boolean(
    tierName || (Number.isFinite(tierNoValue) && tierNoValue > 0) || nextPublishYmdt
  );

  return {
    source: "chzzk-subscription-api",
    channelId: RUPA_CHANNEL_ID,
    channelName: safeText(info.channelName, 120) || "아홀로 루파",
    subscribed,
    subscriptionDisabled: content.subscriptionDisabled === true,
    status,
    deferred: info.deferred === true,
    tierNo: Number.isFinite(tierNoValue) && tierNoValue > 0 ? Math.round(tierNoValue) : null,
    tierName,
    totalMonth: Number.isFinite(totalMonthValue) && totalMonthValue >= 0 ? Math.round(totalMonthValue) : 0,
    renewalDate: dateOnly(nextPublishYmdt),
    renewalType: safeText(info.renewalType, 40).toUpperCase(),
    subscriptionGift: info.subscriptionGift === true,
    switchTierName: safeText(info.switchTierName, 120),
    updatedAt,
    checkedAt: updatedAt,
    error: ""
  };
}

export async function fetchRupaSubscription({ fetchImpl = fetch, now = new Date() } = {}) {
  let response;
  try {
    response = await fetchImpl(RUPA_SUBSCRIPTION_URL, {
      credentials: "include",
      cache: "no-store"
    });
  } catch {
    throw new ChzzkSubscriptionSyncError("치지직 구독정보 서버에 연결하지 못했습니다.", "NETWORK");
  }

  if (response.status === 401 || response.status === 403) {
    throw new ChzzkSubscriptionSyncError("치지직 로그인이 필요합니다.", "AUTH");
  }
  if (!response.ok) {
    throw new ChzzkSubscriptionSyncError(`치지직 구독정보 요청 오류 (${response.status})`, "HTTP");
  }

  try {
    return parseRupaSubscription(await response.json(), now);
  } catch (error) {
    if (error instanceof ChzzkSubscriptionSyncError) throw error;
    throw new ChzzkSubscriptionSyncError("치지직 구독정보 응답을 읽지 못했습니다.", "INVALID_RESPONSE");
  }
}
