(() => {
  if (window.top !== window || location.origin !== "https://chzzk.naver.com") return;
  const policy = globalThis.JjogaeCommunityRupaPolicy;
  if (!policy || !chrome.runtime?.id) return;

  let options = policy.normalizeOptions();
  let media = { isLive: null, vods: [], clips: [] };
  let mediaLoaded = false;
  let mediaTimer = null;
  let mediaSession = 0;
  let mediaRequestSession = null;
  let settingsRevision = 0;
  let observer = null;
  let timer = null;
  let pending = null;
  let lastUrl = location.href;
  const cards = new Map();
  const links = new Map();
  const MARKER = "data-jjogae-community-rupa-kind";
  const EMPTY = "data-jjogae-community-rupa-empty";
  const OVERLAY = "jjogae-community-rupa-card";

  function imageUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password
        && /(^|\.)pstatic\.net$/.test(url.hostname)) return url.href;
    } catch { /* 표시할 이미지가 없으면 기본 배경을 사용합니다. */ }
    return "";
  }

  function channelLink(anchor) {
    try {
      const url = new URL(links.get(anchor)?.original || anchor.getAttribute("href"), location.href);
      return url.origin === location.origin && /^\/(?:live\/)?[a-f\d]{32}\/?$/i.test(url.pathname);
    } catch { return false; }
  }

  function hasChannelLink(element) {
    return (element.matches?.("a[href]") && channelLink(element))
      || [...element.querySelectorAll("a[href]")].some(channelLink);
  }

  function candidates() {
    const result = new Map();
    if (location.pathname === "/") {
      document.querySelectorAll('[data-nlog-area="chzzk_main_top_live"]').forEach((element) => {
        if (hasChannelLink(element)) result.set(element, "broadcast");
      });
      document.querySelectorAll('[data-nlog-area="home_feed.item"]').forEach((element) => {
        try {
          const block = JSON.parse(element.getAttribute("data-nlog-params") || "{}").block_code;
          if (typeof block !== "string" || block === "video_continue" || block === "category_recommended") return;
          if (!/recommended/i.test(block) && ![
            "clip_hot", "live_new_streamer", "live_follower_high_record", "live_category_live_recommend"
          ].includes(block)) return;
          const host = element.tagName === "A" ? element.closest("li") || element.parentElement : element;
          if (/clip/i.test(block)) result.set(host, "clip");
          else if (/vod|video/i.test(block)) result.set(host, "vod");
          else if (hasChannelLink(element)) result.set(host, "broadcast");
        } catch { /* 사이트가 제공한 카드 정보가 없으면 변경하지 않습니다. */ }
      });
      document.querySelectorAll('#layout-body button').forEach((button) => {
        if (button.textContent.trim() !== "팔로우") return;
        const element = button.closest('[class*="_card_"]');
        if (element && hasChannelLink(element)) result.set(element, "channel");
      });
    }
    if (/^\/clips\/?$/.test(location.pathname)) {
      document.querySelectorAll('#layout-body [data-nlog-area="clip_hot_clip_menu.item"]').forEach((element) => {
        const host = element.tagName === "A" ? element.closest("li") || element.parentElement : element;
        if (host) result.set(host, "clip");
      });
    }
    document.querySelectorAll("#sidebar nav").forEach((nav) => {
      const label = `${nav.getAttribute("aria-label") || ""} ${nav.querySelector("strong")?.textContent || ""}`;
      if (!/추천|파트너/.test(label) || /팔로우|팔로잉|일정/.test(label)) return;
      nav.querySelectorAll("li").forEach((element) => {
        if (hasChannelLink(element)) result.set(element, "sidebar");
      });
    });
    return result;
  }

  function element(tag, className, text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function cover(host, kind) {
    const anchor = element("a", OVERLAY);
    anchor.setAttribute("data-jjogae-community-rupa-link", "");
    const visual = element("span", "jjogae-community-rupa-visual");
    const image = element("img", "jjogae-community-rupa-image");
    image.alt = "";
    image.loading = "lazy";
    visual.append(image);
    const info = element("span", "jjogae-community-rupa-info");
    info.append(
      element("span", "jjogae-community-rupa-name", "아홀로 루파"),
      element("span", "jjogae-community-rupa-status"),
      element("span", "jjogae-community-rupa-title"),
      element("span", "jjogae-community-rupa-label", "루파모드 · 커뮤니티")
    );
    anchor.append(visual, info);
    host.setAttribute(MARKER, kind);
    host.append(anchor);
    const record = { kind, anchor, inert: new Map(), signature: "" };
    cards.set(host, record);
    return record;
  }

  function updateCard(host, record, presentation) {
    for (const child of host.children) {
      if (child === record.anchor) continue;
      if (!record.inert.has(child)) record.inert.set(child, child.inert);
      if (!child.inert) child.inert = true;
    }
    if (!presentation) {
      if (!host.hasAttribute(EMPTY)) host.setAttribute(EMPTY, "");
      record.signature = "";
      return;
    }
    if (host.hasAttribute(EMPTY)) host.removeAttribute(EMPTY);
    const { href, title, status, thumbnailUrl } = presentation;
    const src = imageUrl(thumbnailUrl) || imageUrl(media.channelImageUrl);
    const signature = JSON.stringify([src, status, title, href]);
    if (record.signature === signature) return;
    record.signature = signature;
    record.anchor.href = href;
    record.anchor.setAttribute("aria-label", `아홀로 루파 · ${status} · 루파모드 커뮤니티`);
    const image = record.anchor.querySelector("img");
    if (src) image.src = src;
    else image.removeAttribute("src");
    image.hidden = !src;
    record.anchor.querySelector(".jjogae-community-rupa-status").textContent = status;
    record.anchor.querySelector(".jjogae-community-rupa-title").textContent = title;
  }

  function restoreCard(host, record) {
    record.anchor.remove();
    for (const [child, original] of record.inert) {
      if (child.inert === true) child.inert = original;
    }
    if (host.getAttribute(MARKER) === record.kind) host.removeAttribute(MARKER);
    host.removeAttribute(EMPTY);
    cards.delete(host);
  }

  function restoreLinks() {
    for (const [anchor, record] of links) {
      if (anchor.getAttribute("href") === record.applied) anchor.setAttribute("href", record.original);
    }
    links.clear();
  }

  function rewriteLinks() {
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (anchor.closest(`.${OVERLAY}`)) continue;
      const original = anchor.getAttribute("href");
      const target = policy.navigationTarget(original, media, location.href);
      if (!target) continue;
      links.set(anchor, { original, applied: target });
      anchor.setAttribute("href", target);
    }
    for (const anchor of links.keys()) if (!anchor.isConnected) links.delete(anchor);
  }

  function redirectCurrent() {
    if (!options.redirect || !mediaLoaded) return false;
    const target = policy.navigationTarget(location.href, media);
    if (!target) return false;
    location.replace(target);
    return true;
  }

  function render() {
    pending = null;
    if (!chrome.runtime?.id) return stop();
    if (redirectCurrent()) return;
    const next = options.recommendations ? candidates() : new Map();
    for (const [host, record] of cards) {
      if (!host.isConnected || next.get(host) !== record.kind || !record.anchor.isConnected) restoreCard(host, record);
    }
    let vodIndex = 0;
    let clipIndex = 0;
    for (const [host, kind] of next) {
      const index = kind === "clip" ? clipIndex++ : (kind === "vod" || media.isLive === false ? vodIndex++ : 0);
      updateCard(host, cards.get(host) || cover(host, kind), policy.getPresentation(media, kind, index));
    }
    if (options.redirect && mediaLoaded) rewriteLinks();
  }

  function schedule() {
    if (pending === null) pending = setTimeout(render, 80);
  }

  function click(event) {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const own = anchor.classList.contains(OVERLAY);
    const record = links.get(anchor);
    const current = anchor.getAttribute("href");
    const target = options.redirect
      ? (current === record?.applied ? record.applied : policy.navigationTarget(anchor.href, media, location.href))
      : null;
    if (!own && !target) return;
    if (!own && target) {
      links.set(anchor, { original: current === record?.applied ? record.original : current, applied: target });
      anchor.setAttribute("href", target);
    }
    // React 라우터의 원래 채널 동작을 차단하고 브라우저의 새 탭 클릭은 유지합니다.
    event.stopImmediatePropagation();
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.target === "_blank") return;
    event.preventDefault();
    location.assign(target || anchor.href);
  }

  function stop() {
    mediaSession += 1;
    mediaLoaded = false;
    media = { isLive: null, vods: [], clips: [] };
    observer?.disconnect();
    observer = null;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (mediaTimer !== null) clearInterval(mediaTimer);
    mediaTimer = null;
    if (pending !== null) clearTimeout(pending);
    pending = null;
    document.removeEventListener("click", click, true);
    document.removeEventListener("auxclick", click, true);
    window.removeEventListener("popstate", schedule);
    for (const [host, record] of cards) restoreCard(host, record);
    restoreLinks();
  }

  async function refreshMedia() {
    if (!options.recommendations || mediaRequestSession === mediaSession) return;
    const session = mediaSession;
    mediaRequestSession = session;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_RUPA_MODE_MEDIA" });
      if (session !== mediaSession || !options.recommendations) return;
      media = response?.ok && response.media ? response.media : { isLive: null, vods: [], clips: [] };
      mediaLoaded = true;
      restoreLinks();
      render();
    } catch {
      if (session === mediaSession && options.recommendations) {
        media = { isLive: null, vods: [], clips: [] };
        mediaLoaded = true;
        restoreLinks();
        render();
      }
    } finally {
      if (mediaRequestSession === session) mediaRequestSession = null;
    }
  }

  function applySettings(settings) {
    options = policy.normalizeOptions(settings);
    if (!options.redirect) restoreLinks();
    if (!options.recommendations) for (const [host, record] of cards) restoreCard(host, record);
    if (!options.recommendations && !options.redirect) return stop();
    if (!observer) {
      observer = new MutationObserver((mutations) => {
        if (mutations.some((mutation) => !mutation.target.closest?.(`.${OVERLAY}`))) schedule();
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "data-nlog-params"] });
      document.addEventListener("click", click, true);
      document.addEventListener("auxclick", click, true);
      window.addEventListener("popstate", schedule);
      timer = setInterval(() => {
        if (!chrome.runtime?.id) return stop();
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          refreshMedia();
          schedule();
        }
      }, 500);
      mediaTimer = setInterval(refreshMedia, 60 * 1000);
      refreshMedia();
    }
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.communitySettings) {
      settingsRevision += 1;
      applySettings(changes.communitySettings.newValue);
    }
  });
  chrome.storage.local.get("communitySettings").then((stored) => {
    if (settingsRevision === 0) applySettings(stored.communitySettings);
  }).catch(() => {
    if (settingsRevision === 0) stop();
  });
})();
