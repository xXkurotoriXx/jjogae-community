(() => {
  const RUPA_CHANNEL_ID = "3e948667805e7627459a599018d05853";
  const CHANNEL_URL = `https://chzzk.naver.com/${RUPA_CHANNEL_ID}`;
  const LIVE_URL = `https://chzzk.naver.com/live/${RUPA_CHANNEL_ID}`;

  function normalizeOptions(settings = {}) {
    const value = settings ?? {};
    const enabled = value.rupaMode === true;
    return {
      recommendations: enabled,
      redirect: enabled
    };
  }

  function redirectTarget(input, base = "https://chzzk.naver.com/") {
    let url;
    try {
      url = new URL(input, base);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "chzzk.naver.com"
      || url.username || url.password || (url.port && url.port !== "443")) return null;

    const liveMatch = url.pathname.match(/^\/live\/([a-fA-F0-9]{32})\/?$/);
    const channelMatch = url.pathname.match(/^\/([a-fA-F0-9]{32})\/?$/);
    const channelId = liveMatch?.[1] || channelMatch?.[1];
    if (!channelId || channelId.toLowerCase() === RUPA_CHANNEL_ID) return null;
    return liveMatch ? LIVE_URL : CHANNEL_URL;
  }

  function getPresentation(media = {}, kind = "broadcast", index = 0) {
    const state = media || {};
    const isBroadcast = kind === "broadcast";
    const isProfile = kind === "channel" || kind === "sidebar";
    const channelImage = String(state.channelImageUrl || "");
    const validIndex = Number.isInteger(index) && index >= 0;
    const freshVods = Array.isArray(state.vods);

    function vodPresentation(item) {
      if (!item || !/^\d+$/.test(String(item.id ?? ""))) return null;
      return {
        href: `https://chzzk.naver.com/video/${String(item.id)}`,
        title: isProfile ? "아홀로 루파" : String(item.title || "아홀로 루파 최근 다시보기"),
        status: "최근 다시보기",
        thumbnailUrl: isProfile ? channelImage : String(item.thumbnailUrl || "")
      };
    }

    function indexedVod() {
      if (!validIndex) return null;
      if (freshVods) return state.vods.length ? state.vods[index % state.vods.length] : null;
      if (index !== 0) return null;
      return [state.latestVod, state.primary?.kind === "vod" ? state.primary : null]
        .find((item) => item && /^\d+$/.test(String(item.id ?? "")));
    }

    if (kind === "clip") {
      const clip = validIndex && Array.isArray(state.clips) ? state.clips[index] : null;
      const id = String(clip?.id ?? "");
      if (!clip || !/^[A-Za-z0-9_-]{5,80}$/.test(id)) return null;
      return {
        href: `https://chzzk.naver.com/clips/${id}`,
        title: String(clip.title || "아홀로 루파 최근 클립"),
        status: "최근 클립",
        thumbnailUrl: String(clip.thumbnailUrl || "")
      };
    }
    if (kind === "vod") return vodPresentation(indexedVod());

    if (state.isLive === true) {
      const live = state.primary?.kind === "live" ? state.primary : null;
      return {
        href: isBroadcast ? LIVE_URL : CHANNEL_URL,
        title: isBroadcast ? String(live?.title || "아홀로 루파 라이브") : "아홀로 루파",
        status: "방송 중",
        thumbnailUrl: isBroadcast ? String(live?.thumbnailUrl || "") : channelImage
      };
    }

    if (state.isLive === false) {
      const vod = vodPresentation(indexedVod());
      if (vod || freshVods) return vod;
    }

    return {
      href: CHANNEL_URL,
      title: isBroadcast ? "아홀로 루파 채널 보기" : "아홀로 루파",
      status: state.isLive === false ? "방송 대기" : "방송 상태 확인 중",
      thumbnailUrl: channelImage
    };
  }

  function navigationTarget(input, media = {}, base = "https://chzzk.naver.com/") {
    const target = redirectTarget(input, base);
    if (target === LIVE_URL && media?.isLive !== true) {
      if (media?.isLive === false) {
        const presentation = getPresentation(media);
        if (presentation?.href.startsWith("https://chzzk.naver.com/video/")) return presentation.href;
      }
      return CHANNEL_URL;
    }
    return target;
  }

  globalThis.JjogaeCommunityRupaPolicy = Object.freeze({
    RUPA_CHANNEL_ID,
    CHANNEL_URL,
    LIVE_URL,
    normalizeOptions,
    redirectTarget,
    getPresentation,
    navigationTarget
  });
})();
