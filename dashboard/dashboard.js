import { annualCountdown, elapsedDayText } from "./date-metrics.js";
import { normalizeSubscriptionStartDate } from "../background/settings.js";
import { unreadCafeNotices } from "../background/cafe-read-state.js";

const numberFormatter = new Intl.NumberFormat("ko-KR");
const dateFormatter = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const timeFormatter = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
const DASHBOARD_REFRESH_MS = 5 * 60 * 1000;
const RUPA_DEBUT_START = "2025-06-15";
const RUPA_BIRTHDAY_MONTH = 7;
const RUPA_BIRTHDAY_DAY = 23;

const DONATION_TYPE_META = Object.freeze({
  CHAT: { label: "채팅후원", color: "#00ffa3" },
  VIDEO: { label: "영상후원", color: "#3a86ff" },
  MISSION: { label: "미션후원", color: "#ff4f9a" },
  TTS: { label: "유료 TTS", color: "#ffbf59" },
  PARTY: { label: "파티후원", color: "#9a72ff" }
});

let snapshot = { events: [], settings: {}, summary: {}, accountState: null, media: { youtube: {}, chzzk: {} }, powerState: null, chzzkSubscriptionState: null, cafeState: null, cafeReadState: null, fullSyncState: null };
let currentEventPage = 1;
let toastTimer;
let snapshotLoadPromise = null;
let storageRefreshTimer = null;
let settingsFormDirty = false;
let selectedCafeNoticeIds = new Set();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localDateTimeInput(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function displayStartDate(value) {
  return value ? `${value.replaceAll("-", ".")} 시작` : "설정에서 시작일 입력";
}

function subscriptionSettingFields() {
  return [
    { key: "youtubeSubscriptionStart", label: "YouTube 구독 시작일", input: $("#setting-youtube-date"), preview: $("#setting-youtube-preview") },
    { key: "chzzkSubscriptionStart", label: "치지직 구독 시작일", input: $("#setting-chzzk-date"), preview: $("#setting-chzzk-preview") }
  ];
}

function renderSubscriptionSettingPreview(input, preview) {
  const raw = input.value.trim();
  const normalized = normalizeSubscriptionStartDate(raw);
  preview.classList.toggle("error", Boolean(raw && !normalized));
  input.setAttribute("aria-invalid", raw && !normalized ? "true" : "false");
  preview.textContent = !raw
    ? "YYYYMMDD 또는 YYYY-MM-DD"
    : normalized
    ? `${displayStartDate(normalized)} · ${elapsedDayText(normalized)}`
    : "실제 날짜를 YYYYMMDD 형식으로 입력해 주세요.";
}

function readSubscriptionSettings({ apply = false, report = false } = {}) {
  const settings = {};
  for (const field of subscriptionSettingFields()) {
    const raw = field.input.value.trim();
    const normalized = normalizeSubscriptionStartDate(raw);
    const error = raw && !normalized
      ? `${field.label}을 YYYYMMDD 또는 YYYY-MM-DD 형식의 실제 날짜로 입력해 주세요.`
      : "";
    field.input.setCustomValidity(error);
    renderSubscriptionSettingPreview(field.input, field.preview);
    if (error) {
      if (report) field.input.reportValidity();
      return null;
    }
    if (apply) field.input.value = normalized;
    settings[field.key] = normalized;
  }
  return settings;
}

function formatMediaDate(value, suffix) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${dateFormatter.format(date)} ${suffix}`;
}

function setMediaImage(image, placeholder, url, fallback) {
  const showPlaceholder = () => {
    image.hidden = true;
    image.removeAttribute("src");
    placeholder.hidden = false;
    placeholder.textContent = fallback;
  };
  if (!/^https:\/\//i.test(String(url || ""))) return showPlaceholder();
  image.onerror = showPlaceholder;
  image.src = url;
  image.hidden = false;
  placeholder.hidden = true;
}

function renderMedia() {
  const media = snapshot.media || {};
  const chzzk = media.chzzk || {};
  const primary = chzzk.primary || {};
  const isLive = Boolean(chzzk.isLive && primary.kind === "live");
  const chzzkLink = $("#chzzk-media-link");
  chzzkLink.href = /^https:\/\/chzzk\.naver\.com\/(?:live|video)\//.test(String(primary.url || ""))
    ? primary.url
    : "https://chzzk.naver.com/3e948667805e7627459a599018d05853";
  $("#chzzk-media-kicker").textContent = isLive ? "NOW LIVE" : primary.kind === "vod" ? "LATEST VOD" : "CHZZK";
  $("#chzzk-media-badge").textContent = isLive ? "LIVE" : "CHZZK";
  $("#chzzk-media-badge").classList.toggle("live", isLive);
  $("#chzzk-media-title").textContent = primary.title || "아홀로 루파 치지직";
  $("#chzzk-media-published").textContent = isLive
    ? "지금 방송 중 · 바로 보기"
    : formatMediaDate(primary.publishedAt, "공개") || (chzzk.error ? "방송 정보 갱신 실패" : "채널 열기");
  setMediaImage(
    $("#chzzk-media-thumbnail"),
    chzzkLink.querySelector(".compact-media-placeholder"),
    primary.thumbnailUrl,
    chzzk.error || "방송 정보를 확인 중입니다."
  );

  const clip = chzzk.latestClip || {};
  const clipLink = $("#chzzk-clip-link");
  clipLink.href = /^https:\/\/chzzk\.naver\.com\/clips\/[\w-]+$/.test(String(clip.url || ""))
    ? clip.url
    : "https://chzzk.naver.com/3e948667805e7627459a599018d05853/clips";
  $("#chzzk-clip-title").textContent = clip.title || "아홀로 루파 치지직 클립";
  $("#chzzk-clip-published").textContent = formatMediaDate(clip.publishedAt, "등록") || "클립 목록 열기";
  setMediaImage(
    $("#chzzk-clip-thumbnail"),
    clipLink.querySelector(".clip-placeholder"),
    clip.thumbnailUrl,
    chzzk.error || "최신 클립을 확인 중입니다."
  );

  const youtube = media.youtube || {};
  const videoId = /^[\w-]{6,20}$/.test(String(youtube.videoId || "")) ? youtube.videoId : "";
  const youtubeLink = $("#youtube-video-link");
  youtubeLink.href = videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : "https://www.youtube.com/@%EC%95%84%ED%99%80%EB%A1%9C_%EB%A3%A8%ED%8C%8C";
  $("#youtube-status").textContent = youtube.error ? "UPDATE FAILED" : videoId ? "LATEST VIDEO" : "YOUTUBE";
  $("#youtube-title").textContent = youtube.title || "아홀로 루파 YouTube";
  $("#youtube-published").textContent = formatMediaDate(youtube.publishedAt, "업로드") || "채널 열기";
  setMediaImage(
    $("#youtube-thumbnail"),
    youtubeLink.querySelector(".compact-media-placeholder"),
    youtube.thumbnailUrl || (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : ""),
    youtube.error || "최신 영상을 확인 중입니다."
  );
}

function donationTypeKey(event) {
  const value = String(event.donationType || "CHAT").toUpperCase();
  return DONATION_TYPE_META[value] ? value : "CHAT";
}

function formattedYmd(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? [match[1], match[2], match[3]].join(".") : "날짜 확인 필요";
}

function renderChzzkSubscription() {
  const state = snapshot.chzzkSubscriptionState;
  const tier = $("#chzzk-subscription-tier");
  const renewal = $("#chzzk-subscription-renewal");
  if (!state) {
    tier.textContent = "구독 정보를 확인 중";
    renewal.textContent = "현재 티어와 갱신일을 확인합니다.";
    return;
  }
  if (state.subscribed === false) {
    tier.textContent = "현재 구독 정보 없음";
    renewal.textContent = state.error || "아홀로 루파 채널의 정기구독 내역이 없습니다.";
    return;
  }
  if (!state.tierName) {
    tier.textContent = state.errorCode === "AUTH" ? "치지직 로그인 필요" : "구독 정보 확인 실패";
    renewal.textContent = state.error || "치지직 로그인 상태를 확인해 주세요.";
    return;
  }

  tier.textContent = state.tierName + " 티어 구독 중";
  const dateLabel = state.deferred
    ? "결제 재시도일"
    : state.subscriptionGift
    ? "선물 구독 만료일"
    : state.status === "CANCEL" || state.renewalType === "NON_RENEWAL"
    ? "구독 만료일"
    : "다음 갱신일";
  const details = state.renewalDate ? [dateLabel + " " + formattedYmd(state.renewalDate)] : [];
  if (state.switchTierName) details.push("다음 결제일부터 " + state.switchTierName);
  if (state.totalMonth !== null && state.totalMonth !== undefined && Number(state.totalMonth) > 0) {
    details.push("누적 구독 " + numberFormatter.format(Number(state.totalMonth)) + "개월");
  }
  if (state.error) details.push("마지막 확인 정보 · " + state.error);
  renewal.textContent = details.join(" · ") || "갱신일을 확인하지 못했습니다.";
}

function renderSummary() {
  const summary = snapshot.summary || {};
  $("#cheese-total").textContent = numberFormatter.format(summary.cheeseTotal || 0);
  $("#cheese-month").textContent = numberFormatter.format(summary.cheeseMonth || 0);
  $("#cheese-week").textContent = numberFormatter.format(summary.cheeseWeek || 0);
  $("#cheese-today").textContent = numberFormatter.format(summary.cheeseToday || 0);
  const followerCount = snapshot.media?.chzzk?.followerCount;
  $("#chzzk-follower-count").textContent = followerCount !== null
    && followerCount !== ""
    && Number.isFinite(Number(followerCount))
    ? `${numberFormatter.format(Number(followerCount))}명`
    : "확인 중";
  const subscriberCount = snapshot.media?.youtube?.subscriberCount;
  $("#youtube-subscriber-count").textContent = subscriberCount !== null
    && subscriberCount !== ""
    && Number.isFinite(Number(subscriberCount))
    ? `${numberFormatter.format(Number(subscriberCount))}명`
    : snapshot.media?.youtube?.subscriberCountText || "확인 중";
  $("#account-name").textContent = snapshot.accountState?.nickname || "로그인 확인 필요";

  const powerState = snapshot.powerState;
  $("#power-count").textContent = powerState?.listed === false
    ? "100 미만/미표시"
    : powerState?.balance !== null && powerState?.balance !== "" && Number.isFinite(Number(powerState?.balance))
    ? `${powerState.exact ? "" : "약 "}${numberFormatter.format(Number(powerState.balance))} 파워`
    : powerState?.error
    ? "갱신 실패"
    : "확인 필요";
  $("#power-balance").textContent = powerState?.error
    ? powerState.error
    : powerState?.listed === false
    ? "아홀로 루파가 100파워 이상 목록에 없습니다."
    : powerState?.updatedAt
    ? `마지막 확인 ${dateFormatter.format(new Date(powerState.updatedAt))} · 치지직 계정`
    : "대시보드를 열면 치지직 계정에서 확인합니다.";
  renderChzzkSubscription();

  const youtubeDate = snapshot.settings.youtubeSubscriptionStart || "";
  const chzzkDate = snapshot.settings.chzzkSubscriptionStart || "";
  $("#youtube-subscription-days").textContent = elapsedDayText(youtubeDate);
  $("#youtube-subscription-detail").textContent = displayStartDate(youtubeDate);
  $("#chzzk-subscription-days").textContent = elapsedDayText(chzzkDate);
  $("#chzzk-subscription-detail").textContent = displayStartDate(chzzkDate);
  $("#rupa-debut-days").textContent = elapsedDayText(RUPA_DEBUT_START);
  const birthday = annualCountdown(RUPA_BIRTHDAY_MONTH, RUPA_BIRTHDAY_DAY);
  $("#rupa-birthday-days").textContent = birthday.text;
  $("#rupa-birthday-detail").textContent = `${birthday.targetDate} 생일`;

  const syncStatus = $("#sync-status");
  const lastSyncedAt = snapshot.sync?.lastSyncedAt;
  if (lastSyncedAt) {
    syncStatus.textContent = `마지막 동기화 ${dateFormatter.format(new Date(lastSyncedAt))} · 아홀로 루파 후원 ${numberFormatter.format(snapshot.sync.total || 0)}건`;
    syncStatus.className = snapshot.sync?.warnings?.length ? "sync-status error" : "sync-status success";
  } else {
    syncStatus.textContent = "↻ 버튼은 캐시를 무시하는 수동 전체 새로고침입니다.";
    syncStatus.className = "sync-status";
  }
  const lastAutomaticAt = new Date(snapshot.fullSyncState?.lastAutomaticAt || "");
  const cafeSuffix = snapshot.cafeState?.error
    ? " · 카페 공지 확인 필요"
    : snapshot.cafeState?.updatedAt
    ? ` · 카페 공지 ${numberFormatter.format(snapshot.cafeState.found || 0)}개 확인`
    : "";
  $("#auto-sync-status").textContent = Number.isNaN(lastAutomaticAt.getTime())
    ? `자동 업데이트 대기 중 · 5분 간격${cafeSuffix}`
    : `마지막 자동 업데이트 ${timeFormatter.format(lastAutomaticAt)}${cafeSuffix}`;
}

function cafeArticleUrl(article) {
  const articleId = String(article?.articleId || "");
  return /^\d+$/.test(articleId)
    ? `https://cafe.naver.com/f-e/cafes/31522940/articles/${articleId}?referrerAllArticles=true`
    : "https://cafe.naver.com/aholorupacafe";
}

function cafeDateText(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "작성 시각 미확인" : dateFormatter.format(date);
}

function cafeNotices() {
  const articles = Array.isArray(snapshot.cafeState?.articles) ? snapshot.cafeState.articles : [];
  return unreadCafeNotices(articles, snapshot.cafeReadState)
    .filter((article) => /^\d+$/.test(String(article?.articleId || "")) && String(article?.title || "").trim())
    .slice()
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

function updateCafeReadControls(notices = cafeNotices()) {
  const visibleIds = new Set(notices.map((article) => String(article.articleId)));
  selectedCafeNoticeIds = new Set([...selectedCafeNoticeIds].filter((id) => visibleIds.has(id)));
  const selectedButton = $("#mark-selected-cafe-read");
  selectedButton.disabled = selectedCafeNoticeIds.size === 0;
  selectedButton.textContent = selectedCafeNoticeIds.size
    ? `선택 읽음 (${numberFormatter.format(selectedCafeNoticeIds.size)})`
    : "선택 읽음";
  $("#mark-all-cafe-read").disabled = notices.length === 0;
}

function renderCafeNotices() {
  const state = snapshot.cafeState || {};
  const notices = cafeNotices();
  const latest = notices[0];
  const found = Number.isFinite(Number(state.found)) ? Number(state.found) : notices.length;
  const checkedAt = state.updatedAt || state.checkedAt || "";
  const checkedLabel = checkedAt ? `마지막 확인 ${cafeDateText(checkedAt)}` : "아직 확인하지 않음";
  const summaryLink = $("#cafe-summary-link");

  $("#cafe-summary-count").textContent = state.error && !notices.length ? "확인 필요" : `${numberFormatter.format(notices.length)}개 미확인`;
  summaryLink.href = latest ? cafeArticleUrl(latest) : "https://cafe.naver.com/aholorupacafe";
  $("#cafe-summary-title").textContent = latest?.title || (state.error ? "카페 공지를 확인하지 못했습니다." : found ? "모든 카페 공지를 읽었습니다." : "현재 표시할 카페 공지가 없습니다.");
  $("#cafe-summary-meta").textContent = latest
    ? [latest.menuName || "공지&이벤트 소식", latest.author || "작성자 미확인", cafeDateText(latest.timestamp)].join(" · ")
    : state.error || checkedLabel;

  $("#cafe-history-meta").textContent = state.error
    ? `${checkedLabel} · ${state.error}`
    : `${numberFormatter.format(notices.length)}개 미확인 · 전체 ${numberFormatter.format(found)}개 수신 · ${checkedLabel}`;
  $("#cafe-notice-list").innerHTML = notices.length
    ? notices.map((article) => `<article class="event-item cafe-event">
      <label class="cafe-select"><input class="cafe-notice-check" type="checkbox" data-id="${escapeHtml(article.articleId)}" aria-label="읽음 처리할 공지 선택: ${escapeHtml(article.title)}"><span aria-hidden="true"></span></label>
      <a class="cafe-event-link" href="${escapeHtml(cafeArticleUrl(article))}" target="_blank" rel="noopener noreferrer" aria-label="카페 공지 열기: ${escapeHtml(article.title)}">
        <span class="event-badge cafe-badge" aria-hidden="true"><img class="platform-logo" src="assets/shortcuts/cafe.svg" alt=""></span>
        <span class="event-main"><strong>${escapeHtml(article.title)}</strong><p>${escapeHtml(article.menuName || "공지&이벤트 소식")} · ${escapeHtml(article.author || "작성자 미확인")}</p></span>
        <time class="event-time" datetime="${escapeHtml(article.timestamp || "")}">${escapeHtml(cafeDateText(article.timestamp))}</time>
      </a>
    </article>`).join("")
    : `<div class="empty-state"><strong>${state.error ? "카페 공지를 불러오지 못했습니다." : found ? "카페 공지를 모두 읽었습니다." : "현재 표시할 카페 공지가 없습니다."}</strong><p>${escapeHtml(state.error || (found ? "새 공지가 수신되면 다시 표시됩니다." : "새 공지가 수신되면 이곳에 최근 20개가 표시됩니다."))}</p></div>`;

  $$(".cafe-notice-check").forEach((checkbox) => {
    checkbox.checked = selectedCafeNoticeIds.has(checkbox.dataset.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedCafeNoticeIds.add(checkbox.dataset.id);
      else selectedCafeNoticeIds.delete(checkbox.dataset.id);
      updateCafeReadControls(notices);
    });
  });
  updateCafeReadControls(notices);
}

function ensureTooltip() {
  let tooltip = $("#daily-tooltip");
  if (tooltip) return tooltip;
  tooltip = document.createElement("div");
  tooltip.id = "daily-tooltip";
  tooltip.className = "daily-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  document.body.append(tooltip);
  return tooltip;
}

function positionTooltipForElement(tooltip, element) {
  const gap = 10;
  const anchor = element.getBoundingClientRect();
  const bounds = tooltip.getBoundingClientRect();
  let left = anchor.left + (anchor.width - bounds.width) / 2;
  let top = anchor.top - bounds.height - gap;
  left = Math.min(window.innerWidth - bounds.width - 10, Math.max(10, left));
  if (top < 10) top = anchor.bottom + gap;
  if (top + bounds.height > window.innerHeight - 10) {
    top = Math.max(10, window.innerHeight - bounds.height - 10);
  }
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function typeRows(items, total) {
  if (!items.length) return '<p class="daily-tooltip-empty">기록이 없습니다.</p>';
  return items.map((item) => {
    const percent = total ? Math.round((item.amount / total) * 100) : 0;
    return `<div class="daily-tooltip-type">
      <div><span class="type-dot" style="background:${item.color}"></span><span>${item.label}</span></div>
      <strong>${numberFormatter.format(item.amount)} <small>${percent}% · ${numberFormatter.format(item.count)}건</small></strong>
      <div class="type-track"><div style="width:${percent}%;background:${item.color}"></div></div>
    </div>`;
  }).join("");
}

function renderDayDetail(day) {
  const items = [...day.types.entries()]
    .map(([key, value]) => ({ ...DONATION_TYPE_META[key], amount: value.amount, count: value.count }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const entries = [...day.entries].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).map((event) => {
    const meta = DONATION_TYPE_META[donationTypeKey(event)];
    return `<div class="daily-tooltip-entry">
      <span class="entry-time">${timeFormatter.format(new Date(event.timestamp))}</span>
      <span class="entry-type" style="color:${meta.color}">${meta.label}</span>
      <strong>${numberFormatter.format(event.amount)}</strong>
      ${event.message ? `<p>${escapeHtml(event.message)}</p>` : ""}
    </div>`;
  }).join("");
  return `<div class="daily-tooltip-header"><div><strong>${escapeHtml(day.fullLabel)}</strong><small>직접 입력한 기록</small></div><b>${numberFormatter.format(day.total)}<span> 치즈</span></b></div>
    <div class="daily-tooltip-types">${typeRows(items, day.total)}</div>
    ${entries ? `<div class="daily-tooltip-details"><p>후원 내역 ${day.entries.length}건</p>${entries}</div>` : ""}`;
}

function bindDetail(element, html, inlineSelector) {
  const tooltip = ensureTooltip();
  const inlineDetail = $(inlineSelector);
  const useInline = !document.body.classList.contains("full-page");
  const hide = () => {
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
    element.classList.remove("selected");
  };
  const show = () => {
    element.classList.add("selected");
    if (useInline) {
      inlineDetail.innerHTML = html;
      inlineDetail.hidden = false;
      return;
    }
    tooltip.innerHTML = html;
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => positionTooltipForElement(tooltip, element));
  };
  element.onmouseenter = show;
  element.onmouseleave = hide;
  element.onclick = show;
  element.onfocus = show;
  element.onblur = hide;
}

function renderDailyChart() {
  const days = [];
  const byDate = new Map();
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    const day = {
      key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      fullLabel: new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(date),
      total: 0,
      entries: [],
      types: new Map(Object.keys(DONATION_TYPE_META).map((type) => [type, { amount: 0, count: 0 }]))
    };
    days.push(day);
    byDate.set(key, day);
  }

  for (const event of snapshot.events) {
    const day = byDate.get(localDateKey(event.timestamp));
    if (!day) continue;
    const amount = Math.max(0, Number(event.amount || 0));
    const key = donationTypeKey(event);
    const value = day.types.get(key);
    day.total += amount;
    day.entries.push(event);
    value.amount += amount;
    value.count += 1;
  }

  const max = Math.max(1, ...days.map((day) => day.total));
  const chart = $("#daily-chart");
  $("#daily-inline-detail").hidden = true;
  chart.innerHTML = days.map((day) => {
    const height = Math.max(day.total ? 6 : 2, (day.total / max) * 118);
    return `<div class="bar-column" data-day="${day.key}" tabindex="0" aria-label="${day.label}, ${numberFormatter.format(day.total)} 치즈"><div class="bar" style="height:${height}px"></div><span>${day.label}</span></div>`;
  }).join("");
  chart.querySelectorAll(".bar-column").forEach((column) => {
    const day = byDate.get(column.dataset.day);
    bindDetail(column, renderDayDetail(day), "#daily-inline-detail");
  });
}

function donutSegments(items, total) {
  let cursor = 0;
  return items.map((item) => {
    const start = cursor;
    cursor += (item.amount / total) * 100;
    return `${item.color} ${start}% ${cursor}%`;
  });
}

function renderDonationChart() {
  const totals = new Map(Object.keys(DONATION_TYPE_META).map((key) => [key, { amount: 0, count: 0 }]));
  for (const event of snapshot.events) {
    const value = totals.get(donationTypeKey(event));
    value.amount += Math.max(0, Number(event.amount || 0));
    value.count += 1;
  }
  const items = [...totals.entries()]
    .map(([key, value]) => ({ ...DONATION_TYPE_META[key], ...value }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const donut = $("#donation-donut");
  donut.style.background = total ? `conic-gradient(${donutSegments(items, total).join(",")})` : "#252a31";
  donut.setAttribute("aria-label", total ? `전체 ${numberFormatter.format(total)} 치즈` : "치즈 기록 없음");
  $("#donation-donut-total").textContent = numberFormatter.format(total);
  $("#donation-legend").innerHTML = items.length ? items.slice(0, 3).map((item) => `<div class="composition-legend-item"><i style="background:${item.color}"></i><span>${item.label}</span><strong>${Math.round((item.amount / total) * 100)}%</strong></div>`).join("") : '<p class="composition-legend-more">치즈 기록 없음</p>';
  $("#composition-inline-detail").hidden = true;
  const html = `<div class="daily-tooltip-header"><div><strong>전체 치즈 구성</strong><small>후원 종류별 비율 · ${snapshot.events.length}건</small></div><b>${numberFormatter.format(total)}<span> 치즈</span></b></div><div class="daily-tooltip-types">${typeRows(items, total)}</div>`;
  bindDetail($("#donation-composition"), html, "#composition-inline-detail");
}

function renderEvents() {
  const pageSize = Number($("#event-page-size").value) || 15;
  const totalPages = Math.max(1, Math.ceil(snapshot.events.length / pageSize));
  currentEventPage = Math.min(Math.max(1, currentEventPage), totalPages);
  const events = snapshot.events.slice((currentEventPage - 1) * pageSize, currentEventPage * pageSize);
  $("#event-pagination").hidden = snapshot.events.length <= pageSize;
  $("#event-page-label").textContent = `${currentEventPage} / ${totalPages} · ${snapshot.events.length}개`;
  $("#event-prev").disabled = currentEventPage <= 1;
  $("#event-next").disabled = currentEventPage >= totalPages;

  $("#event-list").innerHTML = events.length ? events.map((event) => {
    const meta = DONATION_TYPE_META[donationTypeKey(event)];
    return `<article class="event-item cheese-event">
      <span class="event-badge cheese-badge" style="--donation-color:${meta.color}" aria-hidden="true"><img class="platform-logo" src="assets/shortcuts/chzzk.svg" alt=""></span>
      <div class="event-main"><strong>${meta.label} · ${numberFormatter.format(event.amount)} 치즈</strong><p>${escapeHtml(event.message || "메모 없음")}</p></div>
      <time class="event-time">${dateFormatter.format(new Date(event.timestamp))}</time>
      <button class="event-delete" type="button" data-id="${escapeHtml(event.id)}" aria-label="이 기록 삭제">삭제</button>
    </article>`;
  }).join("") : '<div class="empty-state"><strong>아직 치즈 기록이 없습니다.</strong><p>위 입력란에서 본인이 확인한 사용량을 기록해 주세요.</p></div>';

  $$(".event-delete").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("이 치즈 기록을 삭제할까요?")) return;
    const response = await chrome.runtime.sendMessage({ type: "DELETE_EVENT", id: button.dataset.id });
    if (!response?.ok) return showToast(response?.error || "삭제하지 못했습니다.");
    await loadSnapshot();
    showToast("기록을 삭제했습니다.");
  }));
}

function renderSettings({ force = false } = {}) {
  const formHasFocus = $("#settings-form").contains(document.activeElement);
  if (force || (!settingsFormDirty && !formHasFocus)) {
    $("#setting-youtube-date").value = snapshot.settings.youtubeSubscriptionStart || "";
    $("#setting-chzzk-date").value = snapshot.settings.chzzkSubscriptionStart || "";
  }
  for (const field of subscriptionSettingFields()) {
    renderSubscriptionSettingPreview(field.input, field.preview);
  }
}

function renderAll() {
  renderSummary();
  renderCafeNotices();
  renderMedia();
  renderDailyChart();
  renderDonationChart();
  renderEvents();
  renderSettings();
}

async function loadSnapshot() {
  if (snapshotLoadPromise) return snapshotLoadPromise;
  snapshotLoadPromise = (async () => {
    const response = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT", limit: 20000 });
    if (!response?.ok) throw new Error(response?.error || "데이터를 불러오지 못했습니다.");
    snapshot = response;
    renderAll();
    return response;
  })();
  try {
    return await snapshotLoadPromise;
  } finally {
    snapshotLoadPromise = null;
  }
}

async function requestAllDataSync() {
  return chrome.runtime.sendMessage({ type: "FORCE_SYNC_ALL_DATA" });
}

function refreshVisibleDashboard() {
  if (document.visibilityState !== "visible") return;
  loadSnapshot().catch((error) => console.warn("쪼개 상황실 자동 갱신 실패", error));
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const relevantKeys = ["communityMediaState", "communityPowerState", "communityChzzkSubscriptionState", "communityCafeState", "communityCafeReadState", "communityFullSyncState", "communitySettings", "communityAccountState", "chzzkSyncMeta"];
  if (!relevantKeys.some((key) => Object.hasOwn(changes, key))) return;
  clearTimeout(storageRefreshTimer);
  storageRefreshTimer = setTimeout(refreshVisibleDashboard, 250);
});

setInterval(refreshVisibleDashboard, DASHBOARD_REFRESH_MS);
document.addEventListener("visibilitychange", refreshVisibleDashboard);

function switchTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
}

function downloadFile(filename, mimeType, content) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportJson() {
  const payload = { format: "jjogae-community-v1", exportedAt: new Date().toISOString(), settings: snapshot.settings, events: snapshot.events };
  downloadFile(`jjogae-community-${localDateKey(new Date())}.json`, "application/json", JSON.stringify(payload, null, 2));
}

function exportCsv() {
  const keys = ["timestamp", "amount", "donationType", "message"];
  const rows = [keys.map(csvCell).join(","), ...snapshot.events.map((event) => keys.map((key) => csvCell(event[key])).join(","))];
  downloadFile(`jjogae-community-${localDateKey(new Date())}.csv`, "text/csv;charset=utf-8", `\ufeff${rows.join("\n")}`);
}

async function markCafeNoticesRead(ids) {
  const requestedIds = [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || ""))
    .filter((id) => /^\d+$/.test(id)))];
  if (!requestedIds.length) return;
  const response = await chrome.runtime.sendMessage({ type: "MARK_CAFE_NOTICES_READ", ids: requestedIds });
  if (!response?.ok) throw new Error(response?.error || "카페 공지를 읽음 처리하지 못했습니다.");
  snapshot.cafeReadState = response.cafeReadState;
  selectedCafeNoticeIds.clear();
  renderCafeNotices();
  showToast(`${numberFormatter.format(requestedIds.length)}개 카페 공지를 읽음 처리했습니다.`);
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
$("#add-entry-button").addEventListener("click", () => {
  switchTab("activity");
  $("#entry-amount").focus();
});
$("#open-full-button").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" }));
$("#refresh-button").addEventListener("click", async () => {
  const button = $("#refresh-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const syncStatus = $("#sync-status");
  syncStatus.className = "sync-status";
  syncStatus.textContent = "모든 캐시를 무시하고 과거 치즈·통나무·구독·카페 공지·방송·영상을 다시 확인하고 있습니다.";
  try {
    const response = await requestAllDataSync();
    if (!response?.ok || response.forced !== true || response.mode !== "manual-full") {
      throw new Error(response?.error || "강제 전체 새로고침을 완료하지 못했습니다.");
    }
    currentEventPage = 1;
    await loadSnapshot();
    const parts = [];
    if (response.donations) parts.push(`치즈 ${numberFormatter.format(response.donations.total)}건`);
    const power = Number(response.powerState?.balance);
    if (response.powerState?.listed === false) parts.push("통나무 100 미만/미표시");
    else if (response.powerState?.balance !== null && Number.isFinite(power)) parts.push(`통나무 ${numberFormatter.format(power)}파워`);
    if (response.chzzkSubscriptionState?.tierName) {
      parts.push("치지직 구독 " + response.chzzkSubscriptionState.tierName);
    } else if (response.chzzkSubscriptionState?.subscribed === false) {
      parts.push("치지직 구독 정보 없음");
    }
    parts.push("방송·영상 갱신");
    if (response.cafeState?.updatedAt) parts.push(`카페 공지 ${numberFormatter.format(response.cafeState.found || 0)}개 확인`);
    const warningText = response.warnings?.length ? ` · 확인 필요: ${response.warnings.join(" / ")}` : "";
    syncStatus.textContent = `${parts.join(" · ")}${warningText}`;
    syncStatus.className = response.warnings?.length ? "sync-status error" : "sync-status success";
    showToast(response.warnings?.length ? "일부 항목을 제외하고 강제 새로고침했습니다." : "강제 전체 새로고침을 완료했습니다.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
});
$("#event-page-size").addEventListener("change", () => { currentEventPage = 1; renderEvents(); });
$("#event-prev").addEventListener("click", () => { currentEventPage -= 1; renderEvents(); });
$("#event-next").addEventListener("click", () => { currentEventPage += 1; renderEvents(); });
$("#export-json").addEventListener("click", exportJson);
$("#export-csv").addEventListener("click", exportCsv);
$("#mark-selected-cafe-read").addEventListener("click", async () => {
  try {
    await markCafeNoticesRead([...selectedCafeNoticeIds]);
  } catch (error) {
    showToast(error.message);
  }
});
$("#mark-all-cafe-read").addEventListener("click", async () => {
  try {
    await markCafeNoticesRead(cafeNotices().map((article) => article.articleId));
  } catch (error) {
    showToast(error.message);
  }
});

for (const field of subscriptionSettingFields()) {
  field.input.addEventListener("input", () => {
    settingsFormDirty = true;
    field.input.setCustomValidity("");
    renderSubscriptionSettingPreview(field.input, field.preview);
  });
  field.input.addEventListener("blur", () => {
    const raw = field.input.value.trim();
    const normalized = normalizeSubscriptionStartDate(raw);
    if (!raw || normalized) {
      field.input.value = normalized;
      field.input.setCustomValidity("");
    }
    renderSubscriptionSettingPreview(field.input, field.preview);
  });
}

$("#entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await chrome.runtime.sendMessage({
    type: "ADD_CHEESE_ENTRY",
    entry: {
      timestamp: new Date($("#entry-timestamp").value).toISOString(),
      amount: Number($("#entry-amount").value),
      donationType: $("#entry-type").value,
      message: $("#entry-message").value
    }
  });
  if (!response?.ok) return showToast(response?.error || "저장하지 못했습니다.");
  $("#entry-amount").value = "";
  $("#entry-message").value = "";
  $("#entry-timestamp").value = localDateTimeInput();
  currentEventPage = 1;
  await loadSnapshot();
  showToast("치즈 기록을 저장했습니다.");
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = readSubscriptionSettings({ apply: true, report: true });
  if (!settings) return showToast("구독 시작일의 날짜 형식을 확인해 주세요.");
  const button = $("#save-settings-button");
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    if (!response?.ok) throw new Error(response?.error || "설정을 저장하지 못했습니다.");
    settingsFormDirty = false;
    snapshot.settings = response.settings || settings;
    renderSettings({ force: true });
    renderSummary();
    showToast("구독 시작일을 저장하고 요약에 적용했습니다.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#import-json").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error("5MB 이하 JSON 파일만 가져올 수 있습니다.");
    const parsed = JSON.parse(await file.text());
    const events = Array.isArray(parsed) ? parsed : parsed.events;
    if (!Array.isArray(events)) throw new Error("치즈 기록 배열을 찾지 못했습니다.");
    const response = await chrome.runtime.sendMessage({ type: "IMPORT_EVENTS", events });
    if (!response?.ok) throw new Error(response?.error || "가져오지 못했습니다.");
    await loadSnapshot();
    showToast(`${numberFormatter.format(response.written)}건을 가져왔습니다.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.value = "";
  }
});

$("#clear-data").addEventListener("click", async () => {
  if (!confirm("치즈 기록과 설정을 포함한 모든 로컬 데이터를 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
  const response = await chrome.runtime.sendMessage({ type: "CLEAR_DATA" });
  if (!response?.ok) return showToast(response?.error || "삭제하지 못했습니다.");
  settingsFormDirty = false;
  await loadSnapshot();
  showToast("모든 로컬 데이터를 삭제했습니다.");
});

const pageParams = new URLSearchParams(location.search);
document.body.classList.toggle("full-page", pageParams.get("mode") === "full");
if (pageParams.get("mode") === "full") $("#open-full-button").hidden = true;
$("#entry-timestamp").value = localDateTimeInput();
loadSnapshot().catch((error) => showToast(error.message));
