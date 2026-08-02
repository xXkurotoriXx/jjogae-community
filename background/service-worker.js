import { clearEvents, deleteEventsByIds, getEvents, putEvents } from "./db.js";
import { fetchRupaCafeNotices, RUPA_CAFE_NOTICE_MENU_ID, RUPA_CAFE_NOTICE_MENU_NAME } from "./cafe-sync.js";
import { mergeCafeReadState, normalizeCafeReadState } from "./cafe-read-state.js";
import { fetchChzzkAccountState, syncRupaDonations } from "./chzzk-sync.js";
import { fetchRupaSubscription, isRupaSubscriptionFresh } from "./chzzk-subscription-sync.js";
import { fetchCommunityMedia, isMediaFresh } from "./media-sync.js";
import { fetchRupaLogPower, isLogPowerFresh, RUPA_CHANNEL_ID } from "./log-power-sync.js";
import { DEFAULT_COMMUNITY_SETTINGS, normalizeCommunitySettings, validateCommunitySettings } from "./settings.js";

const SETTINGS_KEY = "communitySettings";
const ACCOUNT_STATE_KEY = "communityAccountState";
const SYNC_META_KEY = "chzzkSyncMeta";
const MEDIA_STATE_KEY = "communityMediaState";
const POWER_STATE_KEY = "communityPowerState";
const CHZZK_SUBSCRIPTION_STATE_KEY = "communityChzzkSubscriptionState";
const CAFE_STATE_KEY = "communityCafeState";
const CAFE_READ_STATE_KEY = "communityCafeReadState";
const FULL_SYNC_STATE_KEY = "communityFullSyncState";
const FULL_SYNC_ALARM = "jjogae-community-full-sync";
const FULL_SYNC_INTERVAL_MINUTES = 5;
const CAFE_CACHE_MS = FULL_SYNC_INTERVAL_MINUTES * 60 * 1000;
const DONATION_TYPES = new Set(["CHAT", "VIDEO", "MISSION", "TTS", "PARTY"]);
let mediaRefreshPromise = null;
let powerRefreshPromise = null;
let subscriptionRefreshPromise = null;
let accountRefreshPromise = null;
let cafeRefreshPromise = null;
let syncStateUpdatePromise = Promise.resolve();

function safeText(value, maxLength = 300) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeCommunitySettings(stored[SETTINGS_KEY]);
}

async function getCafeReadState() {
  const stored = await chrome.storage.local.get(CAFE_READ_STATE_KEY);
  return normalizeCafeReadState(stored[CAFE_READ_STATE_KEY]);
}

async function markCafeNoticesRead(requestedIds) {
  const stored = await chrome.storage.local.get([CAFE_STATE_KEY, CAFE_READ_STATE_KEY]);
  const articles = Array.isArray(stored[CAFE_STATE_KEY]?.articles) ? stored[CAFE_STATE_KEY].articles : [];
  const availableIds = new Set(articles.map((article) => String(article?.articleId || "")).filter((id) => /^\d+$/.test(id)));
  const ids = [...new Set((Array.isArray(requestedIds) ? requestedIds : [])
    .map((id) => String(id || ""))
    .filter((id) => availableIds.has(id)))];
  const cafeReadState = mergeCafeReadState(stored[CAFE_READ_STATE_KEY], ids);
  await chrome.storage.local.set({ [CAFE_READ_STATE_KEY]: cafeReadState });
  return cafeReadState;
}

function validAccountNickname(value) {
  const nickname = safeText(value, 100).replace(/\s+/g, " ");
  if (!nickname || /^(?:프로필|네이버 게임 프로필|로그인|치지직|치즈|내 치즈|치즈팜|치트키|스튜디오|알림|설정|익명)$/i.test(nickname)) return "";
  return nickname;
}

async function getAccountState() {
  const stored = await chrome.storage.local.get(ACCOUNT_STATE_KEY);
  const state = stored[ACCOUNT_STATE_KEY];
  const nickname = validAccountNickname(state?.nickname);
  return nickname ? { ...state, nickname } : null;
}

async function refreshAccountState() {
  if (accountRefreshPromise) return accountRefreshPromise;
  accountRefreshPromise = (async () => {
    const previous = await getAccountState();
    try {
      const accountState = await fetchChzzkAccountState();
      await chrome.storage.local.set({ [ACCOUNT_STATE_KEY]: accountState });
      return accountState;
    } catch (error) {
      if (error?.code === "AUTH") {
        await chrome.storage.local.remove(ACCOUNT_STATE_KEY);
        return null;
      }
      return previous;
    }
  })();
  try {
    return await accountRefreshPromise;
  } finally {
    accountRefreshPromise = null;
  }
}

async function getSyncMeta() {
  const stored = await chrome.storage.local.get(SYNC_META_KEY);
  const value = stored[SYNC_META_KEY];
  return {
    lastSyncedAt: safeDate(value?.lastSyncedAt),
    total: Math.max(0, Number(value?.total || 0)),
    warnings: Array.isArray(value?.warnings) ? value.warnings.map((item) => safeText(item, 180)).slice(0, 10) : []
  };
}

async function getMediaState() {
  const stored = await chrome.storage.local.get(MEDIA_STATE_KEY);
  return stored[MEDIA_STATE_KEY] && typeof stored[MEDIA_STATE_KEY] === "object"
    ? stored[MEDIA_STATE_KEY]
    : { youtube: {}, chzzk: {}, updatedAt: "" };
}

async function refreshCafeNotices({ force = false } = {}) {
  if (cafeRefreshPromise) return cafeRefreshPromise;
  cafeRefreshPromise = (async () => {
    const stored = await chrome.storage.local.get(CAFE_STATE_KEY);
    const previous = stored[CAFE_STATE_KEY] || {};
    const previousNotices = previous.source === "naver-cafe-notice-board-api" ? previous : {};
    const age = Date.now() - new Date(previous.updatedAt || 0).getTime();
    if (!force
      && previous.source === "naver-cafe-notice-board-api"
      && !previous.error
      && age < CAFE_CACHE_MS) return previous;
    try {
      const articles = await fetchRupaCafeNotices({ perPage: 20 });
      const state = {
        source: "naver-cafe-notice-board-api",
        menuId: RUPA_CAFE_NOTICE_MENU_ID,
        menuName: RUPA_CAFE_NOTICE_MENU_NAME,
        found: articles.length,
        articles: articles.slice(0, 20),
        latestArticleId: articles[0]?.articleId || previousNotices.latestArticleId || "",
        updatedAt: new Date().toISOString(),
        error: ""
      };
      await chrome.storage.local.set({ [CAFE_STATE_KEY]: state });
      return state;
    } catch (error) {
      const state = {
        ...previousNotices,
        source: "naver-cafe-notice-board-api",
        menuId: RUPA_CAFE_NOTICE_MENU_ID,
        menuName: RUPA_CAFE_NOTICE_MENU_NAME,
        found: Array.isArray(previousNotices.articles) ? previousNotices.articles.length : 0,
        articles: Array.isArray(previousNotices.articles) ? previousNotices.articles : [],
        latestArticleId: previousNotices.latestArticleId || "",
        checkedAt: new Date().toISOString(),
        error: safeText(error?.message || "루파 카페 공지글을 확인하지 못했습니다.", 180)
      };
      await chrome.storage.local.set({ [CAFE_STATE_KEY]: state });
      return state;
    }
  })();
  try {
    return await cafeRefreshPromise;
  } finally {
    cafeRefreshPromise = null;
  }
}

async function refreshMedia({ force = false } = {}) {
  if (mediaRefreshPromise) return mediaRefreshPromise;
  mediaRefreshPromise = (async () => {
    const previousState = await getMediaState();
    const livePreviewMissing = previousState?.chzzk?.isLive
      && previousState?.chzzk?.primary?.kind === "live"
      && !previousState?.chzzk?.primary?.thumbnailUrl;
    const audienceMissing = previousState?.chzzk?.followerCount === null
      || previousState?.chzzk?.followerCount === undefined
      || previousState?.chzzk?.followerCount === ""
      || !previousState?.youtube?.subscriberCountText;
    if (!force && !livePreviewMissing && !audienceMissing && isMediaFresh(previousState)) return previousState;
    const media = await fetchCommunityMedia({ previousState });
    await chrome.storage.local.set({ [MEDIA_STATE_KEY]: media });
    return media;
  })();
  try {
    return await mediaRefreshPromise;
  } finally {
    mediaRefreshPromise = null;
  }
}

async function getPowerState() {
  const stored = await chrome.storage.local.get(POWER_STATE_KEY);
  return stored[POWER_STATE_KEY] && typeof stored[POWER_STATE_KEY] === "object"
    ? stored[POWER_STATE_KEY]
    : null;
}

async function refreshPowerBalance({ force = false } = {}) {
  if (powerRefreshPromise) return powerRefreshPromise;
  powerRefreshPromise = (async () => {
    const storedPrevious = await getPowerState();
    const previous = storedPrevious?.source === "chzzk-balance-api"
      && storedPrevious?.channelId === RUPA_CHANNEL_ID
      ? storedPrevious
      : null;
    if (!force && isLogPowerFresh(previous)) return previous;
    try {
      const powerState = await fetchRupaLogPower();
      await chrome.storage.local.set({ [POWER_STATE_KEY]: powerState });
      return powerState;
    } catch (error) {
      const powerState = {
        ...(previous || {
          source: "chzzk-balance-api",
          channelId: RUPA_CHANNEL_ID,
          balance: null,
          exact: false,
          listed: null,
          active: null,
          updatedAt: ""
        }),
        checkedAt: new Date().toISOString(),
        error: safeText(error?.message || "통나무 보유량을 확인하지 못했습니다.", 180)
      };
      await chrome.storage.local.set({ [POWER_STATE_KEY]: powerState });
      return powerState;
    }
  })();
  try {
    return await powerRefreshPromise;
  } finally {
    powerRefreshPromise = null;
  }
}

async function refreshChzzkSubscription({ force = false } = {}) {
  if (subscriptionRefreshPromise) return subscriptionRefreshPromise;
  subscriptionRefreshPromise = (async () => {
    const stored = await chrome.storage.local.get(CHZZK_SUBSCRIPTION_STATE_KEY);
    const storedPrevious = stored[CHZZK_SUBSCRIPTION_STATE_KEY] || null;
    const previous = storedPrevious?.source === "chzzk-subscription-api"
      && storedPrevious?.channelId === RUPA_CHANNEL_ID
      ? storedPrevious
      : null;
    if (!force && isRupaSubscriptionFresh(previous)) return previous;
    try {
      const state = await fetchRupaSubscription();
      await chrome.storage.local.set({ [CHZZK_SUBSCRIPTION_STATE_KEY]: state });
      return state;
    } catch (error) {
      const checkedAt = new Date().toISOString();
      const state = {
        ...(previous || {
          source: "chzzk-subscription-api",
          channelId: RUPA_CHANNEL_ID,
          channelName: "아홀로 루파",
          subscribed: null,
          subscriptionDisabled: false,
          tierNo: null,
          tierName: "",
          status: "",
          renewalType: "",
          renewalDate: "",
          switchTierName: "",
          totalMonth: null,
          deferred: false,
          subscriptionGift: false,
          updatedAt: ""
        }),
        checkedAt,
        error: safeText(error?.message || "치지직 구독 정보를 확인하지 못했습니다.", 180),
        errorCode: safeText(error?.code || "SUBSCRIPTION_SYNC_FAILED", 80)
      };
      await chrome.storage.local.set({ [CHZZK_SUBSCRIPTION_STATE_KEY]: state });
      return state;
    }
  })();
  try {
    return await subscriptionRefreshPromise;
  } finally {
    subscriptionRefreshPromise = null;
  }
}

async function syncCommunityDonations({ replaceSynced = false, recentOnly = false } = {}) {
  const existing = await getEvents({ limit: 20000 });
  const existingIds = new Set(existing.map((event) => event.id));
  const { events, warnings } = await syncRupaDonations({ recentOnly });
  const syncedIds = new Set(events.map((event) => event.id));
  const previousSynced = existing.filter((event) => event.source === "chzzk-sync");
  const staleIds = replaceSynced
    ? previousSynced.filter((event) => !syncedIds.has(event.id)).map((event) => event.id)
    : [];
  const added = events.reduce((count, event) => count + (existingIds.has(event.id) ? 0 : 1), 0);
  const written = await putEvents(events);
  if (staleIds.length) await deleteEventsByIds(staleIds);
  const total = recentOnly
    ? new Set([...previousSynced.map((event) => event.id), ...events.map((event) => event.id)]).size
    : events.length;
  const sync = { lastSyncedAt: new Date().toISOString(), total, warnings };
  await chrome.storage.local.set({ [SYNC_META_KEY]: sync });
  return { added, written, replaced: previousSynced.length, removed: staleIds.length, total, warnings, sync };
}

function recordSyncCompleted(source) {
  syncStateUpdatePromise = syncStateUpdatePromise.catch(() => null).then(async () => {
    const completedAt = new Date().toISOString();
    const stored = await chrome.storage.local.get(FULL_SYNC_STATE_KEY);
    const previous = stored[FULL_SYNC_STATE_KEY] || {};
    const fullSyncState = {
      updatedAt: completedAt,
      lastAutomaticAt: source === "automatic" ? completedAt : previous.lastAutomaticAt || "",
      lastManualAt: source === "manual" ? completedAt : previous.lastManualAt || ""
    };
    await chrome.storage.local.set({ [FULL_SYNC_STATE_KEY]: fullSyncState });
    return fullSyncState;
  });
  return syncStateUpdatePromise;
}

async function syncAllCommunityData({ source = "manual", fullDonations = source === "manual" } = {}) {
  const results = await Promise.allSettled([
    refreshAccountState(),
    syncCommunityDonations({ replaceSynced: fullDonations, recentOnly: !fullDonations }),
    refreshPowerBalance({ force: true }),
    refreshChzzkSubscription({ force: true }),
    refreshMedia({ force: true }),
    refreshCafeNotices({ force: true })
  ]);
  const [accountResult, donationsResult, powerResult, subscriptionResult, mediaResult, cafeResult] = results;
  const warnings = results
    .map((result) => result.status === "rejected" ? safeText(result.reason?.message || result.reason || "동기화 실패", 180) : "")
    .filter(Boolean);
  const donations = donationsResult.status === "fulfilled" ? donationsResult.value : null;
  const accountState = accountResult.status === "fulfilled" ? accountResult.value : null;
  const powerState = powerResult.status === "fulfilled" ? powerResult.value : null;
  const chzzkSubscriptionState = subscriptionResult.status === "fulfilled" ? subscriptionResult.value : null;
  const media = mediaResult.status === "fulfilled" ? mediaResult.value : null;
  const cafeState = cafeResult.status === "fulfilled" ? cafeResult.value : null;
  if (donations?.warnings?.length) warnings.push(...donations.warnings);
  if (powerState?.error) warnings.push(powerState.error);
  if (chzzkSubscriptionState?.error) warnings.push(chzzkSubscriptionState.error);
  if (media?.youtube?.error) warnings.push(media.youtube.error);
  if (media?.chzzk?.error) warnings.push(media.chzzk.error);
  if (cafeState?.error) warnings.push(cafeState.error);
  const fullSyncState = await recordSyncCompleted(source);
  return { accountState, donations, powerState, chzzkSubscriptionState, media, cafeState, fullSyncState, warnings: [...new Set(warnings)] };
}

function normalizeCheeseEvent(value, { imported = false } = {}) {
  if (!value || typeof value !== "object") return null;
  const amount = Number(value.amount);
  const timestamp = safeDate(value.timestamp);
  const donationType = safeText(value.donationType, 20).toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || !timestamp) return null;
  if (!DONATION_TYPES.has(donationType)) return null;

  const originalId = safeText(value.id, 180);
  const id = imported && /^manual:[\w:-]+$/.test(originalId)
    ? originalId
    : `manual:${Date.now()}:${crypto.randomUUID()}`;
  return {
    id,
    type: "cheese",
    source: imported ? "manual-import" : "manual-entry",
    timestamp,
    amount: Math.round(amount),
    donationType,
    donationSubType: donationType,
    streamer: "아홀로 루파",
    message: safeText(value.message, 500)
  };
}

function summarize(events) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeek = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const startMonth = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  let cheeseTotal = 0;
  let cheeseToday = 0;
  let cheeseWeek = 0;
  let cheeseMonth = 0;

  for (const event of events) {
    if (event.type !== "cheese") continue;
    const amount = Math.max(0, Number(event.amount || 0));
    const time = new Date(event.timestamp).getTime();
    cheeseTotal += amount;
    if (time >= startToday) cheeseToday += amount;
    if (time >= startWeek) cheeseWeek += amount;
    if (time >= startMonth) cheeseMonth += amount;
  }
  return { cheeseTotal, cheeseToday, cheeseWeek, cheeseMonth, cheeseEntries: events.length };
}

function isExtensionPage(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url || "");
    return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id;
  } catch {
    return false;
  }
}

async function ensureFullSyncAlarm() {
  await chrome.alarms.create(FULL_SYNC_ALARM, {
    delayInMinutes: FULL_SYNC_INTERVAL_MINUTES,
    periodInMinutes: FULL_SYNC_INTERVAL_MINUTES
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeCommunitySettings(stored[SETTINGS_KEY] || DEFAULT_COMMUNITY_SETTINGS) });
  await ensureFullSyncAlarm();
  await syncAllCommunityData({ source: "startup", fullDonations: false });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureFullSyncAlarm();
  await syncAllCommunityData({ source: "startup", fullDonations: false });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FULL_SYNC_ALARM) return;
  syncAllCommunityData({ source: "automatic", fullDonations: false })
    .catch((error) => console.warn("쪼개 상황실 커뮤니티판 5분 자동 동기화 실패", error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!isExtensionPage(sender)) throw new Error("허용되지 않은 요청입니다.");

    switch (message?.type) {
      case "GET_SNAPSHOT": {
        const [events, settings, sync, accountState, media, powerState, chzzkSubscriptionState, cafeState, cafeReadState, syncState] = await Promise.all([
          getEvents({ limit: Math.min(20000, Math.max(1, Number(message.limit || 20000))) }),
          getSettings(),
          getSyncMeta(),
          refreshAccountState(),
          refreshMedia(),
          refreshPowerBalance(),
          refreshChzzkSubscription(),
          refreshCafeNotices(),
          getCafeReadState(),
          chrome.storage.local.get(FULL_SYNC_STATE_KEY)
        ]);
        sendResponse({
          ok: true,
          events,
          settings,
          sync,
          accountState,
          media,
          powerState,
          chzzkSubscriptionState,
          cafeState,
          cafeReadState,
          fullSyncState: syncState[FULL_SYNC_STATE_KEY] || null,
          summary: summarize(events)
        });
        break;
      }
      case "REFRESH_MEDIA": {
        const media = await refreshMedia({ force: message.force === true });
        sendResponse({ ok: true, media });
        break;
      }
      case "SYNC_CHZZK_DONATIONS": {
        sendResponse({ ok: true, ...(await syncCommunityDonations()) });
        break;
      }
      case "FORCE_SYNC_ALL_DATA": {
        sendResponse({
          ok: true,
          forced: true,
          mode: "manual-full",
          ...(await syncAllCommunityData({ source: "manual", fullDonations: true }))
        });
        break;
      }
      case "ADD_CHEESE_ENTRY": {
        const event = normalizeCheeseEvent(message.entry);
        if (!event) throw new Error("날짜, 치즈 수량과 후원 종류를 확인해 주세요.");
        await putEvents([event]);
        sendResponse({ ok: true, event });
        break;
      }
      case "DELETE_EVENT": {
        const id = safeText(message.id, 180);
        if (!/^(?:manual|chzzk):[\w:-]+$/.test(id)) throw new Error("삭제할 기록을 확인하지 못했습니다.");
        const deleted = await deleteEventsByIds([id]);
        sendResponse({ ok: true, deleted });
        break;
      }
      case "IMPORT_EVENTS": {
        const incoming = Array.isArray(message.events) ? message.events.slice(0, 10000) : [];
        const normalized = incoming.map((event) => normalizeCheeseEvent(event, { imported: true })).filter(Boolean);
        const unique = [...new Map(normalized.map((event) => [event.id, event])).values()];
        const written = await putEvents(unique);
        sendResponse({ ok: true, written, rejected: incoming.length - unique.length });
        break;
      }
      case "SAVE_SETTINGS": {
        const settings = validateCommunitySettings(message.settings);
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        sendResponse({ ok: true, settings });
        break;
      }
      case "MARK_CAFE_NOTICES_READ": {
        const cafeReadState = await markCafeNoticesRead(message.ids);
        sendResponse({ ok: true, cafeReadState });
        break;
      }
      case "CLEAR_DATA": {
        await clearEvents();
        await chrome.storage.local.clear();
        sendResponse({ ok: true });
        break;
      }
      case "OPEN_DASHBOARD": {
        await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html?mode=full") });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "알 수 없는 요청입니다." });
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

ensureFullSyncAlarm().catch((error) => {
  console.warn("쪼개 상황실 커뮤니티판 5분 자동 동기화 예약 실패", error);
});
