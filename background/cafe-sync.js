export const RUPA_CAFE_ID = "31522940";
export const RUPA_CAFE_SLUG = "aholorupacafe";
export const RUPA_CAFE_URL = `https://cafe.naver.com/${RUPA_CAFE_SLUG}`;
export const RUPA_CAFE_NOTICE_MENU_ID = "22";
export const RUPA_CAFE_NOTICE_MENU_NAME = "공지&이벤트 소식";
export const RUPA_CAFE_NOTICE_API = `https://apis.naver.com/cafe-web/cafe-boardlist-api/v1/cafes/${RUPA_CAFE_ID}/menus/${RUPA_CAFE_NOTICE_MENU_ID}/articles`;

export class CafeSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CafeSyncError";
    this.code = code;
  }
}

function asIsoDate(value, fallback = new Date()) {
  const number = Number(value);
  const normalized = Number.isFinite(number) && number > 0
    ? new Date(number < 10_000_000_000 ? number * 1000 : number)
    : new Date(value || fallback);
  return Number.isNaN(normalized.getTime()) ? fallback.toISOString() : normalized.toISOString();
}

export function parseRupaCafeNotices(payload, now = new Date()) {
  const articles = payload?.result?.articleList || payload?.message?.result?.articleList;
  if (!Array.isArray(articles)) return [];

  return [...new Map(articles.map((article) => {
    if (article?.type && article.type !== "ARTICLE") return null;
    const item = article?.item || article;
    const articleId = String(item?.articleid ?? item?.articleId ?? "");
    const title = String(item?.subject || "").trim().replace(/\s+/g, " ").slice(0, 300);
    const menuId = String(item?.menuid ?? item?.menuId ?? "");
    const receivedMenuName = String(item?.menuName || "").trim().slice(0, 120);
    const isNoticeMenu = menuId === RUPA_CAFE_NOTICE_MENU_ID
      || (!menuId && /공지/.test(receivedMenuName));
    if (!/^\d+$/.test(articleId) || !title || !isNoticeMenu) return null;
    return [articleId, {
      id: `cafe:${RUPA_CAFE_ID}:${articleId}`,
      type: "cafe_notice",
      source: "naver-cafe-notice-board-api",
      timestamp: asIsoDate(item.writeDateTimestamp || item.writeDate || item.createdAt, now),
      title,
      url: `https://cafe.naver.com/f-e/cafes/${RUPA_CAFE_ID}/articles/${articleId}?referrerAllArticles=true`,
      cafe: "루파의 쪼개 양식장",
      cafeId: RUPA_CAFE_ID,
      articleId,
      menuId: RUPA_CAFE_NOTICE_MENU_ID,
      menuName: receivedMenuName || RUPA_CAFE_NOTICE_MENU_NAME,
      author: String(item.writerInfo?.nickName || item.writerInfo?.nickname || item.writerNickname || item.writerName || "").trim().slice(0, 100)
    }];
  }).filter(Boolean)).values()]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export async function fetchRupaCafeNotices({ fetchImpl = fetch, perPage = 20 } = {}) {
  const url = new URL(RUPA_CAFE_NOTICE_API);
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", String(Math.min(20, Math.max(1, perPage))));
  url.searchParams.set("viewType", "L");

  const response = await fetchImpl(url.href, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" }
  });
  if (response.status === 401 || response.status === 403) {
    throw new CafeSyncError("AUTH", "네이버 카페 공지 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (!response.ok) throw new CafeSyncError("HTTP", `네이버 카페 API 오류 (${response.status})`);

  const payload = await response.json();
  const apiError = payload?.error || payload?.message?.error;
  const apiErrorCode = String(apiError?.errorCode || apiError?.code || "").trim();
  const hasArticleList = Array.isArray(payload?.result?.articleList)
    || Array.isArray(payload?.message?.result?.articleList);
  if (!hasArticleList && apiError) {
    throw new CafeSyncError("API", String(apiError.message || apiError.msg || `네이버 카페 API 오류 (${apiErrorCode || "알 수 없음"})`));
  }
  if (!hasArticleList) {
    throw new CafeSyncError("FORMAT", "네이버 카페 공지 응답 형식이 변경되었습니다.");
  }
  return parseRupaCafeNotices(payload);
}
