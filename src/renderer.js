import { AI_PROTOCOLS, AI_PROVIDER_PRESETS } from "./core/ai.mjs";
import { ACADEMIC_YEAR_OPTIONS } from "./core/scoring.mjs";

const ACTIVITY_TYPES = Object.freeze({
  collegeFirst: { label: "院级活动（上学期）", level: "college", semester: "first", score: 0.2 },
  collegeSecond: { label: "院级活动（下学期）", level: "college", semester: "second", score: 0.2 },
  schoolFirst: { label: "校级活动（上学期）", level: "school", semester: "first", score: 0.3 },
  schoolSecond: { label: "校级活动（下学期）", level: "school", semester: "second", score: 0.3 },
  award: { label: "集体获奖", level: "unknown", semester: "unknown", score: null },
  individual: { label: "先进个人", level: "unknown", semester: "unknown", score: null },
  academic: { label: "学术科研与技能", level: "unknown", semester: "unknown", score: null },
  classFirst: { label: "班级活动（上学期）", level: "class", semester: "first", score: 0.1 },
  classSecond: { label: "班级活动（下学期）", level: "class", semester: "second", score: 0.1 },
});

const $ = (selector) => document.querySelector(selector);
const app = $("#app");
let state = null;
let updateState = null;
let updatePromptedVersion = "";
let updateInstallPromptedVersion = "";
let activePage = "overview";
let message = "";
let error = "";
let errorClearTimer = null;
let messageClearTimer = null;
let messageNoticeValue = "";
const dismissedSystemNotices = new Set();
let aiStatus = null;
let aiModels = [];
let aiStatusFingerprint = "";
let aiStatusTimer = null;
let aiStatusClearTimer = null;
let aiStatusRefreshing = false;
let aiHistoryModels = {};
let aiHistoryModelStatus = {};
let aiHistoryModelRefreshing = {};
let aiHistoryEditId = "";
let aiHistoryDraft = null;
let activityEditingId = "";
let activityDraftValues = {};
let activityDraftEvidenceIds = [];
let activityDraftToken = "";
let activityDraftNewEvidenceIds = [];
let volunteerEditingId = "";
let volunteerDraftValues = {};
let volunteerDraftEvidenceIds = [];
let volunteerDraftToken = "";
let volunteerDraftNewEvidenceIds = [];
let positionEditingId = "";
let positionDraftValues = {};
let positionDraftEvidenceIds = [];
let positionDraftToken = "";
let positionDraftNewEvidenceIds = [];
let studentPackagePreview = false;
let returnToStudentPackage = false;
let packageSelectedEvidenceIds = new Set();
let classSelectedPackageIds = new Set();

function setTransientError(nextError) {
  error = String(nextError || "操作失败");
  clearTimeout(errorClearTimer);
  errorClearTimer = setTimeout(() => {
    if (error === nextError) {
      error = "";
      render();
    }
  }, 10_000);
}

async function invoke(channel, payload) {
  try {
    error = "";
    const result = await window.conduct.invoke(channel, payload);
    return result;
  } catch (cause) {
    const nextError = cause?.message || String(cause);
    setTransientError(nextError);
    render();
    return null;
  }
}

function currentUpdateState() {
  return updateState || state?.update || { status: "disabled", currentVersion: "0.1.0" };
}

function promptForUpdate(next) {
  if (!next?.version || next.version === next.currentVersion) return;
  if (next.status === "available" && updatePromptedVersion !== next.version) {
    updatePromptedVersion = next.version;
    setTimeout(async () => {
      if (!window.confirm("检测到新版本 " + next.version + "，当前版本为 " + next.currentVersion + "。是否现在下载更新？")) {
        message = "已暂不下载新版本 " + next.version + "，可在“项目设置”中再次操作";
        render();
        return;
      }
      const result = await invoke("app:update:download");
      if (result) {
        updateState = result;
        if (state) state.update = result;
        render();
      }
    }, 0);
  }
  if (next.status === "downloaded" && updateInstallPromptedVersion !== next.version) {
    updateInstallPromptedVersion = next.version;
    setTimeout(async () => {
      if (!window.confirm("新版本 " + next.version + " 已下载完成。现在重启软件并安装吗？")) {
        message = "新版本 " + next.version + " 已下载，可在“项目设置”中稍后安装";
        render();
        return;
      }
      const result = await invoke("app:update:install");
      if (result) {
        updateState = result;
        if (state) state.update = result;
        render();
      }
    }, 0);
  }
}

function receiveUpdateState(next) {
  if (!next) return;
  updateState = next;
  if (state) state.update = next;
  promptForUpdate(next);
  if (state) render();
}

function updateBannerMarkup() {
  const update = currentUpdateState();
  if (update.status === "available") {
    return "<div class=\"notice update-notice\"><span class=\"notice-text\">发现新版本 " + esc(update.version) + (update.releaseName ? "：" + esc(update.releaseName) : "") + "</span><div class=\"actions\"><button type=\"button\" data-update-download>下载更新</button></div></div>";
  }
  if (update.status === "downloading") {
    const percent = Math.round(Number(update.percent) || 0);
    return "<div class=\"notice update-notice\"><span class=\"notice-text\">" + esc(update.message || "正在下载新版本…") + "</span><div class=\"update-progress-track\"><div class=\"update-progress-value\" style=\"width:" + percent + "%\"></div></div></div>";
  }
  if (update.status === "downloaded") {
    return "<div class=\"notice update-notice\"><span class=\"notice-text\">新版本 " + esc(update.version) + " 已下载完成，请重启安装。</span><div class=\"actions\"><button type=\"button\" data-update-install>重启并安装</button></div></div>";
  }
  return "";
}

function updateCardMarkup() {
  const update = currentUpdateState();
  const statusText = {
    disabled: update.message || "尚未配置 GitHub Releases 更新源",
    idle: "已启用后台检查，软件启动后会自动检查一次，之后每 6 小时检查一次。",
    checking: "正在检查 GitHub Releases…",
    available: "发现新版本 " + update.version + "，等待下载确认。",
    downloading: update.message || "正在下载新版本…",
    downloaded: "新版本 " + update.version + " 已下载完成，等待重启安装。",
    "up-to-date": "当前已经是最新版本。",
    error: update.message || "更新检查失败，请稍后重试。",
  }[update.status] || "更新状态未知";
  const action = update.status === "available"
    ? "<button type=\"button\" data-update-download>下载更新</button>"
    : update.status === "downloaded"
      ? "<button type=\"button\" data-update-install>重启并安装</button>"
      : "<button type=\"button\" id=\"update-check\" " + (update.status === "disabled" || update.status === "checking" || update.status === "downloading" ? "disabled" : "") + ">立即检查更新</button>";
  const variant = update.status === "error" ? "error" : update.status === "disabled" ? "warning" : "";
  const progress = update.status === "downloading"
    ? "<div class=\"update-progress-track\"><div class=\"update-progress-value\" style=\"width:" + Math.round(Number(update.percent) || 0) + "%\"></div></div>"
    : "";
  return "<section class=\"card update-card\"><div class=\"section-heading\"><div><span class=\"eyebrow\">软件更新</span><h2>在线更新</h2></div><span class=\"score-badge\">" + esc(update.currentVersion || "0.1.0") + "</span></div><p class=\"muted\">更新源使用 GitHub Releases。发现新版本后会先征求你的确认，下载完成后再征求一次重启安装确认。</p><div class=\"notice " + variant + "\">" + esc(statusText) + "</div>" + progress + "<div class=\"actions\">" + action + "</div></section>";
}

function session() { return state?.session; }
function account() { return session()?.account; }
function project() { return session()?.project || {}; }
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function fmt(value) { return Number(value || 0).toFixed(1); }
function refresh(next) { if (next) state = next; render(); }
function noticeMarkup(text, variant = "", kind = "system", key = text) {
  if (!text || (kind === "system" && dismissedSystemNotices.has(key))) return "";
  const transient = kind === "message" || kind === "error";
  return `<div class="notice ${variant} ${transient ? "notice-transient" : "notice-system"}" data-notice-kind="${esc(kind)}" data-notice-key="${esc(key)}"><span class="notice-text">${esc(text)}</span><button type="button" class="notice-close" data-close-notice="${esc(kind)}" data-notice-key="${esc(key)}" aria-label="关闭提示">×</button>${transient ? `<div class="notice-progress" aria-hidden="true"></div>` : ""}</div>`;
}

function globalNoticesMarkup() {
  const notices = [];
  if (message) notices.push(noticeMarkup(message, "", "message", message));
  if (error) notices.push(noticeMarkup(error, "error", "error", error));
  return notices.length ? `<div class="global-notices" aria-live="polite">${notices.join("")}</div>` : "";
}
function scheduleMessageClear() {
  if (!message) {
    clearTimeout(messageClearTimer);
    messageClearTimer = null;
    messageNoticeValue = "";
    return;
  }
  if (message === messageNoticeValue) return;
  clearTimeout(messageClearTimer);
  const noticeValue = message;
  messageNoticeValue = noticeValue;
  messageClearTimer = setTimeout(() => {
    if (message === noticeValue) {
      message = "";
      messageNoticeValue = "";
      render();
    }
  }, 10_000);
}
function dismissNotice(kind, key, element) {
  if (kind === "message") {
    message = "";
    scheduleMessageClear();
    render();
  } else if (kind === "error") {
    error = "";
    clearTimeout(errorClearTimer);
    errorClearTimer = null;
    render();
  } else {
    dismissedSystemNotices.add(key || "");
    element?.remove();
  }
}
function wireNoticeControls() {
  document.querySelectorAll("[data-close-notice]").forEach((button) => button.addEventListener("click", () => dismissNotice(button.dataset.closeNotice, button.dataset.noticeKey, button.closest(".notice"))));
}
function decorateRenderedNotices() {
  const plainNotices = () => [...document.querySelectorAll(".notice:not([data-notice-kind])")];
  if (message) {
    const messageNotice = plainNotices().find((notice) => !notice.classList.contains("error"));
    if (messageNotice) messageNotice.outerHTML = noticeMarkup(message, "", "message", message);
  }
  if (error) {
    const errorNotice = plainNotices().find((notice) => notice.classList.contains("error"));
    if (errorNotice) errorNotice.outerHTML = noticeMarkup(error, "error", "error", error);
  }
  plainNotices().forEach((notice, index) => {
    const text = notice.textContent.trim();
    const variant = notice.classList.contains("warning") ? "warning" : "";
    notice.outerHTML = noticeMarkup(text, variant, "system", `${activePage}|${index}|${text}`);
  });
}
function activityTypeFromItem(item = {}) {
  if (item.activityType && ACTIVITY_TYPES[item.activityType]) return item.activityType;
  if (item.level === "college" && item.semester === "first") return "collegeFirst";
  if (item.level === "college" && item.semester === "second") return "collegeSecond";
  if (item.level === "school" && item.semester === "first") return "schoolFirst";
  if (item.level === "school" && item.semester === "second") return "schoolSecond";
  if (item.level === "class" && item.semester === "first") return "classFirst";
  if (item.level === "class" && item.semester === "second") return "classSecond";
  if (item.activityType === "classActivity") return item.semester === "second" ? "classSecond" : "classFirst";
  return "";
}
function activityTypeLabel(item = {}) { return ACTIVITY_TYPES[activityTypeFromItem(item)]?.label || "其他操行项目"; }
function evidenceByIds(ids = []) { const wanted = new Set(ids); return (session()?.evidence || []).filter((item) => wanted.has(item.id)); }
function captureDraftForm(selector, target) {
  const form = $(selector);
  if (!form) return;
  target = Object.assign(target, Object.fromEntries(new FormData(form)));
}
function pathFromDraggedFile(file) {
  try {
    return window.conduct.getPathForFile?.(file) || file?.path || "";
  } catch {
    return file?.path || "";
  }
}
function pathsFromDataTransfer(dataTransfer) {
  return [...(dataTransfer?.files || [])].map(pathFromDraggedFile).filter(Boolean);
}
function makeDraftToken(kind) { return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
function draftTokenFor(kind) {
  if (kind === "activity") return activityDraftToken || (activityDraftToken = makeDraftToken(kind));
  if (kind === "volunteer") return volunteerDraftToken || (volunteerDraftToken = makeDraftToken(kind));
  return positionDraftToken || (positionDraftToken = makeDraftToken(kind));
}
function draftNewEvidenceIds(kind) { return kind === "activity" ? activityDraftNewEvidenceIds : kind === "volunteer" ? volunteerDraftNewEvidenceIds : positionDraftNewEvidenceIds; }
function setDraftNewEvidenceIds(kind, ids) {
  if (kind === "activity") activityDraftNewEvidenceIds = ids;
  else if (kind === "volunteer") volunteerDraftNewEvidenceIds = ids;
  else positionDraftNewEvidenceIds = ids;
}
function resetActivityDraft() { activityEditingId = ""; activityDraftValues = {}; activityDraftEvidenceIds = []; activityDraftToken = ""; activityDraftNewEvidenceIds = []; }
function resetVolunteerDraft() { volunteerEditingId = ""; volunteerDraftValues = {}; volunteerDraftEvidenceIds = []; volunteerDraftToken = ""; volunteerDraftNewEvidenceIds = []; }
function resetPositionDraft() { positionEditingId = ""; positionDraftValues = {}; positionDraftEvidenceIds = []; positionDraftToken = ""; positionDraftNewEvidenceIds = []; }
async function discardUnsavedDraftEvidence(kind) {
  const token = kind === "activity" ? activityDraftToken : kind === "volunteer" ? volunteerDraftToken : positionDraftToken;
  if (token) {
    const next = await invoke("evidence:discard-draft", token);
    if (!next) return false;
    state = next;
  }
  if (kind === "activity") resetActivityDraft();
  else if (kind === "volunteer") resetVolunteerDraft();
  else resetPositionDraft();
  return true;
}
async function beginActivityEdit(item, returnToPackage = false) {
  if (activityDraftToken && (activityDraftNewEvidenceIds.length || (activityEditingId && activityEditingId !== item.id))) {
    if (!await discardUnsavedDraftEvidence("activity")) return;
  }
  activePage = "activities";
  activityEditingId = item.id;
  activityDraftValues = { ...item };
  activityDraftEvidenceIds = [...(item.evidenceIds || [])];
  activityDraftToken = makeDraftToken("activity");
  activityDraftNewEvidenceIds = [];
  returnToStudentPackage = returnToPackage;
  message = `正在编辑操行记录：${item.name || "未命名项目"}`;
  render();
}
async function beginVolunteerEdit(item, returnToPackage = false) {
  if (volunteerDraftToken && (volunteerDraftNewEvidenceIds.length || (volunteerEditingId && volunteerEditingId !== item.id))) {
    if (!await discardUnsavedDraftEvidence("volunteer")) return;
  }
  activePage = "volunteer";
  volunteerEditingId = item.id;
  volunteerDraftValues = { ...item };
  volunteerDraftEvidenceIds = [...(item.evidenceIds || [])];
  volunteerDraftToken = makeDraftToken("volunteer");
  volunteerDraftNewEvidenceIds = [];
  returnToStudentPackage = returnToPackage;
  message = `正在编辑额外志愿：${item.name || "未命名项目"}`;
  render();
}
async function beginPositionEdit(item, returnToPackage = false) {
  if (positionDraftToken && (positionDraftNewEvidenceIds.length || (positionEditingId && positionEditingId !== item.id))) {
    if (!await discardUnsavedDraftEvidence("position")) return;
  }
  activePage = "positions";
  positionEditingId = item.id;
  positionDraftValues = { ...item };
  positionDraftEvidenceIds = [...(item.evidenceIds || [])];
  positionDraftToken = makeDraftToken("position");
  positionDraftNewEvidenceIds = [];
  returnToStudentPackage = returnToPackage;
  message = `正在编辑任职：${item.name || "未命名职位"}`;
  render();
}
function fmtAiHistoryDate(value) {
  if (!value) return "未检测";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function aiStatusKey(ai) {
  return [ai.provider, ai.baseUrl, ai.apiKeyConfigured ? "configured" : "missing"].join("|");
}

function aiModelId(item = {}) {
  if (typeof item === "string") return item.trim();
  return String(item.id || item.model || item.provider_model || item.rawModelId || "").trim();
}

function aiInterfaceIdentity(item = {}) {
  return [item.provider, item.baseUrl, item.protocol, item.model].map((value) => String(value || "").trim()).join("|");
}

function aiHistoryModelOptions(item = {}) {
  const preset = AI_PROVIDER_PRESETS[item.provider] || AI_PROVIDER_PRESETS.manual;
  return [...new Set([...(preset.models || []), ...(aiHistoryModels[item.id] || []), ...(item.model ? [item.model] : [])].filter(Boolean))];
}

function aiHistoryModelCell(item = {}) {
  const selectedModel = item.model || "";
  const models = aiHistoryModelOptions(item);
  const rows = models.map((model) => {
    const active = model === selectedModel;
    return `<div class="ai-model-row ${active ? "active" : ""}"><code>${esc(model)}</code><button type="button" class="small-button ${active ? "secondary" : ""}" data-enable-ai-history-model="${esc(item.id)}" data-ai-history-model="${esc(model)}" ${active ? "disabled" : ""}>${active ? "当前使用" : "启用"}</button></div>`;
  }).join("");
  const status = aiHistoryModelStatus[item.id] || "点击同步在线模型";
  return `<div class="ai-history-model-current">当前：${esc(selectedModel || "未选择")}</div><div class="ai-model-list ai-history-model-list">${rows || `<div class="empty-table">暂无模型</div>`}</div><div class="ai-model-actions"><button type="button" class="secondary small-button" data-sync-ai-history-models="${esc(item.id)}" ${aiHistoryModelRefreshing[item.id] ? "disabled" : ""}>同步在线模型</button><small class="muted">${esc(status)}</small></div>`;
}

function aiHistoryCardMarkup(item, activeIdentity) {
  const active = aiInterfaceIdentity(item) === activeIdentity;
  const providerLabel = AI_PROVIDER_PRESETS[item.provider]?.label || item.provider;
  const protocolLabel = AI_PROTOCOLS[item.protocol]?.label || item.protocol;
  const status = item.testStatus === "success" ? "连接正常" : item.testStatus === "error" ? "连接失败" : "未检测";
  const statusClass = item.testStatus === "success" ? "success" : item.testStatus === "error" ? "error" : "pending";
  return `<article class="ai-history-card ${active ? "active" : ""}"><div class="ai-history-card-head"><div><div class="ai-history-provider"><span class="ai-provider-dot"></span><strong>${esc(providerLabel)}</strong><span class="ai-history-status ${statusClass}">${esc(status)}</span></div><h3>${esc(item.baseUrl || "未填写 Base URL")}</h3></div><div class="inline"><button class="small-button ${active ? "secondary" : ""}" data-enable-ai-history="${esc(item.id)}" ${active ? "disabled" : ""}>${active ? "当前使用" : "启用接口"}</button><button class="small-button secondary" data-edit-ai-history="${esc(item.id)}">编辑</button><button class="small-button danger" data-delete-ai-history="${esc(item.id)}">删除</button></div></div><div class="ai-history-meta"><div><span>协议</span><strong>${esc(protocolLabel)}</strong></div><div><span>最近检测</span><strong>${esc(fmtAiHistoryDate(item.testedAt || item.savedAt))}</strong></div><div><span>延迟</span><strong>${item.latencyMs !== null && item.latencyMs !== undefined ? `${esc(item.latencyMs)} ms` : "—"}</strong></div></div><section class="ai-history-models"><div class="ai-history-section-heading"><div><strong>模型列表</strong><small>在此接口下选择实际使用的模型</small></div></div>${aiHistoryModelCell(item)}</section>${item.testMessage ? `<div class="ai-history-message">${esc(item.testMessage)}</div>` : ""}</article>`;
}

function renderAiHistoryCards() {
  const history = account()?.settings?.ai?.history || [];
  const activeIdentity = aiInterfaceIdentity(account()?.settings?.ai || {});
  const historyRoot = document.querySelector(".ai-history");
  const tableWrap = historyRoot?.querySelector(".table-wrap");
  if (!historyRoot || !tableWrap) return;
  tableWrap.outerHTML = history.length
    ? `<div class="ai-history-cards">${history.map((item) => aiHistoryCardMarkup(item, activeIdentity)).join("")}</div>`
    : `<div class="ai-history-empty">暂无历史接口记录。保存接口后，可在这里同步模型并启用实际使用的模型。</div>`;
  historyRoot.querySelectorAll(".ai-history-card").forEach((card) => {
    const historyId = card.querySelector("[data-edit-ai-history]")?.dataset.editAiHistory;
    const actions = card.querySelector(".ai-history-card-head .inline");
    if (historyId && actions) actions.insertAdjacentHTML("afterbegin", `<button class="small-button secondary" data-test-ai-history="${esc(historyId)}">测试连接</button>`);
  });
}

function scheduleAiStatusClear() {
  clearTimeout(aiStatusClearTimer);
  aiStatusClearTimer = setTimeout(() => {
    aiStatusClearTimer = null;
    if (aiStatus?.status === "error") {
      aiStatus = null;
      aiModels = [];
      if (activePage === "settings") render();
    }
  }, 10_000);
}

async function refreshAiStatus({ force = false, rerender = true } = {}) {
  const ai = account()?.settings?.ai || {};
  if (ai.provider !== "api-manager" || !ai.apiKeyConfigured) {
    aiStatus = null;
    aiModels = [];
    aiStatusFingerprint = "";
    return null;
  }
  const fingerprint = aiStatusKey(ai);
  if (aiStatusRefreshing || (!force && aiStatusFingerprint === fingerprint)) return aiStatus;
  aiStatusFingerprint = fingerprint;
  aiStatusRefreshing = true;
  const result = await invoke("ai:status");
  aiStatusRefreshing = false;
  if (result) {
    clearTimeout(aiStatusClearTimer);
    aiStatusClearTimer = null;
    aiStatus = result;
    aiModels = Array.isArray(result.models) ? result.models : [];
  } else {
    aiStatus = { status: "error", error: error || "API Manager 状态查询失败" };
    aiModels = [];
    scheduleAiStatusClear();
  }
  if (rerender && activePage === "settings") render();
  return result;
}

function ensureAiStatusPolling() {
  if (aiStatusTimer) return;
  aiStatusTimer = setInterval(() => {
    const ai = account()?.settings?.ai || {};
    if (activePage === "settings" && !aiHistoryEditId && ai.provider === "api-manager" && ai.apiKeyConfigured) refreshAiStatus({ force: true });
  }, 60_000);
}

async function boot() {
  window.conduct.onUpdateState?.(receiveUpdateState);
  state = await invoke("app:state");
  updateState = state?.update || updateState;
  promptForUpdate(updateState);
  render();
}

function loginView() {
  const accounts = state?.accounts || [];
  app.innerHTML = `<div class="login"><section class="login-card">
    <h1>操行统计助手</h1><p class="muted">0.1.0 · 2025-2026 学年 · 本地优先</p>
    <div class="card" style="padding:14px;background:#f8fafc"><strong>登录已有本地账户</strong>
      <label style="margin-top:12px">账户<select id="login-account">${accounts.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}${item.profile?.name ? ` · ${esc(item.profile.name)}` : ""}</option>`).join("") || `<option value="">暂无账户</option>`}</select></label>
      <label style="margin-top:10px">密码<input id="login-password" type="password" /></label>
      <button id="login-button" style="margin-top:12px" ${accounts.length ? "" : "disabled"}>登录</button>
    </div>
    <details><summary>创建本地账户</summary><form id="create-form" class="grid two" style="margin-top:14px">
      <label>账户名称<input name="accountName" required placeholder="例如：刘益铭" /></label>
      <label>密码<input name="password" type="password" required minlength="4" /></label>
      <label>学生姓名<input name="name" /></label><label>学号<input name="studentId" /></label>
      <label>专业<input name="major" value="中药学类" /></label><label>班级<input name="classId" /></label>
      <label>学院<input name="college" value="中药学院" /></label>
      <div class="actions"><button type="submit">创建并登录</button></div>
    </form></details>
    <p class="muted" style="margin-bottom:0">数据保存在本机；AI 关闭时不发送证据到网络。</p>
  </section></div>`;
  const globalNotices = globalNoticesMarkup();
  if (globalNotices) app.insertAdjacentHTML("afterbegin", globalNotices);
  decorateRenderedNotices();
  wireNoticeControls();
  $("#login-button")?.addEventListener("click", async () => { const result = await invoke("account:login", { accountId: $("#login-account").value, password: $("#login-password").value }); refresh(result); });
  $("#create-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.target); const result = await invoke("account:create", { accountName: form.get("accountName"), password: form.get("password"), profile: Object.fromEntries(["name", "studentId", "major", "classId", "college"].map((key) => [key, form.get(key)])) }); refresh(result); });
}

function shellView(content) {
  const nav = [
    { key: "overview", label: "总览" },
    { key: "personal", label: "个人填写系统", children: [
      ["activities", "操行收集"],
      ["positions", "相关任职"],
      ["volunteer", "额外志愿"],
      ["student-package", "生成最终资料包"],
    ] },
    { key: "class", label: "班长整理系统" },
    { key: "settings", label: "项目设置" },
  ];
  const titles = Object.fromEntries([
    ["overview", "总览"],
    ["activities", "操行收集"],
    ["positions", "相关任职"],
    ["volunteer", "额外志愿"],
    ["student-package", "生成最终资料包"],
    ["class", "班长整理系统"],
    ["settings", "项目设置"],
  ]);
  const navMarkup = nav.map((item) => {
    if (!item.children) return `<button class="${activePage === item.key ? "active" : ""}" data-page="${item.key}">${item.label}</button>`;
    const groupActive = item.children.some(([key]) => activePage === key);
    return `<section class="nav-group ${groupActive ? "active" : ""}"><div class="nav-group-title">${item.label}</div><div class="nav-subnav">${item.children.map(([key, label]) => `<button class="${activePage === key ? "active" : ""}" data-page="${key}">${label}</button>`).join("")}</div></section>`;
  }).join("");
app.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand">操行统计助手</div><div class="version">0.1.0 · ${esc(project().academicYear)}</div><nav class="nav">${navMarkup}</nav><div class="sidebar-account"><div class="muted">本机账户：${esc(account()?.name)}</div><button id="logout" class="secondary">退出登录</button></div></aside><main class="main"><div class="topbar"><h1>${esc(titles[activePage] || "总览")}</h1><div class="user-chip">${esc(account()?.profile?.name || "未填写姓名")} · ${esc(account()?.profile?.studentId || "未填写学号")}</div></div>${message ? `<div class="notice">${esc(message)}</div>` : ""}${error ? `<div class="notice error">${esc(error)}</div>` : ""}${content}</main></div>`;
  document.querySelectorAll(".main > .notice").forEach((notice) => notice.remove());
  const globalNotices = globalNoticesMarkup();
  if (globalNotices) app.insertAdjacentHTML("afterbegin", globalNotices);
  decorateRenderedNotices();
  scheduleMessageClear();
  wireNoticeControls();
  const updateBanner = updateBannerMarkup();
  if (updateBanner) document.querySelector(".main")?.insertAdjacentHTML("afterbegin", updateBanner);
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", async () => {
    const nextPage = button.dataset.page;
    const draftKind = activePage === "activities" ? "activity" : activePage === "volunteer" ? "volunteer" : activePage === "positions" ? "position" : "";
    const nextDraftKind = nextPage === "activities" ? "activity" : nextPage === "volunteer" ? "volunteer" : nextPage === "positions" ? "position" : "";
    if (draftKind && draftKind !== nextDraftKind && !await discardUnsavedDraftEvidence(draftKind)) return;
    activePage = nextPage;
    returnToStudentPackage = false;
    message = "";
    render();
  }));
  $("#logout")?.addEventListener("click", async () => {
    for (const kind of ["activity", "volunteer", "position"]) if (!await discardUnsavedDraftEvidence(kind)) return;
    aiHistoryEditId = "";
    aiHistoryDraft = null;
    refresh(await invoke("account:logout"));
  });
}

function overviewPage() {
  const activities = session().activities || [];
  const activityScore = activities.filter((item) => item.status !== "rejected").reduce((sum, item) => sum + Number(item.score || 0), 0);
  const volunteerScore = (session().volunteers || []).filter((item) => item.status !== "rejected").length * .1;
  const positionScore = Math.max(0, ...(session().positions || []).map((item) => Number(item.score || 0)));
  return `<section class="overview-hero"><div><span class="eyebrow">${esc(project().academicYear)} 学年</span><h2>${esc(account()?.profile?.name || "同学")}，欢迎回来</h2><p>所有记录先由你确认后保存，AI 只提供辅助建议，不会替你修改已确认数据。</p></div><button id="student-export">生成学生资料包</button></section><section class="metric-row"><div class="metric"><span>操行记录</span><strong>${activities.length}</strong></div><div class="metric"><span>操行分</span><strong>${fmt(activityScore)}</strong></div><div class="metric"><span>额外志愿分</span><strong>${fmt(Math.min(1, volunteerScore))}</strong></div><div class="metric"><span>任职有效分</span><strong>${fmt(Math.min(2, positionScore))}</strong></div></section><section class="card quick-start"><h2>快速开始</h2><div class="quick-grid"><button data-page="activities">进入操行收集</button><button data-page="volunteer" class="secondary">填写额外志愿</button><button data-page="positions" class="secondary">填写相关任职</button><button data-page="class" class="secondary">进入班长整理系统</button></div><p class="muted">导出会生成 Excel、Markdown 文件和按人员或活动整理的证据包。</p></section>`;
}

function studentPackagePage() {
  const activities = (session().activities || []).filter((item) => item.status !== "rejected");
  const volunteers = (session().volunteers || []).filter((item) => item.status !== "rejected");
  const positions = (session().positions || []).filter((item) => item.status !== "rejected");
  const activityScore = activities.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const volunteerScore = Math.min(1, volunteers.length * .1);
  const positionScore = Math.max(0, ...positions.map((item) => Number(item.score || 0)));
  return `<section class="overview-hero package-hero"><div><span class="eyebrow">个人填写系统 · 最终资料</span><h2>生成最终资料包</h2><p>汇总已确认的操行、额外志愿、相关任职和对应证据，生成可提交给班长的学生资料包。</p></div><button id="student-export">生成最终资料包</button></section><section class="card"><div class="section-heading"><div><span class="eyebrow">当前汇总</span><h2>${esc(account()?.profile?.name || "未填写姓名")} · ${esc(project().academicYear)} 学年</h2></div><span class="score-badge">${activities.length + volunteers.length + positions.length} 条记录</span></div><div class="metric-row package-metrics"><div class="metric"><span>操行分</span><strong>${fmt(activityScore)}</strong></div><div class="metric"><span>额外志愿分</span><strong>${fmt(volunteerScore)}</strong></div><div class="metric"><span>任职有效分</span><strong>${fmt(positionScore)}</strong></div><div class="metric"><span>证据文件</span><strong>${(session().evidence || []).length}</strong></div></div></section><section class="card package-contents"><h2>资料包内容</h2><div class="package-content-grid"><div><strong>素质拓展测评统计.xlsx</strong><p class="muted">个人操行收集记录及分数汇总。</p></div><div><strong>额外志愿服务.md</strong><p class="muted">参加活动列表与最终志愿服务分数。</p></div><div><strong>相关任职统计.md</strong><p class="muted">任职明细及按办法取最高分后的结果。</p></div><div><strong>证据文件夹与 manifest.json</strong><p class="muted">按项目归类的原始证据和资料清单。</p></div></div><p class="muted package-note">生成结果会保存到当前自定义数据储存位置的“导出结果”目录，并可将 .conductpkg 文件交给班长导入。</p></section>`;
}

function packagePreviewMarkup() {
  const activities = (session().activities || []).filter((item) => item.status !== "rejected");
  const volunteers = (session().volunteers || []).filter((item) => item.status !== "rejected");
  const positions = (session().positions || []).filter((item) => item.status !== "rejected");
  const evidence = session().evidence || [];
  const activityScore = activities.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const volunteerScore = Math.min(1, volunteers.length * .1);
  const positionScore = Math.min(2, positions.length ? Math.max(...positions.map((item) => Number(item.score || 0))) : 0);
  const highestPositionScore = positions.length ? Math.max(...positions.map((item) => Number(item.score || 0))) : 0;
  const evidenceTargetOptions = [
    ...activities.map((item) => `<option value="activity:${esc(item.id)}">操行：${esc(item.name || "未命名项目")}</option>`),
    ...volunteers.map((item) => `<option value="volunteer:${esc(item.id)}">额外志愿：${esc(item.name || "未命名项目")}</option>`),
    ...positions.map((item) => `<option value="position:${esc(item.id)}">相关任职：${esc(item.name || "未命名职位")}</option>`),
  ].join("");
  const activityRows = activities.map((item) => `<tr><td><strong>${esc(item.name || "未命名项目")}</strong></td><td>${esc(activityTypeLabel(item))}</td><td>${esc(item.semester === "first" ? "上学期" : item.semester === "second" ? "下学期" : "未归类")}</td><td>${fmt(item.score)}</td><td>${item.evidenceIds?.length || 0} 份</td><td><button type="button" class="small-button secondary" data-package-edit-activity="${esc(item.id)}">修改</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty-table">暂无操行记录</td></tr>`;
  const volunteerRows = volunteers.map((item) => `<tr><td><strong>${esc(item.name || "未命名项目")}</strong></td><td>0.1</td><td>${item.evidenceIds?.length || 0} 份</td><td><button type="button" class="small-button secondary" data-package-edit-volunteer="${esc(item.id)}">修改</button></td></tr>`).join("") || `<tr><td colspan="4" class="empty-table">暂无额外志愿记录</td></tr>`;
  const positionRows = positions.map((item) => { const isHighest = Number(item.score || 0) === highestPositionScore && highestPositionScore > 0; return `<tr><td><strong>${esc(item.name || "未命名职位")}</strong></td><td>${esc(item.organization || "")}</td><td>${esc(item.term || "")}</td><td>${fmt(item.score)}</td><td>${isHighest ? `<span class="preview-highlight">计入最高分</span>` : `<span class="muted">不累计</span>`}</td><td><button type="button" class="small-button secondary" data-package-edit-position="${esc(item.id)}">修改</button></td></tr>`; }).join("") || `<tr><td colspan="6" class="empty-table">暂无相关任职记录</td></tr>`;
  const evidenceRows = evidence.map((item) => { const relatedItems = [...activities.filter((entry) => entry.evidenceIds?.includes(item.id)).map((entry) => `操行：${entry.name || "未命名项目"}`), ...volunteers.filter((entry) => entry.evidenceIds?.includes(item.id)).map((entry) => `额外志愿：${entry.name || "未命名项目"}`), ...positions.filter((entry) => entry.evidenceIds?.includes(item.id)).map((entry) => `相关任职：${entry.name || "未命名职位"}`)]; const related = relatedItems.join("、") || "未关联"; const linkControl = relatedItems.length ? `<span class="muted">${esc(related)}</span>` : `<div class="package-evidence-link"><select data-evidence-target="${esc(item.id)}"><option value="">选择关联项目</option>${evidenceTargetOptions}</select><button type="button" class="small-button secondary" data-link-package-evidence="${esc(item.id)}">关联</button></div>`; return `<tr><td><input type="checkbox" class="package-evidence-check" data-package-evidence-check="${esc(item.id)}" ${packageSelectedEvidenceIds.has(item.id) ? "checked" : ""} aria-label="选择 ${esc(item.originalName || "未命名文件")}" /></td><td>${esc(item.originalName || "未命名文件")}</td><td>${linkControl}</td><td><div class="inline"><button type="button" class="small-button secondary" data-open="${esc(item.storedPath)}">查看</button><button type="button" class="small-button danger" data-delete-package-evidence="${esc(item.id)}">删除</button></div></td></tr>`; }).join("") || `<tr><td colspan="4" class="empty-table">暂无证据文件</td></tr>`;
  return `<section class="card package-preview"><div class="section-heading"><div><span class="eyebrow">最终资料预览</span><h2>导出前核对内容</h2></div><div class="inline"><button type="button" class="secondary" id="student-preview-close">收起预览</button><button type="button" id="student-export-preview">重新生成资料包</button></div></div><div class="package-preview-note">这里展示将写入最终资料包的结构化内容。点击“修改”会同步修改个人填写系统；保存后返回本页，确认无误后再重新生成资料包。未关联的证据可以在下方选择关联项目。</div><section class="package-preview-section"><div class="package-preview-heading"><h3>操行统计明细</h3><span class="score-badge">${activities.length} 条 · ${fmt(activityScore)} 分</span></div><div class="table-wrap"><table><thead><tr><th>项目名称</th><th>类别</th><th>学期</th><th>得分</th><th>证据</th><th>操作</th></tr></thead><tbody>${activityRows}</tbody></table></div></section><section class="package-preview-section"><div class="package-preview-heading"><h3>额外志愿服务</h3><span class="score-badge">${volunteers.length} 次 · ${fmt(volunteerScore)} 分</span></div><div class="table-wrap"><table><thead><tr><th>活动名称</th><th>计分</th><th>证据</th><th>操作</th></tr></thead><tbody>${volunteerRows}</tbody></table></div></section><section class="package-preview-section"><div class="package-preview-heading"><h3>相关任职</h3><span class="score-badge">${positions.length} 条 · 取最高分 ${fmt(positionScore)} 分</span></div><div class="table-wrap"><table><thead><tr><th>任职名称</th><th>组织单位</th><th>任职时间</th><th>填写分数</th><th>结果</th><th>操作</th></tr></thead><tbody>${positionRows}</tbody></table></div></section><section class="package-preview-section"><div class="package-preview-heading"><div><h3>证据清单</h3><span class="muted">删除会同步移除关联关系；添加后可关联到已有记录</span></div><div class="inline"><span class="score-badge">${evidence.length} 份</span><button type="button" class="secondary small-button" id="package-evidence-add">添加证据</button></div></div><div class="table-wrap"><table><thead><tr><th>文件名</th><th>关联内容</th><th>操作</th></tr></thead><tbody>${evidenceRows}</tbody></table></div></section></section>`;
}

function evidencePanel(kind, ids, title) {
  const list = evidenceByIds(ids);
  return `<section class="upload-panel"><div class="upload-heading"><div><span class="eyebrow">文件输入</span><h3>${title}</h3><p class="muted">支持 PDF、Word、PNG、JPG、JPEG，可一次选择多个文件。</p></div><span class="upload-count">${list.length} 个文件</span></div><div id="${kind}-dropzone" class="dropzone" data-drop-kind="${kind}"><strong>将原始文件拖到这里</strong><small>也可以点击下方“选择文件”批量添加</small></div><div class="upload-actions"><button type="button" data-choose-evidence="${kind}">选择文件</button>${list.length ? "" : `<span class="empty-upload-hint">添加文件后，会在这里显示待关联的原始证据。</span>`}</div><div class="draft-evidence-list">${list.map((item) => `<div class="draft-evidence"><div><strong>${esc(item.originalName)}</strong><small>${Math.max(1, Math.round(item.size / 1024))} KB · ${esc(item.extension?.toUpperCase() || "文件")}</small></div><div class="inline"><button type="button" class="small-button secondary" data-open="${esc(item.storedPath)}">查看</button><button type="button" class="small-button danger" data-remove-draft-evidence="${esc(item.id)}" data-evidence-kind="${kind}">移除</button></div></div>`).join("")}</div></section>`;
}

function activityForm(item = {}) {
  const value = { ...item, ...activityDraftValues };
  const selectedType = activityTypeFromItem(value);
  return `<form id="activity-form" class="editor-form"><input type="hidden" name="id" value="${esc(value.id)}"/><label>项目名称<input name="name" required value="${esc(value.name)}" placeholder="例如：中药学院志愿服务活动" /></label><label>操行类型<select id="activity-type" name="activityType" required><option value="" ${selectedType ? "" : "selected"}>请选择操行类型</option>${Object.entries(ACTIVITY_TYPES).map(([key, type]) => `<option value="${key}" ${selectedType === key ? "selected" : ""}>${type.label}</option>`).join("")}</select></label><label>得分数据<input id="activity-score" name="score" type="number" min="0" step="0.1" value="${esc(value.score ?? ACTIVITY_TYPES[selectedType]?.score ?? "")}" placeholder="AI 识别或手动填写" /></label><div class="editor-actions"><button type="button" id="activity-ai-recognize">AI 一键识别</button><button type="submit">${activityEditingId ? "更新活动" : "保存活动"}</button>${activityEditingId ? `<button type="button" class="secondary" id="activity-cancel-edit">取消编辑</button>` : ""}</div><p class="form-hint">院级活动按 0.2 分、校级活动按 0.3 分、班级活动按 0.1 分预填。</p></form>`;
}

function activitiesPage() {
  const list = session().activities || [];
  const editing = list.find((item) => item.id === activityEditingId) || {};
  const groups = Object.fromEntries(Object.keys(ACTIVITY_TYPES).map((key) => [key, list.filter((item) => activityTypeFromItem(item) === key).length]));
  const score = list.filter((item) => item.status !== "rejected").reduce((sum, item) => sum + Number(item.score || 0), 0);
  return `<div class="workflow-page"><div class="workflow-top"><div>${evidencePanel("activity", activityDraftEvidenceIds.length ? activityDraftEvidenceIds : editing.evidenceIds || [], "原始证据文件")}</div><section class="editor-panel"><div class="panel-heading"><div><span class="eyebrow">${activityEditingId ? "编辑已保存记录" : "新增操行记录"}</span><h2>${activityEditingId ? "编辑操行数据" : "填写操行数据"}</h2></div><span class="required-note">* 为必填项</span></div>${activityForm(editing)}</section></div><section class="workflow-bottom"><div class="section-heading"><div><span class="eyebrow">已加入数据</span><h2>操行活动列表</h2></div><div class="summary-chips"><span>${list.length} 条记录</span><span>当前分数 ${fmt(score)}</span><span>证据 ${list.reduce((sum, item) => sum + (item.evidenceIds?.length || 0), 0)} 份</span></div></div><div class="category-summary">${Object.entries(ACTIVITY_TYPES).map(([key, type]) => `<div><span>${type.label}</span><strong>${groups[key]}</strong></div>`).join("")}</div><div class="table-wrap"><table><thead><tr><th>项目名称</th><th>操行类型</th><th>得分</th><th>证据</th><th>状态</th><th>操作</th></tr></thead><tbody>${list.map((item) => `<tr><td><strong>${esc(item.name)}</strong></td><td>${esc(activityTypeLabel(item))}</td><td>${fmt(item.score)}</td><td>${item.evidenceIds?.length || 0} 份</td><td>${esc(item.status || "已确认")}</td><td><button class="small-button secondary" data-edit-activity="${esc(item.id)}">编辑</button> <button class="small-button danger" data-delete-activity="${esc(item.id)}">删除</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty-table">还没有保存操行记录</td></tr>`}</tbody></table></div></section></div>`;
}

function volunteerForm(item = {}) {
  const value = { name: "", score: "0.1", ...item, ...volunteerDraftValues };
  return `<form id="volunteer-form" class="editor-form"><input type="hidden" name="id" value="${esc(value.id)}"/><label>项目名称<input name="name" required value="${esc(value.name)}" placeholder="例如：社区志愿服务" /></label><label>得分<input name="score" type="number" value="0.1" readonly /></label><div class="editor-actions"><button type="button" id="volunteer-ai-recognize">AI 一键识别</button><button type="submit">${volunteerEditingId ? "更新志愿记录" : "保存志愿记录"}</button>${volunteerEditingId ? `<button type="button" class="secondary" id="volunteer-cancel-edit">取消编辑</button>` : ""}</div><p class="form-hint">额外志愿服务按办法每次计 0.1 分，累计上限 1 分；AI 只提供项目名称建议。</p></form>`;
}

function volunteerPage() {
  const list = session().volunteers || [];
  const editing = list.find((item) => item.id === volunteerEditingId) || {};
  const score = Math.min(1, list.filter((item) => item.status !== "rejected").length * .1);
  return `<div class="workflow-page"><div class="workflow-top"><div>${evidencePanel("volunteer", volunteerDraftEvidenceIds.length ? volunteerDraftEvidenceIds : editing.evidenceIds || [], "志愿服务证明文件")}</div><section class="editor-panel"><div class="panel-heading"><div><span class="eyebrow">${volunteerEditingId ? "编辑已保存记录" : "新增志愿记录"}</span><h2>${volunteerEditingId ? "编辑额外志愿" : "填写额外志愿"}</h2></div><span class="score-badge">已计 ${score.toFixed(1)} / 1.0 分</span></div>${volunteerForm(editing)}</section></div><section class="workflow-bottom"><div class="section-heading"><div><span class="eyebrow">已加入数据</span><h2>额外志愿活动列表</h2></div><div class="summary-chips"><span>${list.length} 次活动</span><span>最终分数 ${score.toFixed(1)}</span><span>证据 ${list.reduce((sum, item) => sum + (item.evidenceIds?.length || 0), 0)} 份</span></div></div><div class="table-wrap"><table><thead><tr><th>项目名称</th><th>得分</th><th>证明文件</th><th>状态</th><th>操作</th></tr></thead><tbody>${list.map((item) => `<tr><td><strong>${esc(item.name)}</strong></td><td>0.1</td><td>${item.evidenceIds?.length || 0} 份</td><td>${esc(item.status || "已确认")}</td><td><button class="small-button secondary" data-edit-volunteer="${esc(item.id)}">编辑</button> <button class="small-button danger" data-delete-volunteer="${esc(item.id)}">删除</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty-table">还没有保存额外志愿记录</td></tr>`}</tbody></table></div></section></div>`;
}

function positionForm(item = {}) {
  const value = { ...item, ...positionDraftValues };
  return `<form id="position-form" class="editor-form"><input type="hidden" name="id" value="${esc(value.id)}"/><label>任职名称<input name="name" required value="${esc(value.name)}" placeholder="例如：班级学习委员" /></label><label>对应得分<input name="score" type="number" min="0" max="2" step="0.1" required value="${esc(value.score ?? "")}" placeholder="按办法填写" /></label><label>组织单位（可选）<input name="organization" value="${esc(value.organization)}" /></label><label>任职时间（可选）<input name="term" value="${esc(value.term)}" placeholder="例如：2025-2026 学年" /></label><div class="proof-compact"><strong>证明文件（可选）</strong><span class="muted">任职不要求上传证明；如需留档，可在此添加。</span><div class="actions"><button type="button" class="secondary" data-choose-evidence="position">选择证明文件</button></div><div class="draft-evidence-list compact">${evidenceByIds(positionDraftEvidenceIds.length ? positionDraftEvidenceIds : value.evidenceIds || []).map((evidence) => `<div class="draft-evidence"><span>${esc(evidence.originalName)}</span><button type="button" class="small-button danger" data-remove-draft-evidence="${esc(evidence.id)}" data-evidence-kind="position">移除</button></div>`).join("") || `<small class="muted">暂未添加证明文件</small>`}</div></div><div class="editor-actions"><button type="submit">${positionEditingId ? "更新任职记录" : "保存任职记录"}</button>${positionEditingId ? `<button type="button" class="secondary" id="position-cancel-edit">取消编辑</button>` : ""}</div><p class="form-hint">按照办法，相关任职只取最高分，不累计。</p></form>`;
}

function positionsPage() {
  const list = session().positions || [];
  const editing = list.find((item) => item.id === positionEditingId) || {};
  const max = Math.min(2, Math.max(0, ...list.map((item) => Number(item.score || 0))));
  return `<div class="workflow-page"><section class="workflow-top single"><section class="editor-panel"><div class="panel-heading"><div><span class="eyebrow">${positionEditingId ? "编辑已保存记录" : "新增任职记录"}</span><h2>${positionEditingId ? "编辑相关任职" : "填写相关任职"}</h2></div><span class="score-badge">当前有效分 ${max.toFixed(1)}</span></div>${positionForm(editing)}</section></section><section class="workflow-bottom"><div class="section-heading"><div><span class="eyebrow">已加入数据</span><h2>相关任职列表</h2></div><div class="summary-chips"><span>${list.length} 条记录</span><span>按办法取最高分 ${max.toFixed(1)}</span></div></div><div class="table-wrap"><table><thead><tr><th>任职名称</th><th>组织单位</th><th>任职时间</th><th>对应得分</th><th>证明文件</th><th>操作</th></tr></thead><tbody>${list.map((item) => `<tr><td><strong>${esc(item.name)}</strong></td><td>${esc(item.organization)}</td><td>${esc(item.term)}</td><td>${fmt(item.score)}</td><td>${item.evidenceIds?.length || 0} 份</td><td><button class="small-button secondary" data-edit-position="${esc(item.id)}">编辑</button> <button class="small-button danger" data-delete-position="${esc(item.id)}">删除</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty-table">还没有保存任职记录</td></tr>`}</tbody></table></div></section></div>`;
}

function evidencePage() { const list = session().evidence || []; return `<section class="card"><h2>导入 PDF、Word 或图片</h2><div id="dropzone" class="dropzone">把证据文件拖到这里<br/><small>支持 PDF、PNG、JPG、JPEG、DOC、DOCX；AI 开启时会发送必要的文本或图片到配置的模型</small></div><div class="actions"><button id="choose-evidence">选择证据文件</button><button id="evidence-ai-batch" class="secondary">AI 综合识别全部证据</button></div></section><section class="card"><h2>证据清单</h2><p class="muted">AI 识别会把全部证据合并为一个整体判断，不会逐文件单独输出结果。</p><div class="table-wrap"><table><thead><tr><th>文件</th><th>大小</th><th>SHA-256</th><th>操作</th></tr></thead><tbody>${list.map((item) => `<tr><td>${esc(item.originalName)}</td><td>${Math.round(item.size / 1024)} KB</td><td><code>${esc(item.sha256?.slice(0, 12))}...</code></td><td><button class="small-button secondary" data-open="${esc(item.storedPath)}">打开</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">暂无证据</td></tr>`}</tbody></table></div></section>`; }

function classPage() {
  const imports = session().classImports || [];
  const classInfo = session().classExportInfo || {};
  const selectedCount = imports.filter((item) => classSelectedPackageIds.has(item.packageId)).length;
  const allSelected = imports.length > 0 && selectedCount === imports.length;
  return `<section class="card"><div class="section-heading"><div><span class="eyebrow">班级输出信息</span><h2>专业与班级号</h2></div><span class="muted">用于命名班级输出文件</span></div><form id="class-info-form" class="grid two"><label>专业<input name="major" required value="${esc(classInfo.major || "")}" placeholder="例如：中药学类" /></label><label>班级号<input name="classId" required value="${esc(classInfo.classId || "")}" placeholder="例如：2401" /></label><div class="actions" style="grid-column:1/-1"><button type="submit">保存班级信息</button></div></form></section><section class="card"><div class="section-heading"><div><span class="eyebrow">班级资料输入</span><h2>导入学生资料包</h2></div><span class="score-badge">${imports.length} 人</span></div><div id="class-dropzone" class="dropzone">把多个 .conductpkg 或 .zip 拖到这里</div><div class="actions"><button id="choose-packages">选择学生资料包</button><button id="class-export" ${imports.length ? "" : "disabled"}>生成班级两个核心表格</button><button id="class-evidence-export" class="secondary" ${imports.length ? "" : "disabled"}>一键输出学生证明文件汇总</button></div></section><section class="card"><div class="section-heading"><div><span class="eyebrow">已导入学生</span><h2>学生资料列表</h2></div><span class="muted" id="class-selected-count">已选 ${selectedCount} 人</span></div><div class="bulk-toolbar"><label><input type="checkbox" id="class-select-all" ${allSelected ? "checked" : ""} ${imports.length ? "" : "disabled"} /> 全选</label><span class="muted">删除会同步移除已导入记录、对应的本地资料目录和原始压缩文件。</span><button type="button" id="class-delete-selected" class="danger" ${selectedCount ? "" : "disabled"}>批量删除</button></div><div class="table-wrap"><table><thead><tr><th><span class="sr-only">选择</span></th><th>姓名</th><th>学号</th><th>活动记录</th><th>志愿记录</th><th>任职记录</th><th>状态</th></tr></thead><tbody>${imports.map((item) => `<tr><td><input type="checkbox" class="class-package-check" data-class-package-check="${esc(item.packageId)}" ${classSelectedPackageIds.has(item.packageId) ? "checked" : ""} aria-label="选择 ${esc(item.manifest?.profile?.name || item.manifest?.profile?.studentId || "学生资料包")}" /></td><td>${esc(item.manifest?.profile?.name)}</td><td>${esc(item.manifest?.profile?.studentId)}</td><td>${item.manifest?.activities?.length || 0}</td><td>${item.manifest?.volunteers?.length || 0}</td><td>${item.manifest?.positions?.length || 0}</td><td>已导入</td></tr>`).join("") || `<tr><td colspan="7" class="muted">暂无学生资料包</td></tr>`}</tbody></table></div><p class="muted">PU 分数在班级输出中默认保持空白；额外志愿服务按资料包中的手动记录计算。</p></section>`;
}

function settingsPage() {
  const savedAi = account()?.settings?.ai || {};
  const ai = aiHistoryEditId && aiHistoryDraft
    ? { ...savedAi, ...aiHistoryDraft, history: savedAi.history }
    : savedAi;
  const p = project();
  const storage = state.storage || {};
  const storageMarkup = `<section class="card"><h2>本地数据储存位置</h2><p class="muted">账户库、证据文件、班级资料包和导出结果均保存在本机的当前数据目录。更改位置时会先复制完整数据并更新文件引用，原位置保留不删除。</p><div class="storage-location"><code>${esc(storage.dataRoot || "未读取")}</code><button type="button" class="secondary" id="choose-data-location">更改数据位置</button></div></section>`;
  const provider = AI_PROVIDER_PRESETS[ai.provider] ? ai.provider : "manual";
  const preset = AI_PROVIDER_PRESETS[provider];
  const protocols = preset.protocols || Object.keys(AI_PROTOCOLS);
  const history = Array.isArray(ai.history) ? ai.history : [];
  const historyStatus = (item) => item.testStatus === "success" ? "连接正常" : item.testStatus === "error" ? "连接失败" : "未检测";
  const activeIdentity = aiInterfaceIdentity(savedAi);
  const accounts = state.accounts || [];
  const accountManagementMarkup = `<section class="card account-management"><div class="section-heading"><div><span class="eyebrow">本机账户</span><h2>管理账户</h2></div><span class="score-badge">${accounts.length} 个账户</span></div><p class="muted">账户和对应的操行数据只保存在本机。删除账户前需要输入该账户密码，删除后会同时移除它的证据文件和班级资料包。</p><div class="account-list">${accounts.map((item) => `<div class="account-row"><div class="account-row-main"><strong>${esc(item.name)}</strong>${item.id === account()?.id ? `<span class="account-current">当前登录</span>` : ""}<small>${esc(item.profile?.name || "未填写姓名")} · ${esc(item.profile?.studentId || "未填写学号")}</small></div><button type="button" class="small-button danger" data-delete-account="${esc(item.id)}">删除账户</button></div>`).join("") || `<div class="empty-table">暂无本地账户</div>`}</div><details class="account-create"><summary>添加本地账户</summary><form id="manage-create-form" class="grid two" style="margin-top:14px"><label>账户名称<input name="accountName" required placeholder="例如：刘益铭" /></label><label>密码<input name="password" type="password" required minlength="4" /></label><label>学生姓名<input name="name" /></label><label>学号<input name="studentId" /></label><label>专业<input name="major" value="中药学类" /></label><label>班级<input name="classId" /></label><label>学院<input name="college" value="中药学院" /></label><div class="actions"><button type="submit">添加并切换到账户</button></div></form></details></section>`;
  const historyMarkup = `<section class="ai-history"><div class="ai-history-heading"><div><strong>已保存的接口列表</strong><small class="muted">保存的平台、协议、Base URL、模型和连接结果；启用后切换当前实际使用的接口。</small></div><span class="muted">${history.length}/12 条</span></div><div class="table-wrap"><table><thead><tr><th>平台</th><th>协议</th><th>Base URL</th><th>模型</th><th>连接状态</th><th>最近检测</th><th>操作</th></tr></thead><tbody>${history.map((item) => { const active = aiInterfaceIdentity(item) === activeIdentity; return `<tr class="${aiHistoryEditId === item.id ? "ai-history-selected" : ""}"><td>${esc(AI_PROVIDER_PRESETS[item.provider]?.label || item.provider)}</td><td>${esc(AI_PROTOCOLS[item.protocol]?.label || item.protocol)}</td><td><code>${esc(item.baseUrl || "未填写")}</code></td><td>${esc(item.model || "未填写")}</td><td><span class="ai-history-status ${item.testStatus === "success" ? "success" : item.testStatus === "error" ? "error" : "pending"}">${esc(historyStatus(item))}</span>${item.testMessage ? `<small>${esc(item.testMessage)}</small>` : ""}</td><td>${esc(fmtAiHistoryDate(item.testedAt || item.savedAt))}${item.latencyMs !== null && item.latencyMs !== undefined ? `<small>${esc(item.latencyMs)} ms</small>` : ""}</td><td><div class="inline"><button class="small-button ${active ? "secondary" : ""}" data-enable-ai-history="${esc(item.id)}" ${active ? "disabled" : ""}>${active ? "当前使用" : "启用"}</button><button class="small-button secondary" data-edit-ai-history="${esc(item.id)}">编辑</button><button class="small-button danger" data-delete-ai-history="${esc(item.id)}">删除</button></div></td></tr>`; }).join("") || `<tr><td colspan="7" class="muted">暂无历史接口记录。保存设置或测试连接后会自动记录。</td></tr>`}</tbody></table></div></section>`;
  const statusText = ai.provider === "api-manager"
    ? "当前接口使用已保存的本机内部配置。"
    : `${preset.description}。模型结果必须人工确认。`;
  const providerEntries = Object.entries(AI_PROVIDER_PRESETS).filter(([key]) => key !== "api-manager");
  const legacyProviderOption = provider === "api-manager" ? `<option value="api-manager" selected hidden>已有本机内部配置</option>` : "";
  return `${accountManagementMarkup}${storageMarkup}<section class="card"><h2>测评周期与学期</h2><form id="project-form" class="grid two"><label>测评周期<input name="academicYear" value="${esc(p.academicYear)}" /></label><div class="actions"><button type="submit">保存周期设置</button></div></form></section><section class="card"><h2>AI 模型接口</h2><p class="muted">只需配置 AI 开关、平台、协议、Base URL 和 API Key；模型在下方已保存接口列表中同步并启用。</p><form id="ai-form" class="grid two"><input type="hidden" name="historyId" value="${esc(aiHistoryEditId)}" /><label>启用 AI<select name="enabled"><option value="false" ${!ai.enabled ? "selected" : ""}>关闭</option><option value="true" ${ai.enabled ? "selected" : ""}>开启</option></select></label><label>模型平台<select id="ai-provider" name="provider">${legacyProviderOption}${providerEntries.map(([key, item]) => `<option value="${esc(key)}" ${provider === key ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select></label><label>协议<select id="ai-protocol" name="protocol">${protocols.map((key) => `<option value="${esc(key)}" ${ai.protocol === key ? "selected" : ""}>${esc(AI_PROTOCOLS[key]?.label || key)}</option>`).join("")}</select></label><label>Base URL<input id="ai-base-url" name="baseUrl" value="${esc(ai.baseUrl ?? preset.baseUrl)}" placeholder="例如：https://api.example.com/v1" /></label><label>${esc(preset.keyLabel)}<input name="apiKey" type="password" placeholder="${ai.apiKeyConfigured ? "已保存，留空表示不修改" : "仅保存在本机"}" /></label><div class="actions" style="grid-column:1/-1"><button type="submit">${aiHistoryEditId ? "更新接口记录" : "保存 AI 设置"}</button><button type="button" id="ai-test-connection" class="secondary">测试连接</button>${aiHistoryEditId ? `<button type="button" id="ai-cancel-history-edit" class="secondary">取消编辑</button>` : ""}</div></form><div class="notice">${esc(statusText)}</div><div class="notice ${state.security?.safeStorage ? "" : "warning"}">${state.security?.safeStorage ? "API Key 使用 Windows 本地安全存储保护，不写入项目目录、证据文件或导出结果。" : "当前系统安全存储不可用，开发模式将使用本地回退存储。"}</div>${historyMarkup}</section>`;
}

function wirePage() {
  $("#update-check")?.addEventListener("click", async () => {
    const result = await invoke("app:update:check");
    if (result) {
      updateState = result;
      if (state) state.update = result;
      render();
    }
  });
  document.querySelectorAll("[data-update-download]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    const result = await invoke("app:update:download");
    if (result) {
      updateState = result;
      if (state) state.update = result;
      render();
    }
  }));
  document.querySelectorAll("[data-update-install]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    const result = await invoke("app:update:install");
    if (result) {
      updateState = result;
      if (state) state.update = result;
      render();
    }
  }));
  if (activePage === "settings") {
    const academicYearInput = document.querySelector("#project-form input[name=\"academicYear\"]");
    if (academicYearInput) {
      const academicYearSelect = document.createElement("select");
      academicYearSelect.name = "academicYear";
      academicYearSelect.required = true;
      academicYearSelect.innerHTML = ACADEMIC_YEAR_OPTIONS.map((year) => `<option value="${year}">${year}</option>`).join("");
      academicYearSelect.value = academicYearInput.value;
      academicYearInput.replaceWith(academicYearSelect);
    }
    $("#manage-create-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      const result = await invoke("account:create", {
        accountName: form.get("accountName"),
        password: form.get("password"),
        profile: Object.fromEntries(["name", "studentId", "major", "classId", "college"].map((key) => [key, form.get(key)])),
      });
      if (result) {
        state = result;
        aiHistoryEditId = "";
        aiHistoryDraft = null;
        resetActivityDraft();
        resetVolunteerDraft();
        resetPositionDraft();
        message = "账户已添加，并已切换到新账户";
        render();
      }
    });
    document.querySelectorAll("[data-delete-account]").forEach((button) => button.addEventListener("click", async () => {
      const target = (state.accounts || []).find((item) => item.id === button.dataset.deleteAccount);
      if (!target) return;
      const label = target.profile?.name ? `${target.name}（${target.profile.name}）` : target.name;
      if (!window.confirm(`确定删除本地账户“${label}”吗？该账户的操行记录、API Key、证据文件和班级资料包都会被删除。`)) return;
      const password = window.prompt(`请输入账户“${target.name}”的密码以确认删除：`);
      if (password === null) return;
      const result = await invoke("account:delete", { accountId: target.id, password });
      if (result) {
        state = result;
        aiHistoryEditId = "";
        aiHistoryDraft = null;
        resetActivityDraft();
        resetVolunteerDraft();
        resetPositionDraft();
        message = result.session ? `账户“${target.name}”已删除` : "账户已删除，请登录其他本地账户";
        render();
      }
    }));
  }
  $("#student-export")?.addEventListener("click", async () => { const result = await invoke("export:student"); if (result) { message = `学生资料包已生成：${result}`; render(); } });
  if (activePage === "student-package") {
    const exportButton = $("#student-export");
    if (exportButton && !$("#student-preview-toggle")) exportButton.insertAdjacentHTML("beforebegin", `<button type="button" class="secondary" id="student-preview-toggle">${studentPackagePreview ? "刷新预览" : "预览最终资料"}</button>`);
    if (studentPackagePreview) $(".package-contents")?.insertAdjacentHTML("afterend", packagePreviewMarkup());
    if (studentPackagePreview) {
      const evidenceSection = [...document.querySelectorAll(".package-preview-section")].at(-1);
      const evidenceHeading = evidenceSection?.querySelector(".package-preview-heading");
      const evidenceHeader = evidenceSection?.querySelector("table thead tr");
      const activities = (session().activities || []).filter((item) => item.status !== "rejected");
      const bulkActivityOptions = activities.map((item) => `<option value="activity:${esc(item.id)}">${esc(item.name || "未命名项目")}</option>`).join("");
      if (evidenceHeader && !evidenceHeader.querySelector("#package-evidence-select-all")) evidenceHeader.insertAdjacentHTML("afterbegin", `<th class="package-evidence-check-cell"><input type="checkbox" id="package-evidence-select-all" aria-label="全选证据" />全选</th>`);
      if (evidenceHeading && !evidenceHeading.parentElement.querySelector("#package-evidence-bulk-toolbar")) evidenceHeading.insertAdjacentHTML("afterend", `<div id="package-evidence-bulk-toolbar" class="package-evidence-bulk-toolbar"><span id="package-evidence-selected-count" class="muted">已选 0 份</span><select id="package-evidence-bulk-target" ${bulkActivityOptions ? "" : "disabled"}><option value="">批量关联到操行活动</option>${bulkActivityOptions}</select><button type="button" class="small-button secondary" id="package-evidence-link-selected" disabled>批量关联</button><button type="button" class="small-button danger" id="package-evidence-delete-selected" disabled>批量删除</button></div>`);
      const syncPackageEvidenceSelection = () => {
        const validIds = new Set((session().evidence || []).map((item) => item.id));
        packageSelectedEvidenceIds = new Set([...packageSelectedEvidenceIds].filter((id) => validIds.has(id)));
        const checks = [...document.querySelectorAll("[data-package-evidence-check]")];
        const selectedCount = packageSelectedEvidenceIds.size;
        const allChecked = checks.length > 0 && checks.every((check) => packageSelectedEvidenceIds.has(check.dataset.packageEvidenceCheck));
        checks.forEach((check) => { check.checked = packageSelectedEvidenceIds.has(check.dataset.packageEvidenceCheck); });
        const selectAll = $("#package-evidence-select-all");
        if (selectAll) { selectAll.checked = allChecked; selectAll.indeterminate = selectedCount > 0 && !allChecked; }
        const count = $("#package-evidence-selected-count");
        if (count) count.textContent = `已选 ${selectedCount} 份`;
        [$("#package-evidence-link-selected"), $("#package-evidence-delete-selected")].forEach((button) => { if (button) button.disabled = selectedCount === 0; });
      };
      document.querySelectorAll("[data-package-evidence-check]").forEach((check) => check.addEventListener("change", () => { if (check.checked) packageSelectedEvidenceIds.add(check.dataset.packageEvidenceCheck); else packageSelectedEvidenceIds.delete(check.dataset.packageEvidenceCheck); syncPackageEvidenceSelection(); }));
      $("#package-evidence-select-all")?.addEventListener("change", (event) => { const ids = [...document.querySelectorAll("[data-package-evidence-check]")].map((item) => item.dataset.packageEvidenceCheck); if (event.target.checked) ids.forEach((id) => packageSelectedEvidenceIds.add(id)); else ids.forEach((id) => packageSelectedEvidenceIds.delete(id)); syncPackageEvidenceSelection(); });
      $("#package-evidence-delete-selected")?.addEventListener("click", async () => {
        const ids = [...packageSelectedEvidenceIds];
        if (!ids.length || !window.confirm(`确定批量删除已选的 ${ids.length} 份证据文件吗？文件及其关联关系都会被移除。`)) return;
        const next = await invoke("evidence:delete-batch", ids);
        if (next) { state = next; packageSelectedEvidenceIds.clear(); message = `已批量删除 ${ids.length} 份证据文件`; render(); }
      });
      $("#package-evidence-link-selected")?.addEventListener("click", async () => {
        const ids = [...packageSelectedEvidenceIds];
        const target = $("#package-evidence-bulk-target")?.value;
        if (!ids.length) { setTransientError("请先选择要关联的证据文件"); render(); return; }
        if (!target) { setTransientError("请先选择要关联到的操行活动"); render(); return; }
        const next = await invoke("evidence:link-batch", { evidenceIds: ids, target });
        if (next) { state = next; packageSelectedEvidenceIds.clear(); message = `已将 ${ids.length} 份证据关联到所选操行活动`; render(); }
      });
      syncPackageEvidenceSelection();
    }
    $("#student-preview-toggle")?.addEventListener("click", () => { studentPackagePreview = !studentPackagePreview; render(); });
    $("#student-preview-close")?.addEventListener("click", () => { studentPackagePreview = false; render(); });
    $("#student-export-preview")?.addEventListener("click", async () => { const result = await invoke("export:student"); if (result) { message = `学生资料包已重新生成：${result}`; render(); } });
    $("#package-evidence-add")?.addEventListener("click", async () => {
      const paths = await invoke("dialog:openFiles");
      if (!paths?.length) return;
      const result = await invoke("evidence:ingest", paths);
      if (result) {
        if (!result.added?.length) { setTransientError("未添加证据文件，请确认选择的是 PDF、Word、PNG、JPG 或 JPEG 文件"); render(); return; }
        state = result.state;
        message = `已添加 ${result.added.length} 个证据文件，可在清单中关联到已有记录`;
        render();
      }
    });
    document.querySelectorAll("[data-delete-package-evidence]").forEach((button) => button.addEventListener("click", async () => {
      const evidence = (session().evidence || []).find((item) => item.id === button.dataset.deletePackageEvidence);
      if (!evidence || !window.confirm(`确定删除证据文件“${evidence.originalName || "未命名文件"}”吗？文件及其关联关系都会被移除。`)) return;
      const next = await invoke("evidence:delete", evidence.id);
      if (next) {
        state = next;
        packageSelectedEvidenceIds.delete(evidence.id);
        activityDraftEvidenceIds = activityDraftEvidenceIds.filter((id) => id !== evidence.id);
        volunteerDraftEvidenceIds = volunteerDraftEvidenceIds.filter((id) => id !== evidence.id);
        positionDraftEvidenceIds = positionDraftEvidenceIds.filter((id) => id !== evidence.id);
        message = `已删除证据文件：${evidence.originalName || "未命名文件"}`;
        render();
      }
    }));
    document.querySelectorAll("[data-link-package-evidence]").forEach((button) => button.addEventListener("click", async () => {
      const evidenceId = button.dataset.linkPackageEvidence;
      const target = button.closest(".package-evidence-link")?.querySelector("[data-evidence-target]")?.value;
      if (!target) { setTransientError("请先选择要关联的项目"); render(); return; }
      const next = await invoke("evidence:link", { evidenceId, target });
      if (next) { state = next; message = "证据已关联到所选项目"; render(); }
    }));
    document.querySelectorAll("[data-package-edit-activity]").forEach((button) => button.addEventListener("click", () => {
      const item = session().activities.find((entry) => entry.id === button.dataset.packageEditActivity);
      if (item) beginActivityEdit(item, true);
    }));
    document.querySelectorAll("[data-package-edit-volunteer]").forEach((button) => button.addEventListener("click", () => {
      const item = session().volunteers.find((entry) => entry.id === button.dataset.packageEditVolunteer);
      if (item) beginVolunteerEdit(item, true);
    }));
    document.querySelectorAll("[data-package-edit-position]").forEach((button) => button.addEventListener("click", () => {
      const item = session().positions.find((entry) => entry.id === button.dataset.packageEditPosition);
      if (item) beginPositionEdit(item, true);
    }));
  }
  $("#activity-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const type = ACTIVITY_TYPES[data.activityType] || ACTIVITY_TYPES.academic;
    const score = type.score === null ? Number(data.score) : type.score;
    const next = await invoke("activity:save", { ...data, activityType: data.activityType, level: type.level, semester: type.semester, score, scoreMode: type.score === null ? "manual" : "rule", evidenceIds: [...activityDraftEvidenceIds], draftToken: activityDraftToken, status: "accepted" });
    if (next) { state = next; resetActivityDraft(); message = "操行记录已保存"; if (returnToStudentPackage) { returnToStudentPackage = false; activePage = "student-package"; studentPackagePreview = true; } render(); }
  });
  document.querySelectorAll("[data-delete-activity]").forEach((button) => button.addEventListener("click", async () => {
    if (activityEditingId === button.dataset.deleteActivity && !await discardUnsavedDraftEvidence("activity")) return;
    if (!window.confirm("确定删除这条操行记录吗？该记录关联的原始证据文件也会被删除；同时被其他记录使用的证据文件会保留。")) return;
    const next = await invoke("activity:delete", button.dataset.deleteActivity);
    if (next) { state = next; if (activityEditingId === button.dataset.deleteActivity) resetActivityDraft(); message = "操行记录已删除"; render(); }
  }));
  document.querySelectorAll("[data-edit-activity]").forEach((button) => button.addEventListener("click", async () => {
    const item = session().activities.find((entry) => entry.id === button.dataset.editActivity);
    if (!item) return;
    await beginActivityEdit(item);
  }));
  $("#activity-cancel-edit")?.addEventListener("click", async () => { if (!await discardUnsavedDraftEvidence("activity")) return; message = "已取消编辑"; if (returnToStudentPackage) { returnToStudentPackage = false; activePage = "student-package"; studentPackagePreview = true; } render(); });
  $("#activity-type")?.addEventListener("change", (event) => {
    const type = ACTIVITY_TYPES[event.target.value];
    const score = $("#activity-score");
    if (type?.score !== null && score) score.value = type.score;
  });

  $("#volunteer-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const next = await invoke("volunteer:save", { ...data, score: 0.1, evidenceIds: [...volunteerDraftEvidenceIds], draftToken: volunteerDraftToken, status: "accepted" });
    if (next) { state = next; resetVolunteerDraft(); message = "额外志愿记录已保存"; if (returnToStudentPackage) { returnToStudentPackage = false; activePage = "student-package"; studentPackagePreview = true; } render(); }
  });
  document.querySelectorAll("[data-delete-volunteer]").forEach((button) => button.addEventListener("click", async () => {
    if (volunteerEditingId === button.dataset.deleteVolunteer && !await discardUnsavedDraftEvidence("volunteer")) return;
    if (!window.confirm("确定删除这条额外志愿记录吗？原始证明文件不会被删除。")) return;
    const next = await invoke("volunteer:delete", button.dataset.deleteVolunteer);
    if (next) { state = next; if (volunteerEditingId === button.dataset.deleteVolunteer) resetVolunteerDraft(); message = "额外志愿记录已删除"; render(); }
  }));
  document.querySelectorAll("[data-edit-volunteer]").forEach((button) => button.addEventListener("click", async () => {
    const item = session().volunteers.find((entry) => entry.id === button.dataset.editVolunteer);
    if (!item) return;
    await beginVolunteerEdit(item);
  }));
  $("#volunteer-cancel-edit")?.addEventListener("click", async () => { if (!await discardUnsavedDraftEvidence("volunteer")) return; message = "已取消编辑"; if (returnToStudentPackage) { returnToStudentPackage = false; activePage = "student-package"; studentPackagePreview = true; } render(); });

  $("#position-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const next = await invoke("position:save", { ...data, score: Number(data.score), evidenceIds: [...positionDraftEvidenceIds], draftToken: positionDraftToken, status: "accepted" });
    if (next) { state = next; resetPositionDraft(); message = "相关任职记录已保存"; if (returnToStudentPackage) { returnToStudentPackage = false; activePage = "student-package"; studentPackagePreview = true; } render(); }
  });
  document.querySelectorAll("[data-delete-position]").forEach((button) => button.addEventListener("click", async () => {
    if (positionEditingId === button.dataset.deletePosition && !await discardUnsavedDraftEvidence("position")) return;
    if (!window.confirm("确定删除这条任职记录吗？原始证明文件不会被删除。")) return;
    const next = await invoke("position:delete", button.dataset.deletePosition);
    if (next) { state = next; if (positionEditingId === button.dataset.deletePosition) resetPositionDraft(); message = "任职记录已删除"; render(); }
  }));
  document.querySelectorAll("[data-edit-position]").forEach((button) => button.addEventListener("click", async () => {
    const item = session().positions.find((entry) => entry.id === button.dataset.editPosition);
    if (!item) return;
    await beginPositionEdit(item);
  }));
  $("#position-cancel-edit")?.addEventListener("click", async () => { if (!await discardUnsavedDraftEvidence("position")) return; message = "已取消编辑"; if (returnToStudentPackage) { returnToStudentPackage = false; activePage = "student-package"; studentPackagePreview = true; } render(); });

  function draftIds(kind) { return kind === "activity" ? activityDraftEvidenceIds : kind === "volunteer" ? volunteerDraftEvidenceIds : positionDraftEvidenceIds; }
  function setDraftIds(kind, ids) {
    if (kind === "activity") activityDraftEvidenceIds = ids;
    else if (kind === "volunteer") volunteerDraftEvidenceIds = ids;
    else positionDraftEvidenceIds = ids;
  }
  function captureWorkflow(kind) {
    if (kind === "activity") captureDraftForm("#activity-form", activityDraftValues);
    if (kind === "volunteer") captureDraftForm("#volunteer-form", volunteerDraftValues);
    if (kind === "position") captureDraftForm("#position-form", positionDraftValues);
  }
  async function ingest(paths, kind) {
    captureWorkflow(kind);
    const inputPaths = [...new Set((paths || []).filter(Boolean))];
    if (!inputPaths.length) {
      message = "";
      setTransientError("未读取到拖入文件，请重新拖入 PDF、Word、PNG、JPG 或 JPEG 文件");
      render();
      return;
    }
    const draftToken = draftTokenFor(kind);
    const result = await invoke("evidence:ingest", { paths: inputPaths, draftToken });
    if (result) {
      if (!result.added?.length) {
        message = "";
        setTransientError("未导入证据文件，请确认拖入的是 PDF、Word、PNG、JPG 或 JPEG 文件");
        render();
        return;
      }
      state = result.state;
      const addedIds = result.added.map((item) => item.id);
      setDraftIds(kind, [...new Set([...draftIds(kind), ...addedIds])]);
      setDraftNewEvidenceIds(kind, [...new Set([...draftNewEvidenceIds(kind), ...addedIds])]);
      message = `已导入 ${result.added.length} 个${kind === "position" ? "证明" : "证据"}文件`;
      render();
    }
  }
  document.querySelectorAll("[data-choose-evidence]").forEach((button) => button.addEventListener("click", async () => ingest(await invoke("dialog:openFiles"), button.dataset.chooseEvidence)));
  document.querySelectorAll("[data-drop-kind]").forEach((dropzone) => {
    dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("drag"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
    dropzone.addEventListener("drop", async (event) => { event.preventDefault(); dropzone.classList.remove("drag"); await ingest(pathsFromDataTransfer(event.dataTransfer), dropzone.dataset.dropKind); });
  });
  document.querySelectorAll("[data-remove-draft-evidence]").forEach((button) => button.addEventListener("click", async () => {
    const kind = button.dataset.evidenceKind;
    const evidenceId = button.dataset.removeDraftEvidence;
    const isNewDraftEvidence = draftNewEvidenceIds(kind).includes(evidenceId);
    if (isNewDraftEvidence) {
      const next = await invoke("evidence:delete", evidenceId);
      if (!next) return;
      state = next;
      setDraftNewEvidenceIds(kind, draftNewEvidenceIds(kind).filter((id) => id !== evidenceId));
    }
    setDraftIds(kind, draftIds(kind).filter((id) => id !== evidenceId));
    message = isNewDraftEvidence ? "已移除未保存的证据文件" : "已从当前活动中移除证据关联";
    render();
  }));
  async function recognizeEvidenceBatch(evidenceIds, kind) {
    captureWorkflow(kind);
    const ids = [...new Set((evidenceIds || []).filter(Boolean))];
    if (!ids.length) {
      message = `请先拖入或选择${kind === "activity" ? "操行" : "志愿"}证据文件`;
      render();
      return;
    }
    const result = await invoke("evidence:classify-batch", ids);
    if (!result) return;
    if (result.suggestion) {
      const suggestion = result.suggestion;
      const recognizedIds = result.evidenceIds || suggestion.evidenceIds || ids;
      if (kind === "activity") {
        const suggestedType = Object.entries(ACTIVITY_TYPES).find(([, type]) => type.level === suggestion.level && type.semester === suggestion.semester)?.[0];
        const suggestedScore = Number(suggestion.score);
        const hasSuggestedScore = suggestion.score !== null && suggestion.score !== undefined && Number.isFinite(suggestedScore);
        activityDraftEvidenceIds = [...new Set([...activityDraftEvidenceIds, ...recognizedIds])];
        activityDraftValues = { ...activityDraftValues, name: suggestion.activityName || activityDraftValues.name, ...(suggestedType ? { activityType: suggestedType } : {}), ...(hasSuggestedScore ? { score: suggestedScore } : {}) };
        message = suggestion.periodMismatch ? suggestion.reason : hasSuggestedScore ? `AI 已综合 ${recognizedIds.length} 份证据按测评表规则预填 ${suggestedScore.toFixed(1)} 分，请确认项目名称、类型和得分后保存` : `AI 已综合 ${recognizedIds.length} 份证据给出操行建议，但级别或学期无法确认，请人工选择并填写得分`;
      } else {
        volunteerDraftEvidenceIds = [...new Set([...volunteerDraftEvidenceIds, ...recognizedIds])];
        volunteerDraftValues = { ...volunteerDraftValues, name: suggestion.activityName || volunteerDraftValues.name, score: "0.1" };
        message = `AI 已综合 ${recognizedIds.length} 份证据给出志愿项目名称建议，分数仍按每次 0.1 分计算，请确认后保存`;
      }
    } else message = result.message || "AI 未给出可用建议";
    render();
  }
  $("#activity-ai-recognize")?.addEventListener("click", async () => recognizeEvidenceBatch(activityDraftEvidenceIds, "activity"));
  $("#volunteer-ai-recognize")?.addEventListener("click", async () => recognizeEvidenceBatch(volunteerDraftEvidenceIds, "volunteer"));
  $("#evidence-ai-batch")?.addEventListener("click", async () => recognizeEvidenceBatch((session().evidence || []).map((item) => item.id), "activity"));
  document.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => window.conduct.openPath(button.dataset.open)));
  async function importPackages(paths) { const result = await invoke("class:import", paths); if (result) { state = result.state; classSelectedPackageIds.clear(); message = `已导入 ${result.imported.length} 个学生资料包`; render(); } }
  $("#choose-packages")?.addEventListener("click", async () => importPackages(await invoke("dialog:openFiles", { classPackages: true })));
  const classDrop = $("#class-dropzone"); classDrop?.addEventListener("dragover", (event) => { event.preventDefault(); classDrop.classList.add("drag"); }); classDrop?.addEventListener("dragleave", () => classDrop.classList.remove("drag")); classDrop?.addEventListener("drop", async (event) => { event.preventDefault(); classDrop.classList.remove("drag"); importPackages(pathsFromDataTransfer(event.dataTransfer)); });
  const readClassExportInfo = () => { const form = $("#class-info-form"); return form ? Object.fromEntries(new FormData(form)) : {}; };
  $("#class-info-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const result = await invoke("class:settings:update", readClassExportInfo()); if (result) { state = result; message = "班级专业和班级号保存成功"; render(); } });
  $("#class-export")?.addEventListener("click", async () => { const result = await invoke("export:class", readClassExportInfo()); if (result) { message = `班级文件已生成：${result.classWorkbookPath}；${result.detailPath}；${result.evidenceZipPath}`; render(); } });
  const syncClassSelection = () => {
    const checks = [...document.querySelectorAll("[data-class-package-check]")];
    const selected = checks.filter((check) => check.checked).length;
    const selectAll = $("#class-select-all");
    if (selectAll) { selectAll.checked = checks.length > 0 && selected === checks.length; selectAll.indeterminate = selected > 0 && selected < checks.length; }
    const selectedLabel = $("#class-selected-count");
    if (selectedLabel) selectedLabel.textContent = `已选 ${selected} 人`;
    const deleteButton = $("#class-delete-selected");
    if (deleteButton) deleteButton.disabled = selected === 0;
  };
  document.querySelectorAll("[data-class-package-check]").forEach((check) => check.addEventListener("change", () => { if (check.checked) classSelectedPackageIds.add(check.dataset.classPackageCheck); else classSelectedPackageIds.delete(check.dataset.classPackageCheck); syncClassSelection(); }));
  $("#class-select-all")?.addEventListener("change", (event) => { const ids = [...document.querySelectorAll("[data-class-package-check]")].map((item) => item.dataset.classPackageCheck); if (event.target.checked) ids.forEach((id) => classSelectedPackageIds.add(id)); else ids.forEach((id) => classSelectedPackageIds.delete(id)); document.querySelectorAll("[data-class-package-check]").forEach((item) => { item.checked = event.target.checked; }); syncClassSelection(); });
  $("#class-delete-selected")?.addEventListener("click", async () => { const ids = [...classSelectedPackageIds]; if (!ids.length || !window.confirm(`确定批量删除已选的 ${ids.length} 个学生资料包吗？对应的导入记录、本地资料目录和原始压缩文件都会被删除。`)) return; const result = await invoke("class:delete", ids); if (result) { state = result.state; classSelectedPackageIds.clear(); message = `已删除 ${result.removed?.length || ids.length} 个学生资料包${result.deletedArchives ? `，同步删除 ${result.deletedArchives} 个压缩文件` : ""}`; render(); } });
  $("#class-evidence-export")?.addEventListener("click", async () => { const result = await invoke("export:class-evidence", readClassExportInfo()); if (result) { message = `学生证明文件汇总已生成：${result.evidenceZipPath}`; render(); } });
  $("#choose-data-location")?.addEventListener("click", async () => {
    const target = await invoke("dialog:chooseDirectory");
    if (!target) return;
    const next = await invoke("storage:move", target);
    if (next) {
      state = next;
      message = `数据已迁移到：${next.storage?.dataRoot || target}`;
      render();
    }
  });
  $("#project-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    message = "";
    const currentProject = project();
    const next = await invoke("project:update", { ...currentProject, academicYear: data.academicYear, semesters: currentProject.semesters });
    if (next) {
      state = next;
      message = `测评周期保存成功：${data.academicYear}`;
      render();
    }
  });
  $("#ai-provider")?.addEventListener("change", (event) => {
    const preset = AI_PROVIDER_PRESETS[event.target.value] || AI_PROVIDER_PRESETS.manual;
    const protocolSelect = $("#ai-protocol");
    const baseInput = $("#ai-base-url");
    const modelInput = $("#ai-model");
    if (baseInput) baseInput.value = preset.baseUrl;
    if (modelInput) modelInput.value = "";
    if (protocolSelect) {
      protocolSelect.innerHTML = (preset.protocols || Object.keys(AI_PROTOCOLS)).map((key) => `<option value="${esc(key)}">${esc(AI_PROTOCOLS[key]?.label || key)}</option>`).join("");
      protocolSelect.value = preset.protocol;
    }
    aiStatus = null;
    aiModels = [];
    aiStatusFingerprint = "";
  });
  renderAiHistoryCards();
  document.querySelectorAll("[data-enable-ai-history]").forEach((button) => button.addEventListener("click", async () => {
    const historyId = button.dataset.enableAiHistory;
    if (!historyId) return;
    const next = await invoke("ai:history:activate", historyId);
    if (next) {
      state = next;
      aiHistoryEditId = "";
      aiHistoryDraft = null;
      aiStatus = null;
      aiModels = [];
      aiStatusFingerprint = "";
      const active = account()?.settings?.ai;
      message = `已启用接口：${AI_PROVIDER_PRESETS[active?.provider]?.label || active?.provider || "已保存接口"} · ${active?.model || "未选择模型"}`;
      render();
    }
  }));
  document.querySelectorAll("[data-edit-ai-history]").forEach((button) => button.addEventListener("click", () => {
    const historyItem = (account()?.settings?.ai?.history || []).find((item) => item.id === button.dataset.editAiHistory);
    if (!historyItem) return;
    aiHistoryEditId = historyItem.id;
    aiHistoryDraft = { ...historyItem };
    message = `正在编辑接口：${AI_PROVIDER_PRESETS[historyItem.provider]?.label || historyItem.provider} · ${historyItem.model || "未选择模型"}`;
    render();
  }));
  document.querySelectorAll("[data-delete-ai-history]").forEach((button) => button.addEventListener("click", async () => {
    const historyItem = (account()?.settings?.ai?.history || []).find((item) => item.id === button.dataset.deleteAiHistory);
    if (!historyItem || !window.confirm(`确定删除接口记录“${historyItem.model || "未选择模型"}”吗？这不会删除当前接口配置。`)) return;
    const next = await invoke("ai:history:delete", historyItem.id);
    if (next) {
      state = next;
      if (aiHistoryEditId === historyItem.id) {
        aiHistoryEditId = "";
        aiHistoryDraft = null;
      }
      message = "接口历史记录已删除";
      render();
    }
  }));
  $("#ai-cancel-history-edit")?.addEventListener("click", () => { aiHistoryEditId = ""; aiHistoryDraft = null; message = "已取消编辑"; render(); });
  function readAiFormSettings() {
    const data = Object.fromEntries(new FormData($("#ai-form")));
    const current = account()?.settings?.ai || {};
    const source = aiHistoryEditId && aiHistoryDraft ? aiHistoryDraft : current;
    const settings = { ...data, enabled: data.enabled === "true" };
    const sameInterface = source.provider === data.provider && source.baseUrl === data.baseUrl && source.protocol === data.protocol;
    settings.model = sameInterface ? source.model || "" : "";
    if (!data.apiKey && sameInterface) delete settings.apiKey;
    if (!data.apiKey && !sameInterface) settings.apiKey = "";
    return settings;
  }
  const aiForm = $("#ai-form");
  const aiDescription = aiForm?.previousElementSibling;
  if (aiDescription?.classList.contains("muted")) aiDescription.textContent = "只需配置 AI 开关、平台、协议、Base URL 和 API Key；模型在下方已保存接口列表中同步并启用。";
  $("#ai-test-connection")?.remove();
  document.querySelectorAll("[data-test-ai-history]").forEach((button) => button.addEventListener("click", async () => {
    const historyId = button.dataset.testAiHistory;
    if (!historyId) return;
    const result = await invoke("ai:test", { historyId });
    if (result) {
      if (result.state) state = result.state;
      message = `${result.message}（${result.latencyMs} ms）`;
      render();
    }
  }));
  document.querySelectorAll("[data-sync-ai-history-models]").forEach((button) => button.addEventListener("click", async () => {
    const historyId = button.dataset.syncAiHistoryModels;
    if (!historyId || aiHistoryModelRefreshing[historyId]) return;
    aiHistoryModelRefreshing[historyId] = true;
    aiHistoryModelStatus[historyId] = "正在同步在线模型……";
    render();
    const result = await invoke("ai:models", { historyId });
    aiHistoryModelRefreshing[historyId] = false;
    if (result) {
      aiHistoryModels[historyId] = Array.isArray(result.models) ? result.models : [];
      aiHistoryModelStatus[historyId] = `已同步 ${aiHistoryModels[historyId].length} 个模型`;
    } else {
      aiHistoryModelStatus[historyId] = error || "在线模型同步失败";
    }
    render();
  }));
  document.querySelectorAll("[data-enable-ai-history-model]").forEach((button) => button.addEventListener("click", async () => {
    const historyId = button.dataset.enableAiHistoryModel;
    const model = button.dataset.aiHistoryModel;
    if (!historyId || !model) return;
    const next = await invoke("ai:history:model:activate", { historyId, model });
    if (next) {
      state = next;
      aiHistoryEditId = "";
      aiHistoryDraft = null;
      message = `已启用模型：${model}`;
      render();
    }
  }));
  $("#ai-test-connection")?.addEventListener("click", async () => {
    const settings = readAiFormSettings();
    const result = await invoke("ai:test", settings);
    if (result) {
      if (result.state) state = result.state;
      if (aiHistoryEditId && settings.historyId === aiHistoryEditId) {
        aiHistoryDraft = {
          ...(aiHistoryDraft || {}),
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          protocol: settings.protocol,
          model: settings.model,
          apiKeyConfigured: settings.apiKey ? true : aiHistoryDraft?.apiKeyConfigured,
        };
      }
      message = `${result.message}（${result.latencyMs} ms）`;
      render();
    }
  });
  $("#ai-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const next = await invoke("ai:save", readAiFormSettings()); if (next) { state = next; aiHistoryEditId = ""; aiHistoryDraft = null; aiStatus = null; aiModels = []; aiStatusFingerprint = ""; message = "AI 设置已保存"; render(); } });
  ensureAiStatusPolling();
  if (activePage === "settings" && !aiHistoryEditId) refreshAiStatus();
}

function render() {
  if (!state?.session) return loginView();
  let content = ({ overview: overviewPage, activities: activitiesPage, volunteer: volunteerPage, positions: positionsPage, "student-package": studentPackagePage, evidence: evidencePage, class: classPage, settings: settingsPage })[activePage]();
  if (activePage === "student-package") content = content.replaceAll(".conductpkg", ".zip");
  shellView(content);
  if (activePage === "settings") document.querySelector(".main .topbar")?.insertAdjacentHTML("afterend", updateCardMarkup());
  wirePage();
}

boot();
