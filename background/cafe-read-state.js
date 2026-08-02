const MAX_READ_NOTICE_IDS = 500;

function noticeId(value) {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : "";
}

export function normalizeCafeReadState(value = {}) {
  const state = value && typeof value === "object" ? value : {};
  const incoming = Array.isArray(state.ids) ? state.ids : [];
  const ids = [...new Set(incoming.map(noticeId).filter(Boolean))].slice(0, MAX_READ_NOTICE_IDS);
  const updated = new Date(state.updatedAt || "");
  return {
    ids,
    updatedAt: Number.isNaN(updated.getTime()) ? "" : updated.toISOString()
  };
}

export function mergeCafeReadState(previous, ids, now = new Date()) {
  const current = normalizeCafeReadState(previous);
  const added = Array.isArray(ids) ? ids.map(noticeId).filter(Boolean) : [];
  return {
    ids: [...new Set([...added, ...current.ids])].slice(0, MAX_READ_NOTICE_IDS),
    updatedAt: now.toISOString()
  };
}

export function unreadCafeNotices(articles, readState) {
  const readIds = new Set(normalizeCafeReadState(readState).ids);
  return (Array.isArray(articles) ? articles : []).filter((article) => {
    const id = noticeId(article?.articleId);
    return id && !readIds.has(id);
  });
}
