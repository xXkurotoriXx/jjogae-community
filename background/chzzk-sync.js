const RUPA_CHANNEL_ID = "3e948667805e7627459a599018d05853";
const FIRST_HISTORY_YEAR = 2023;
const FIRST_PARTY_YEAR = 2024;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_YEAR = 100;

export class ChzzkSyncError extends Error {
  constructor(message, code = "SYNC_FAILED") {
    super(message);
    this.name = "ChzzkSyncError";
    this.code = code;
  }
}

function text(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

function isoDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function channelIdOf(item) {
  return text(
    item?.channelId ||
    item?.channel?.channelId ||
    item?.hostChannelId ||
    item?.streamerId,
    80
  );
}

function donationTypeOf(item) {
  const value = text(item?.donationType || item?.productType || "CHAT", 40).toUpperCase();
  if (value.includes("VIDEO")) return "VIDEO";
  if (value.includes("MISSION")) return "MISSION";
  if (value.includes("TTS")) return "TTS";
  if (value.includes("PARTY")) return "PARTY";
  return "CHAT";
}

function combinedMessage(item) {
  const video = text(item?.donationVideoDescription, 300);
  const message = text(item?.donationText || item?.donationMessage, 500);
  return video && message ? `${video} / ${message}`.slice(0, 500) : (video || message);
}

async function stableEventId(kind, item, normalized) {
  const sourceIdentifier = [
    item?.purchaseNo,
    item?.purchaseId,
    item?.donationId,
    item?.transactionId,
    item?.orderId,
    item?.productId,
    item?.missionId,
    item?.partyDonationId
  ].map((value) => text(value, 120)).filter(Boolean).join(":");
  const fingerprint = JSON.stringify([
    kind,
    sourceIdentifier,
    normalized.timestamp,
    normalized.amount,
    normalized.donationType,
    normalized.channelId,
    normalized.message
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `chzzk:${kind}:${hash.slice(0, 40)}`;
}

export async function normalizeGeneralDonation(item) {
  const channelId = channelIdOf(item);
  const timestamp = isoDate(item?.purchaseDate || item?.donationDateTime || item?.createdTime);
  const amount = positiveInteger(item?.payAmount || item?.totalAmount);
  if (channelId !== RUPA_CHANNEL_ID || !timestamp || !amount) return null;

  const normalized = {
    type: "cheese",
    source: "chzzk-sync",
    timestamp,
    amount,
    donationType: donationTypeOf(item),
    donationSubType: text(item?.donationSubType || item?.donationType, 40),
    streamer: "아홀로 루파",
    channelId,
    message: combinedMessage(item)
  };
  normalized.id = await stableEventId("purchase", item, normalized);
  return normalized;
}

export async function normalizePartyDonation(item) {
  const channelId = channelIdOf(item);
  const timestamp = isoDate(item?.donationDateTime || item?.purchaseDate || item?.createdTime);
  const amount = positiveInteger(item?.payAmount || item?.totalAmount);
  if (channelId !== RUPA_CHANNEL_ID || !timestamp || !amount) return null;

  const partyName = text(item?.partyName, 200);
  const donationText = text(item?.donationText, 300);
  const normalized = {
    type: "cheese",
    source: "chzzk-sync",
    timestamp,
    amount,
    donationType: "PARTY",
    donationSubType: "COMPLETED",
    streamer: "아홀로 루파",
    channelId,
    message: partyName && donationText ? `${partyName} / ${donationText}`.slice(0, 500) : (partyName || donationText || "파티후원")
  };
  normalized.id = await stableEventId("party", item, normalized);
  return normalized;
}

async function fetchJson(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { credentials: "include", cache: "no-store" });
  } catch {
    throw new ChzzkSyncError("치지직 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.", "NETWORK");
  }

  if (response.status === 401 || response.status === 403) {
    throw new ChzzkSyncError("네이버 로그인이 필요합니다. Chrome에서 치지직에 로그인한 뒤 다시 시도해 주세요.", "AUTH");
  }
  if (!response.ok) {
    throw new ChzzkSyncError(`치지직 서버가 요청을 처리하지 못했습니다. (${response.status})`, "HTTP");
  }

  try {
    return await response.json();
  } catch {
    throw new ChzzkSyncError("치지직 응답을 읽지 못했습니다.", "INVALID_RESPONSE");
  }
}

async function assertLoggedIn(fetchImpl) {
  const json = await fetchJson(fetchImpl, "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus");
  if (!json?.content?.loggedIn) {
    throw new ChzzkSyncError("네이버 로그인이 필요합니다. Chrome에서 치지직에 로그인한 뒤 다시 시도해 주세요.", "AUTH");
  }
  return json;
}

export async function fetchChzzkAccountState({ fetchImpl = fetch, now = new Date() } = {}) {
  const json = await assertLoggedIn(fetchImpl);
  const nickname = text(json?.content?.nickname, 100).replace(/\s+/g, " ");
  if (!nickname || /^(?:프로필|네이버 게임 프로필|로그인|치지직|치즈|내 치즈|치즈팜|치트키|스튜디오|알림|설정|익명)$/i.test(nickname)) {
    throw new ChzzkSyncError("치지직 닉네임을 확인하지 못했습니다.", "INVALID_RESPONSE");
  }
  return {
    nickname,
    updatedAt: isoDate(now) || new Date().toISOString()
  };
}

async function collectPages(fetchImpl, makeUrl, normalizer, { maxPages = MAX_PAGES_PER_YEAR } = {}) {
  const events = [];
  for (let page = 0; page < maxPages; page += 1) {
    const json = await fetchJson(fetchImpl, makeUrl(page));
    const items = Array.isArray(json?.content?.data) ? json.content.data : [];
    for (const item of items) {
      const event = await normalizer(item);
      if (event) events.push(event);
    }
    const totalPages = Math.max(1, Number(json?.content?.totalPages || 1));
    if (!items.length || page + 1 >= totalPages) break;
  }
  return events;
}

export async function syncRupaDonations({ fetchImpl = fetch, now = new Date(), recentOnly = false } = {}) {
  await assertLoggedIn(fetchImpl);
  const currentYear = now.getFullYear();
  const events = [];
  const warnings = [];

  const firstHistoryYear = recentOnly ? currentYear : FIRST_HISTORY_YEAR;
  const maxPages = recentOnly ? 1 : MAX_PAGES_PER_YEAR;
  for (let year = currentYear; year >= firstHistoryYear; year -= 1) {
    const yearlyEvents = await collectPages(
      fetchImpl,
      (page) => `https://api.chzzk.naver.com/commercial/v1/product/purchase/history?page=${page}&size=${PAGE_SIZE}&searchYear=${year}`,
      normalizeGeneralDonation,
      { maxPages }
    );
    events.push(...yearlyEvents);
  }

  const firstPartyYear = recentOnly ? currentYear : FIRST_PARTY_YEAR;
  for (let year = currentYear; year >= firstPartyYear; year -= 1) {
    try {
      const yearlyParties = await collectPages(
        fetchImpl,
        (page) => `https://api.chzzk.naver.com/service/v1/donations/party-donations/my/completed?searchYear=${year}&page=${page}&size=${PAGE_SIZE}`,
        normalizePartyDonation,
        { maxPages }
      );
      events.push(...yearlyParties);
    } catch (error) {
      if (error?.code === "AUTH") throw error;
      warnings.push(`${year}년 파티 후원 내역을 일부 불러오지 못했습니다.`);
    }
  }

  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { events: uniqueEvents, warnings };
}

export const CHZZK_SYNC_CONSTANTS = Object.freeze({
  RUPA_CHANNEL_ID,
  FIRST_HISTORY_YEAR,
  FIRST_PARTY_YEAR
});
