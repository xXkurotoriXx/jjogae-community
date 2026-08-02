export const RUPA_CHANNEL_ID = "3e948667805e7627459a599018d05853";
export const LOG_POWER_CACHE_MS = 5 * 60 * 1000;
export const LOG_POWER_BALANCES_URL = "https://api.chzzk.naver.com/service/v1/log-power/balances";
export const LOG_POWER_CHANNEL_WHITELIST = Object.freeze([
  Object.freeze({ channelId: RUPA_CHANNEL_ID, channelName: "아홀로 루파" })
]);

export class LogPowerSyncError extends Error {
  constructor(message, code = "POWER_SYNC_FAILED") {
    super(message);
    this.name = "LogPowerSyncError";
    this.code = code;
  }
}

export function isLogPowerFresh(state, nowMs = Date.now()) {
  const updatedAt = new Date(state?.updatedAt || 0).getTime();
  return state?.source === "chzzk-balance-api"
    && state?.channelId === RUPA_CHANNEL_ID
    && Number.isFinite(updatedAt)
    && updatedAt > 0
    && nowMs - updatedAt < LOG_POWER_CACHE_MS;
}

export function parseRupaLogPower(payload, now = new Date()) {
  const items = Array.isArray(payload?.content?.data) ? payload.content.data : [];
  const allowedChannel = LOG_POWER_CHANNEL_WHITELIST[0];
  const item = items.find((candidate) => String(candidate?.channelId || "") === allowedChannel.channelId);
  const updatedAt = now.toISOString();
  if (!item) {
    return {
      source: "chzzk-balance-api",
      channelId: allowedChannel.channelId,
      channelName: allowedChannel.channelName,
      balance: null,
      exact: false,
      listed: false,
      active: null,
      updatedAt,
      checkedAt: updatedAt,
      error: ""
    };
  }

  const amount = Number(item.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) {
    throw new LogPowerSyncError("치지직 통나무 보유량 형식이 올바르지 않습니다.", "INVALID_RESPONSE");
  }
  return {
    source: "chzzk-balance-api",
    channelId: allowedChannel.channelId,
    channelName: allowedChannel.channelName,
    balance: Math.round(amount),
    exact: true,
    listed: true,
    active: item.active !== false,
    updatedAt,
    checkedAt: updatedAt,
    error: ""
  };
}

export async function fetchRupaLogPower({ fetchImpl = fetch, now = new Date() } = {}) {
  let response;
  try {
    response = await fetchImpl(LOG_POWER_BALANCES_URL, { credentials: "include", cache: "no-store" });
  } catch {
    throw new LogPowerSyncError("치지직 통나무 서버에 연결하지 못했습니다.", "NETWORK");
  }
  if (response.status === 401 || response.status === 403) {
    throw new LogPowerSyncError("치지직 로그인이 필요합니다.", "AUTH");
  }
  if (!response.ok) {
    throw new LogPowerSyncError(`치지직 통나무 요청 오류 (${response.status})`, "HTTP");
  }
  try {
    return parseRupaLogPower(await response.json(), now);
  } catch (error) {
    if (error instanceof LogPowerSyncError) throw error;
    throw new LogPowerSyncError("치지직 통나무 응답을 읽지 못했습니다.", "INVALID_RESPONSE");
  }
}
