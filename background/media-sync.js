import { parsePublicSubscriberCountText } from "./youtube-count.js";

export const MEDIA_CACHE_MS = 5 * 60 * 1000;
export const RUPA_CHANNEL_ID = "3e948667805e7627459a599018d05853";
export const RUPA_YOUTUBE_URL = "https://www.youtube.com/@%EC%95%84%ED%99%80%EB%A1%9C_%EB%A3%A8%ED%8C%8C";

const LIVE_URL = `https://api.chzzk.naver.com/polling/v2/channels/${RUPA_CHANNEL_ID}/live-status`;
const LIVE_DETAIL_URL = `https://api.chzzk.naver.com/service/v3.3/channels/${RUPA_CHANNEL_ID}/live-detail?cu=false&tm=false`;
const VOD_URL = `https://api.chzzk.naver.com/service/v1/channels/${RUPA_CHANNEL_ID}/videos?sortType=LATEST&pagingType=PAGE&page=0&size=18&publishDateAt=&videoType=`;
const CLIP_URL = `https://api.chzzk.naver.com/service/v1/channels/${RUPA_CHANNEL_ID}/clips?clipUID=&filterType=ALL&orderType=RECENT&size=15&readCount=`;
const CHANNEL_URL = `https://api.chzzk.naver.com/service/v1/channels/${RUPA_CHANNEL_ID}`;

function safeTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function safeImage(value) {
  try {
    const url = new URL(String(value || "").replaceAll("{type}", "480"));
    return url.protocol === "https:" ? url.href.slice(0, 1500) : "";
  } catch {
    return "";
  }
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
}

function findNestedObjects(value, predicate, maxResults = 60) {
  const queue = [value];
  const visited = new Set();
  const results = [];
  while (queue.length && results.length < maxResults) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (predicate(current)) results.push(current);
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return results;
}

async function fetchJsonContent(fetchImpl, url) {
  const response = await fetchImpl(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`치지직 미디어 오류 (${response.status})`);
  const payload = await response.json();
  return payload?.content ?? payload;
}

export function isMediaFresh(state, nowMs = Date.now()) {
  const updatedAt = new Date(state?.updatedAt || 0).getTime();
  return Number.isFinite(updatedAt) && updatedAt > 0 && nowMs - updatedAt < MEDIA_CACHE_MS;
}

export function parseLatestYouTubeEntry(xml, channelId, now = new Date()) {
  const entry = String(xml || "").match(/<entry>([\s\S]*?)<\/entry>/i)?.[1] || "";
  const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i)?.[1]?.trim()
    || entry.match(/<id>yt:video:([^<]+)<\/id>/i)?.[1]?.trim()
    || "";
  const title = decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
  const publishedAt = safeTimestamp(entry.match(/<published>([^<]+)<\/published>/i)?.[1]);
  if (!/^[\w-]{6,20}$/.test(videoId) || !title) throw new Error("YouTube 최신 영상을 읽지 못했습니다.");
  return {
    channelId,
    videoId,
    title: title.slice(0, 300),
    publishedAt: publishedAt || now.toISOString(),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    updatedAt: now.toISOString(),
    error: ""
  };
}

async function fetchYouTube(fetchImpl, previous, now) {
  try {
    const pageResponse = await fetchImpl(`${RUPA_YOUTUBE_URL}?hl=en`, { credentials: "omit" });
    if (!pageResponse.ok) throw new Error(`YouTube 채널 오류 (${pageResponse.status})`);
    const html = await pageResponse.text();
    const channelId = html.match(/feeds\/videos\.xml\?channel_id=(UC[\w-]{20,30})/i)?.[1]
      || html.match(/"(?:channelId|externalId|browseId)"\s*:\s*"(UC[\w-]{20,30})"/i)?.[1]
      || html.match(/\/channel\/(UC[\w-]{20,30})/i)?.[1]
      || String(previous?.channelId || "");
    if (!/^UC[\w-]{20,30}$/.test(channelId)) throw new Error("YouTube 채널 ID를 확인하지 못했습니다.");
    const subscriber = parseYouTubeSubscriberCount(html);
    const feedResponse = await fetchImpl(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { credentials: "omit" });
    if (!feedResponse.ok) throw new Error(`YouTube RSS 오류 (${feedResponse.status})`);
    return {
      ...parseLatestYouTubeEntry(await feedResponse.text(), channelId, now),
      subscriberCount: subscriber.text ? subscriber.count : previous?.subscriberCount ?? null,
      subscriberCountText: subscriber.text || previous?.subscriberCountText || "",
      subscriberUpdatedAt: subscriber.text ? now.toISOString() : previous?.subscriberUpdatedAt || ""
    };
  } catch (error) {
    return { ...(previous || {}), checkedAt: now.toISOString(), error: error.message };
  }
}

export function parseYouTubeSubscriberCount(html) {
  const source = String(html || "");
  const headerMarkers = ['"header":{"pageHeaderRenderer"', '"c4TabbedHeaderRenderer"'];
  let raw = "";
  for (const marker of headerMarkers) {
    const start = source.indexOf(marker);
    if (start < 0) continue;
    const header = source.slice(start, start + 50_000);
    for (const match of header.matchAll(/"(?:content|simpleText|label)":"((?:\\.|[^"\\])*)"/gi)) {
      let value = match[1];
      try {
        value = JSON.parse(`"${value}"`);
      } catch {
        // Use the captured text when it contains no JSON escapes.
      }
      const subscriber = parsePublicSubscriberCountText(value);
      if (subscriber.text) {
        raw = value;
        break;
      }
    }
    if (raw) break;
  }
  return parsePublicSubscriberCountText(raw);
}

export function parseLiveStatus(payload) {
  const content = payload?.content ?? payload ?? {};
  const isLive = ["OPEN", "STARTED", "LIVE"].includes(String(content.status || content.liveStatus || "").toUpperCase());
  if (!isLive) return { isLive: false, primary: null };
  return {
    isLive: true,
    primary: {
      kind: "live",
      id: RUPA_CHANNEL_ID,
      title: String(content.liveTitle || content.title || "아홀로 루파 라이브").slice(0, 300),
      url: `https://chzzk.naver.com/live/${RUPA_CHANNEL_ID}`,
      thumbnailUrl: safeImage(content.liveImageUrl || content.thumbnailImageUrl || content.channelImageUrl),
      publishedAt: safeTimestamp(content.openDate || content.liveOpenDate || content.startedAt)
    }
  };
}

export function parseLatestVod(payload) {
  const item = findNestedObjects(payload, (candidate) =>
    (candidate.videoNo != null || candidate.videoId != null) && Boolean(candidate.videoTitle || candidate.title)
  )[0];
  const id = String(item?.videoNo ?? item?.videoId ?? "");
  if (!item || !/^\d+$/.test(id)) return null;
  return {
    kind: "vod",
    id,
    title: String(item.videoTitle || item.title || "최근 다시보기").slice(0, 300),
    url: `https://chzzk.naver.com/video/${id}`,
    thumbnailUrl: safeImage(item.thumbnailImageUrl || item.thumbnailUrl || item.liveImageUrl),
    publishedAt: safeTimestamp(item.publishDate || item.publishDateAt || item.createdDate || item.createdAt)
  };
}

export function parseLatestClip(payload) {
  const item = findNestedObjects(payload, (candidate) =>
    Boolean(candidate.clipUID || candidate.clipUid) && Boolean(candidate.clipTitle || candidate.title)
  )[0];
  const id = String(item?.clipUID || item?.clipUid || "");
  if (!item || !/^[\w-]{5,80}$/.test(id)) return null;
  return {
    id,
    title: String(item.clipTitle || item.title || "최근 클립").slice(0, 300),
    url: `https://chzzk.naver.com/clips/${id}`,
    thumbnailUrl: safeImage(item.thumbnailImageUrl || item.thumbnailUrl || item.clipThumbnailImageUrl),
    publishedAt: safeTimestamp(item.createdDate || item.createdAt || item.publishDate || item.publishDateAt)
  };
}

async function fetchChzzk(fetchImpl, previous, now) {
  const errors = [];
  let isLive = false;
  let primary = previous?.primary || null;
  let latestClip = previous?.latestClip || null;
  let followerCount = previous?.followerCount !== null
    && previous?.followerCount !== ""
    && Number.isFinite(Number(previous?.followerCount))
    ? Number(previous.followerCount)
    : null;
  let followerUpdatedAt = previous?.followerUpdatedAt || "";

  const [liveResult, clipResult, channelResult] = await Promise.allSettled([
    fetchJsonContent(fetchImpl, LIVE_URL),
    fetchJsonContent(fetchImpl, CLIP_URL),
    fetchJsonContent(fetchImpl, CHANNEL_URL)
  ]);

  if (liveResult.status === "fulfilled") {
    const live = parseLiveStatus(liveResult.value);
    isLive = live.isLive;
    if (live.primary) primary = live.primary;
    if (isLive && !primary?.thumbnailUrl) {
      try {
        const detail = parseLiveStatus(await fetchJsonContent(fetchImpl, LIVE_DETAIL_URL));
        if (detail.primary) primary = detail.primary;
      } catch {
        // Keep the live link/title from polling even if the optional preview lookup fails.
      }
    }
  } else {
    errors.push(liveResult.reason.message);
    isLive = Boolean(previous?.isLive && previous?.primary?.kind === "live");
  }

  if (clipResult.status === "fulfilled") {
    latestClip = parseLatestClip(clipResult.value) || latestClip;
  } else {
    errors.push(clipResult.reason.message);
  }

  if (channelResult.status === "fulfilled") {
    const nextFollowerCount = Number(channelResult.value?.followerCount);
    if (Number.isFinite(nextFollowerCount) && nextFollowerCount >= 0) {
      followerCount = Math.round(nextFollowerCount);
      followerUpdatedAt = now.toISOString();
    }
  }

  if (!isLive) {
    try {
      const vod = parseLatestVod(await fetchJsonContent(fetchImpl, VOD_URL));
      primary = vod || (previous?.primary?.kind === "vod" ? previous.primary : null);
    } catch (error) {
      errors.push(error.message);
      primary = previous?.primary?.kind === "vod" ? previous.primary : null;
    }
  }

  return {
    isLive,
    primary,
    latestClip,
    followerCount,
    followerUpdatedAt,
    updatedAt: now.toISOString(),
    error: errors.join(" / ")
  };
}

export async function fetchCommunityMedia({ fetchImpl = fetch, previousState = {}, now = new Date() } = {}) {
  const [youtube, chzzk] = await Promise.all([
    fetchYouTube(fetchImpl, previousState.youtube || {}, now),
    fetchChzzk(fetchImpl, previousState.chzzk || {}, now)
  ]);
  return { youtube, chzzk, updatedAt: now.toISOString() };
}
