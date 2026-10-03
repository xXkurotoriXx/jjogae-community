const RUPA_CHANNEL_ID = "3e948667805e7627459a599018d05853";
const API_ROOT = "https://api.chzzk.naver.com";
const REQUEST_TIMEOUT_MS = 15_000;
const LIVE_DETAIL_URL = `${API_ROOT}/service/v3.3/channels/${RUPA_CHANNEL_ID}/live-detail?cu=false&tm=false`;

function safeImage(value) {
  try {
    const url = new URL(String(value || "").replaceAll("{type}", "480"));
    if (url.protocol !== "https:" || url.username || url.password || url.href.length > 1500) return "";
    return url.href;
  } catch {
    return "";
  }
}

function safeTimestamp(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function sourceMatches(item) {
  const sourceIds = [item?.channelId, item?.channel?.channelId, item?.sourceChannelId, item?.sourceChannel?.channelId];
  return sourceIds.every((value) => value === null || value === undefined || value === ""
    || String(value).toLowerCase() === RUPA_CHANNEL_ID);
}

function findItems(payload, predicate) {
  const queue = [payload];
  const visited = new Set();
  const found = [];
  let position = 0;
  while (position < queue.length && visited.size < 4000 && found.length < 200) {
    const current = queue[position++];
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (predicate(current)) found.push(current);
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return found;
}

function normalizeVods(payloads) {
  const normalized = [];
  for (const payload of payloads) {
    for (const item of findItems(payload, (value) => value.videoNo !== undefined || value.videoId !== undefined)) {
      const id = String(item.videoNo ?? item.videoId ?? "");
      if (!/^\d+$/.test(id) || !sourceMatches(item)) continue;
      normalized.push({
        kind: "vod",
        id,
        title: String(item.videoTitle || item.title || "아홀로 루파 최근 다시보기").slice(0, 300),
        url: `https://chzzk.naver.com/video/${id}`,
        thumbnailUrl: safeImage(item.thumbnailImageUrl || item.thumbnailUrl || item.liveImageUrl),
        publishedAt: safeTimestamp(item.publishDate || item.publishDateAt || item.createdDate || item.createdAt)
      });
    }
  }
  return uniqueLatest(normalized).slice(0, 36);
}

function normalizeClips(payload) {
  const normalized = [];
  for (const item of findItems(payload, (value) => value.clipUID !== undefined || value.clipUid !== undefined)) {
    const id = String(item.clipUID || item.clipUid || "");
    if (!/^[A-Za-z0-9_-]{5,80}$/.test(id) || !sourceMatches(item)) continue;
    normalized.push({
      kind: "clip",
      id,
      title: String(item.clipTitle || item.title || "아홀로 루파 최근 클립").slice(0, 300),
      url: `https://chzzk.naver.com/clips/${id}`,
      thumbnailUrl: safeImage(item.thumbnailImageUrl || item.thumbnailUrl || item.clipThumbnailImageUrl),
      publishedAt: safeTimestamp(item.createdDate || item.createdAt || item.publishDate || item.publishDateAt)
    });
  }
  return uniqueLatest(normalized).slice(0, 15);
}

function uniqueLatest(items) {
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push({ item, position: unique.length });
  }
  unique.sort((left, right) => {
    const leftTime = Date.parse(left.item.publishedAt) || 0;
    const rightTime = Date.parse(right.item.publishedAt) || 0;
    return rightTime - leftTime || left.position - right.position;
  });
  return unique.map(({ item }) => item);
}

function normalizeLive(payload) {
  if (!sourceMatches(payload)) return { isLive: null, primary: null };
  const status = String(payload?.status || payload?.liveStatus || "").toUpperCase();
  if (["CLOSE", "CLOSED", "ENDED", "OFFLINE"].includes(status)) return { isLive: false, primary: null };
  if (!["OPEN", "STARTED", "LIVE"].includes(status)) return { isLive: null, primary: null };
  return {
    isLive: true,
    primary: {
      kind: "live",
      id: RUPA_CHANNEL_ID,
      title: String(payload.liveTitle || payload.title || "아홀로 루파 라이브").slice(0, 300),
      url: `https://chzzk.naver.com/live/${RUPA_CHANNEL_ID}`,
      thumbnailUrl: safeImage(payload.liveImageUrl || payload.thumbnailImageUrl || payload.channelImageUrl),
      publishedAt: safeTimestamp(payload.openDate || payload.liveOpenDate || payload.startedAt)
    }
  };
}

async function fetchContent(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { credentials: "omit", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`치지직 공개 API 오류 (${response.status})`);
    const payload = await response.json();
    if (payload?.code !== undefined && Number(payload.code) !== 200) {
      throw new Error(`치지직 공개 API 오류 (${String(payload.code).slice(0, 20)})`);
    }
    return payload?.content ?? payload ?? {};
  } catch (error) {
    if (controller.signal.aborted) throw new Error("조회 시간이 초과됐습니다.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadRupaModeMedia(fetchImpl = fetch) {
  const requests = [
    ["채널 정보", `${API_ROOT}/service/v1/channels/${RUPA_CHANNEL_ID}`],
    ["방송 상태", `${API_ROOT}/polling/v2/channels/${RUPA_CHANNEL_ID}/live-status`],
    ...[0, 1].map((page) => ["다시보기", `${API_ROOT}/service/v1/channels/${RUPA_CHANNEL_ID}/videos?sortType=LATEST&pagingType=PAGE&page=${page}&size=18&publishDateAt=&videoType=`]),
    ["클립", `${API_ROOT}/service/v1/channels/${RUPA_CHANNEL_ID}/clips?clipUID=&filterType=ALL&orderType=RECENT&size=15&readCount=`]
  ];
  const results = await Promise.allSettled(requests.map(([, url]) => fetchContent(fetchImpl, url)));
  const errors = [];
  const contents = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const message = String(result.reason?.message || "조회에 실패했습니다.").slice(0, 160);
    errors.push(`${requests[index][0]}: ${message}`);
    return {};
  });
  const channelImageUrl = sourceMatches(contents[0])
    ? safeImage(contents[0]?.channelImageUrl || contents[0]?.channel?.channelImageUrl)
    : "";
  let { isLive, primary } = normalizeLive(contents[1]);
  if (results[1].status === "fulfilled" && isLive === null) errors.push("방송 상태를 확인하지 못했습니다.");

  if (isLive === true && !primary.thumbnailUrl) {
    try {
      const detail = normalizeLive(await fetchContent(fetchImpl, LIVE_DETAIL_URL));
      if (detail.isLive === true) primary = {
        ...primary,
        thumbnailUrl: detail.primary.thumbnailUrl,
        publishedAt: primary.publishedAt || detail.primary.publishedAt,
        title: primary.title === "아홀로 루파 라이브" ? detail.primary.title : primary.title
      };
    } catch (error) {
      errors.push(`라이브 미리보기: ${String(error?.message || "조회에 실패했습니다.").slice(0, 160)}`);
    }
  }

  return {
    isLive,
    primary,
    channelImageUrl,
    vods: normalizeVods(contents.slice(2, 4)),
    clips: normalizeClips(contents[4]),
    updatedAt: new Date().toISOString(),
    error: errors.join(" / ").slice(0, 600)
  };
}
