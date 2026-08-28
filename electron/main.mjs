import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import updaterPackage from "electron-updater";
import {
  ACADEMIC_YEAR_OPTIONS,
  DEFAULT_PROJECT,
  activityScore,
  activitySummary,
  buildActivitySuggestion,
  effectivePositionScore,
  extraVolunteerScore,
  levelLabel,
  normalizeProject,
  semesterForDate,
  semesterRangesForAcademicYear,
} from "../src/core/scoring.mjs";
import {
  AI_HISTORY_LIMIT,
  DEFAULT_AI_SETTINGS,
  AI_PROVIDER_PRESETS,
  normalizeAiHistory,
  normalizeAiSettings,
} from "../src/core/ai.mjs";

const execFileAsync = promisify(execFile);
const { autoUpdater } = updaterPackage;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const AI_REQUEST_DEFAULTS = Object.freeze({ temperature: 0, maxTokens: 800 });
const DATA_LAYOUT_VERSION = 2;
const APP_STORAGE_NAMESPACE = "ymliuCaoXingAgent";
const LEGACY_STORAGE_NAMESPACE = "conduct-assistant";
app.setName(APP_STORAGE_NAMESPACE);
function pointerPathFor(namespace) {
  return path.join(app.getPath("appData"), namespace, "storage-location.txt");
}

function fallbackDataRootPath() {
  return path.resolve(path.join(app.getPath("documents"), `${APP_STORAGE_NAMESPACE}-数据`));
}

function readInitialDataRoot() {
  for (const candidate of [
    pointerPathFor(APP_STORAGE_NAMESPACE),
    pointerPathFor(LEGACY_STORAGE_NAMESPACE),
  ]) {
    try {
      const configured = readFileSync(candidate, "utf8").trim();
      if (configured && path.isAbsolute(configured)) return path.resolve(configured);
    } catch (error) {
      if (error.code !== "ENOENT") console.warn("无法读取已有数据位置配置：", error.message);
    }
  }
  return fallbackDataRootPath();
}

const initialDataRoot = readInitialDataRoot();
try {
  mkdirSync(initialDataRoot, { recursive: true });
  mkdirSync(path.join(initialDataRoot, ".runtime"), { recursive: true });
  app.setPath("userData", initialDataRoot);
  app.setPath("sessionData", path.join(initialDataRoot, ".runtime"));
} catch (error) {
  console.warn("无法在启动前切换 Electron 用户数据目录：", error.message);
}
let mainWindow;
let vault = null;
let sessionAccountId = null;
let activeDataRoot = initialDataRoot;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const updateState = {
  status: "disabled",
  currentVersion: app.getVersion(),
  version: "",
  releaseName: "",
  percent: 0,
  message: "尚未配置 GitHub Releases 更新源",
  manual: false,
};
let updaterReady = false;
let updateCheckInFlight = null;
let updateDownloadInFlight = null;
let updateCheckTimer = null;

function updateStateForRenderer() {
  return { ...updateState };
}

function sendUpdateState(patch = {}) {
  Object.assign(updateState, patch, { currentVersion: app.getVersion() });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:update-state", updateStateForRenderer());
}

function updateErrorMessage(error) {
  const detail = String(error?.message || error || "未知错误").trim();
  return detail ? `更新操作失败：${detail}` : "更新操作失败，请稍后重试";
}

async function readUpdateConfig() {
  try {
    const config = JSON.parse(await fs.readFile(path.join(app.getAppPath(), "electron", "update-config.json"), "utf8"));
    const owner = String(config?.owner || "").trim().replace(/^\/+|\/+$/g, "");
    const repo = String(config?.repo || "").trim().replace(/^\/+|\/+$/g, "");
    if (!owner || !repo) return null;
    return { provider: "github", owner, repo, releaseType: config.releaseType === "prerelease" ? "prerelease" : "release" };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    console.warn("无法读取在线更新配置，更新功能将保持停用：", error.message);
    return null;
  }
}

function bindAutoUpdaterEvents() {
  autoUpdater.on("checking-for-update", () => sendUpdateState({ status: "checking", message: "正在检查新版本…", percent: 0 }));
  autoUpdater.on("update-available", (info = {}) => sendUpdateState({
    status: "available",
    version: String(info.version || ""),
    releaseName: String(info.releaseName || ""),
    message: `发现新版本 ${info.version || ""}，等待用户确认下载`,
    percent: 0,
  }));
  autoUpdater.on("update-not-available", () => sendUpdateState({
    status: "up-to-date",
    version: "",
    releaseName: "",
    message: "当前已经是最新版本",
    percent: 0,
  }));
  autoUpdater.on("download-progress", (progress = {}) => sendUpdateState({
    status: "downloading",
    percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    message: `正在下载新版本 ${Math.round(Number(progress.percent) || 0)}%`,
  }));
  autoUpdater.on("update-downloaded", (info = {}) => sendUpdateState({
    status: "downloaded",
    version: String(info.version || updateState.version || ""),
    releaseName: String(info.releaseName || updateState.releaseName || ""),
    message: `新版本 ${info.version || updateState.version || ""} 已下载，等待重启安装`,
    percent: 100,
  }));
  autoUpdater.on("error", (error) => sendUpdateState({ status: "error", message: updateErrorMessage(error) }));
}

async function initializeAutoUpdater() {
  if (!app.isPackaged) {
    sendUpdateState({ status: "disabled", message: "开发模式不检查更新" });
    return;
  }

  const configuredFeed = await readUpdateConfig();
  const packagedFeed = path.join(process.resourcesPath, "app-update.yml");
  if (!configuredFeed && !await pathExists(packagedFeed)) {
    sendUpdateState({ status: "disabled", message: "尚未配置 GitHub Releases 更新源" });
    return;
  }

  if (configuredFeed) autoUpdater.setFeedURL(configuredFeed);
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  bindAutoUpdaterEvents();
  updaterReady = true;
  sendUpdateState({ status: "idle", message: "已启用 GitHub Releases 更新检查" });
  setTimeout(() => checkForUpdates(false), 10_000);
  updateCheckTimer = setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
}

async function checkForUpdates(manual = false) {
  if (!updaterReady) return updateStateForRenderer();
  if (updateCheckInFlight) return updateCheckInFlight;
  sendUpdateState({ manual, status: "checking", message: "正在检查新版本…", percent: 0 });
  updateCheckInFlight = autoUpdater.checkForUpdates()
    .catch((error) => {
      sendUpdateState({ status: "error", message: updateErrorMessage(error), manual });
      return null;
    })
    .then(() => updateStateForRenderer())
    .finally(() => { updateCheckInFlight = null; });
  return updateCheckInFlight;
}

async function downloadUpdate() {
  if (!updaterReady || updateState.status !== "available") throw new Error("当前没有可下载的更新");
  if (updateDownloadInFlight) return updateDownloadInFlight;
  sendUpdateState({ status: "downloading", message: "正在准备下载新版本…", percent: 0 });
  updateDownloadInFlight = autoUpdater.downloadUpdate()
    .catch((error) => {
      sendUpdateState({ status: "error", message: updateErrorMessage(error) });
      return null;
    })
    .then(() => updateStateForRenderer())
    .finally(() => { updateDownloadInFlight = null; });
  return updateDownloadInFlight;
}

function installUpdate() {
  if (!updaterReady || updateState.status !== "downloaded") throw new Error("新版本尚未下载完成");
  autoUpdater.quitAndInstall(false, true);
  return updateStateForRenderer();
}

function defaultDataRoot() {
  return fallbackDataRootPath();
}

function dataRoot() {
  return activeDataRoot || defaultDataRoot();
}

function storagePointerPath() {
  return pointerPathFor(APP_STORAGE_NAMESPACE);
}

function legacyStoragePointerPath() {
  return pointerPathFor(LEGACY_STORAGE_NAMESPACE);
}

function storagePointerCandidates() {
  return [storagePointerPath(), legacyStoragePointerPath()];
}

function dataPath(...parts) {
  return path.join(dataRoot(), ...parts);
}

function exportRoot() {
  return dataPath("导出结果");
}

function legacyVaultPath() {
  return dataPath("账户数据", "conduct-assistant-vault.enc.json");
}

function legacyRootVaultPath() {
  return dataPath("conduct-assistant-vault.enc.json");
}

function legacyVaultPaths() {
  return [legacyVaultPath(), legacyRootVaultPath()];
}

async function migrateLegacyDefaultDataRoot(targetRoot) {
  const legacyRoot = path.join(app.getPath("appData"), LEGACY_STORAGE_NAMESPACE);
  if (samePath(legacyRoot, targetRoot) || !await pathExists(legacyRoot)) return false;
  const transferable = new Set([
    "账户数据",
    "证据资料",
    "班级资料包",
    "导出结果",
    "evidence",
    "class-evidence",
    "conduct-assistant-vault.enc.json",
    "数据目录说明.txt",
  ]);
  const entries = await fs.readdir(legacyRoot);
  const transferableEntries = entries.filter((entry) => transferable.has(entry));
  if (!transferableEntries.length) return false;
  await fs.mkdir(targetRoot, { recursive: true });
  if ((await fs.readdir(targetRoot)).length) return false;
  for (const entry of transferableEntries) {
    await fs.cp(path.join(legacyRoot, entry), path.join(targetRoot, entry), { recursive: true });
    await fs.rm(path.join(legacyRoot, entry), { recursive: true, force: true });
  }
  return true;
}

function vaultPath() {
  return dataPath("账户数据", "账户库.enc.json");
}

async function initializeDataRoot() {
  const fallback = defaultDataRoot();
  if (!activeDataRoot) activeDataRoot = fallback;
  let configuredPointer = "";
  let configuredPointerPath = "";
  for (const candidate of storagePointerCandidates()) {
    try {
      const configured = (await fs.readFile(candidate, "utf8")).trim();
      if (configured && path.isAbsolute(configured)) {
        configuredPointer = path.resolve(configured);
        configuredPointerPath = candidate;
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (configuredPointer) {
    activeDataRoot = configuredPointer;
    if (!samePath(configuredPointerPath, storagePointerPath())) {
      await writeStoragePointer(activeDataRoot);
    }
  } else if (samePath(activeDataRoot, fallback)) {
    await migrateLegacyDefaultDataRoot(activeDataRoot);
    await writeStoragePointer(activeDataRoot);
  }
  await fs.mkdir(activeDataRoot, { recursive: true });
  try {
    // Keep Electron's cache, preferences and application data beside the selected data.
    // The central pointer only stores the location; account and password data never use it.
    await fs.mkdir(path.join(activeDataRoot, ".runtime"), { recursive: true });
    app.setPath("userData", activeDataRoot);
    app.setPath("sessionData", path.join(activeDataRoot, ".runtime"));
  } catch (error) {
    console.warn("无法将 Electron 用户数据目录切换到选定位置：", error.message);
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function pathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rebaseStoredPaths(oldRoot, newRoot) {
  const rebase = (value) => {
    if (!value) return value;
    const resolved = path.resolve(String(value));
    if (!pathWithin(oldRoot, resolved)) return value;
    return path.join(newRoot, path.relative(oldRoot, resolved));
  };
  for (const account of vault?.accounts || []) {
    for (const evidence of account.evidence || []) evidence.storedPath = rebase(evidence.storedPath);
    for (const item of account.classImports || []) item.extractedRoot = rebase(item.extractedRoot);
  }
}

async function writeStoragePointer(root) {
  await fs.mkdir(path.dirname(storagePointerPath()), { recursive: true });
  await fs.writeFile(storagePointerPath(), `${path.resolve(root)}\n`, "utf8");
}

async function moveDataRoot(nextRoot) {
  const requested = String(nextRoot || "").trim();
  if (!requested || !path.isAbsolute(requested)) throw new Error("请选择有效的数据储存文件夹");
  const target = path.resolve(requested);
  const source = dataRoot();
  if (samePath(source, target)) return stateForRenderer();
  if (pathWithin(source, target) || pathWithin(target, source)) throw new Error("数据储存位置不能位于当前数据目录内部或包含当前数据目录");

  await fs.mkdir(target, { recursive: true });
  const existing = await fs.readdir(target);
  if (existing.length) throw new Error("目标数据储存文件夹必须为空，请选择新的空文件夹");
  const pointer = path.resolve(storagePointerPath());
  await fs.cp(source, target, {
    recursive: true,
    filter: (sourcePath) => !samePath(sourcePath, pointer),
  });
  rebaseStoredPaths(source, target);
  activeDataRoot = target;
  await writeStoragePointer(target);
  try {
    app.setPath("userData", target);
    await fs.mkdir(path.join(target, ".runtime"), { recursive: true });
    app.setPath("sessionData", path.join(target, ".runtime"));
  } catch (error) {
    console.warn("无法更新 Electron 用户数据目录：", error.message);
  }
  await writeVault();
  return stateForRenderer();
}

function now() {
  return new Date().toISOString();
}

function id(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

function safeName(value) {
  return String(value || "未命名").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 100) || "未命名";
}

function preferredAccountFolderName(account) {
  const profile = account?.profile || {};
  const identity = [profile.name || account?.name || "未命名账户", profile.studentId].filter(Boolean).join("_");
  return safeName(`账户-${identity || "未命名"}`);
}

function accountFolderName(account) {
  return safeName(account?.storageFolderName || preferredAccountFolderName(account));
}

function accountEvidenceRoot(account) {
  return dataPath("证据资料", accountFolderName(account));
}

function accountClassRoot(account) {
  return dataPath("班级资料包", accountFolderName(account));
}

function assignReadableStorageFolderNames(accounts = []) {
  const used = new Set();
  let changed = false;
  for (const account of accounts) {
    const base = safeName(account.storageFolderName || preferredAccountFolderName(account));
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}（${suffix++}）`;
    if (account.storageFolderName !== candidate) {
      account.storageFolderName = candidate;
      changed = true;
    }
    used.add(candidate);
  }
  return changed;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function availableFilePath(directory, fileName) {
  const parsed = path.parse(safeName(fileName || "未命名文件"));
  const base = parsed.name || "未命名文件";
  let candidate = path.join(directory, `${base}${parsed.ext}`);
  let suffix = 2;
  while (await pathExists(candidate)) candidate = path.join(directory, `${base}（${suffix++}）${parsed.ext}`);
  return candidate;
}

async function moveFile(sourcePath, targetPath) {
  if (samePath(sourcePath, targetPath)) return targetPath;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  }
  return targetPath;
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function passwordDigest(password, salt) {
  return scryptSync(String(password), Buffer.from(salt, "base64"), 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("base64");
}

function aiHistoryIdentity(ai) {
  return [ai.provider, ai.baseUrl, ai.protocol, ai.model].map((value) => String(value || "").trim()).join("|");
}

function normalizeAiHistorySecrets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, apiKey]) => id && typeof apiKey === "string" && apiKey));
}

function upsertAiHistory(history, ai, testResult = null, historyId = "") {
  const existingHistory = normalizeAiHistory(history);
  const identity = aiHistoryIdentity(ai);
  const existing = historyId
    ? existingHistory.find((item) => item.id === historyId)
    : existingHistory.find((item) => aiHistoryIdentity(item) === identity);
  const identityChanged = Boolean(existing && aiHistoryIdentity(existing) !== identity);
  const entry = {
    id: existing?.id || id("ai-history"),
    provider: ai.provider,
    baseUrl: ai.baseUrl,
    model: ai.model,
    protocol: ai.protocol,
    apiKeyConfigured: Boolean(ai.apiKey),
    savedAt: existing?.savedAt || now(),
    testedAt: identityChanged ? "" : (existing?.testedAt || ""),
    testStatus: identityChanged ? "not-tested" : (existing?.testStatus || "not-tested"),
    testMessage: identityChanged ? "" : (existing?.testMessage || ""),
    latencyMs: identityChanged ? null : (existing?.latencyMs ?? null),
  };
  if (testResult) {
    entry.testedAt = now();
    entry.testStatus = testResult.success ? "success" : "error";
    entry.testMessage = testResult.message || "";
    entry.latencyMs = Number.isFinite(Number(testResult.latencyMs)) ? Number(testResult.latencyMs) : null;
  }
  return [entry, ...existingHistory.filter((item) => item.id !== entry.id && aiHistoryIdentity(item) !== identity)].slice(0, AI_HISTORY_LIMIT);
}

function saveAiHistory(account, ai, testResult = null, historyId = "", updateCurrent = false) {
  const previousHistory = normalizeAiHistory(account.settings?.ai?.history);
  const previous = historyId ? previousHistory.find((item) => item.id === historyId) : null;
  const identityChanged = Boolean(previous && aiHistoryIdentity(previous) !== aiHistoryIdentity(ai));
  const history = upsertAiHistory(previousHistory, ai, testResult, historyId);
  const secrets = normalizeAiHistorySecrets(account.settings?.ai?.historySecrets);
  if (identityChanged && previous?.id) delete secrets[previous.id];
  const entry = history.find((item) => aiHistoryIdentity(item) === aiHistoryIdentity(ai));
  if (entry?.id && ai.apiKey) secrets[entry.id] = ai.apiKey;
  const validIds = new Set(history.map((item) => item.id));
  for (const id of Object.keys(secrets)) if (!validIds.has(id)) delete secrets[id];
  account.settings.ai = {
    ...(updateCurrent ? ai : normalizeAiSettings(account.settings?.ai)),
    history,
    historySecrets: secrets,
  };
}

function accountFromVault(account) {
  const { passwordHash, passwordSalt, ...safe } = account;
  const sourceAi = account.settings?.ai || {};
  const ai = normalizeAiSettings(sourceAi);
  const history = normalizeAiHistory(sourceAi.history);
  return {
    ...safe,
    settings: {
      ...(safe.settings || {}),
      ai: {
        ...ai,
        history,
        apiKeyConfigured: Boolean(ai.apiKey),
        apiKey: undefined,
      },
    },
  };
}

function blankAccount(name, password, profile = {}) {
  const salt = randomBytes(16).toString("base64");
  return {
    id: id("account"),
    name: String(name).trim(),
    storageFolderName: "",
    passwordSalt: salt,
    passwordHash: passwordDigest(password, salt),
    createdAt: now(),
    profile: {
      name: profile.name || "",
      studentId: profile.studentId || "",
      major: profile.major || "",
      classId: profile.classId || "",
      college: profile.college || "中药学院",
    },
    project: normalizeProject(profile.project || DEFAULT_PROJECT),
    activities: [],
    volunteers: [],
    positions: [],
    evidence: [],
    classImports: [],
    classExportInfo: normalizeClassExportInfo({}, profile),
    settings: {
      ai: { ...DEFAULT_AI_SETTINGS, history: [] },
    },
  };
}

async function readVault() {
  for (const candidate of [vaultPath(), ...legacyVaultPaths()]) {
    try {
      const envelope = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (envelope.algorithm === "electron-safeStorage") {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 本地安全存储不可用");
        return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, "base64")));
      }
      if (envelope.algorithm === "development-fallback") return envelope.payload;
      throw new Error("账户数据文件格式无法识别");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  return { version: 1, accounts: [] };
}

async function writeVault() {
  const payload = JSON.stringify(vault);
  await fs.mkdir(path.dirname(vaultPath()), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    await fs.writeFile(vaultPath(), JSON.stringify({
      version: 1,
      algorithm: "electron-safeStorage",
      payload: safeStorage.encryptString(payload).toString("base64"),
    }), "utf8");
  } else {
    await fs.writeFile(vaultPath(), JSON.stringify({ version: 1, algorithm: "development-fallback", payload: vault }), "utf8");
  }
}

function currentAccount() {
  return vault?.accounts?.find((item) => item.id === sessionAccountId) || null;
}

function requireAccount() {
  const account = currentAccount();
  if (!account) throw new Error("请先登录本地账户");
  return account;
}

async function saveAndState() {
  await writeVault();
  return stateForRenderer();
}

function stateForRenderer() {
  const account = currentAccount();
  return {
    update: updateStateForRenderer(),
    security: { safeStorage: safeStorage.isEncryptionAvailable() },
    storage: {
      dataRoot: dataRoot(),
      defaultRoot: defaultDataRoot(),
      customized: !samePath(dataRoot(), defaultDataRoot()),
    },
    accounts: (vault?.accounts || []).map(accountFromVault),
    session: account ? {
      account: accountFromVault(account),
      project: normalizeProject(account.project),
      activities: account.activities,
      volunteers: account.volunteers,
      positions: account.positions,
      evidence: account.evidence,
      classImports: account.classImports || [],
      classExportInfo: normalizeClassExportInfo(account.classExportInfo, account.profile),
    } : null,
  };
}

function activityStorageGroup(activity, project) {
  const config = normalizeProject(project);
  const special = {
    award: "集体获奖",
    individual: "先进个人",
    academic: "学术科研与技能",
  };
  if (special[activity?.activityType]) return special[activity.activityType];
  const level = activity?.level === "school" ? "校级活动" : activity?.level === "college" ? "院级活动" : activity?.level === "class" ? "班级活动" : "待人工归类";
  const semester = activity?.semester || semesterForDate(activity?.date, config);
  const semesterLabel = config.semesters[semester]?.label;
  return semesterLabel && level !== "待人工归类" ? `${level}_${semesterLabel}` : level;
}

function evidenceStorageDirectory(account, evidence) {
  const root = accountEvidenceRoot(account);
  const activity = (account.activities || []).find((item) => item.evidenceIds?.includes(evidence.id));
  if (activity) return path.join(root, "操行收集", safeName(activityStorageGroup(activity, account.project)), safeName(activity.name || "未命名活动"));
  const volunteer = (account.volunteers || []).find((item) => item.evidenceIds?.includes(evidence.id));
  if (volunteer) return path.join(root, "额外志愿", safeName(volunteer.name || "未命名项目"));
  const position = (account.positions || []).find((item) => item.evidenceIds?.includes(evidence.id));
  if (position) return path.join(root, "相关任职", safeName(position.name || "未命名任职"));
  return path.join(root, "待关联证据");
}

function classImportFolderName(item) {
  const profile = item?.manifest?.profile || {};
  const identity = [profile.name || "未命名学生", profile.studentId].filter(Boolean).join("_");
  return safeName(item?.storageFolderName || identity || "未命名学生资料");
}

function normalizeClassExportInfo(value = {}, fallback = {}) {
  return {
    major: String(value?.major ?? fallback?.major ?? "").trim(),
    classId: String(value?.classId ?? fallback?.classId ?? "").trim(),
  };
}

function classExportPrefix(account) {
  const info = normalizeClassExportInfo(account.classExportInfo);
  return safeName([info.major, info.classId, account.project.academicYear].filter(Boolean).join("-") || account.project.academicYear);
}

async function prepareClassExportInfo(account, value = {}) {
  const current = normalizeClassExportInfo(account.classExportInfo, account.profile);
  const info = normalizeClassExportInfo(value, current);
  if (!info.major || !info.classId) throw new Error("请先填写专业和班级号");
  if (JSON.stringify(current) !== JSON.stringify(info) || JSON.stringify(account.classExportInfo || {}) !== JSON.stringify(info)) {
    account.classExportInfo = info;
    await saveAndState();
  }
  return info;
}

async function removeDirectoryIfEmpty(directory) {
  try {
    if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  }
}

function migrateAccountAiSettings(account) {
  const source = account.settings?.ai || {};
  const normalized = normalizeAiSettings(source);
  const history = normalizeAiHistory(source.history);
  const before = JSON.stringify([
    source.enabled,
    source.provider,
    source.baseUrl,
    source.model,
    source.protocol,
    source.history || [],
  ]);
  const after = JSON.stringify([
    normalized.enabled,
    normalized.provider,
    normalized.baseUrl,
    normalized.model,
    normalized.protocol,
    history,
  ]);
  account.settings = { ...(account.settings || {}), ai: { ...source, ...normalized, history } };
  return before !== after;
}

async function migrateReadableDataLayout() {
  if (!vault) return;
  let changed = assignReadableStorageFolderNames(vault.accounts || []);
  if (vault.dataLayoutVersion !== DATA_LAYOUT_VERSION) {
    vault.dataLayoutVersion = DATA_LAYOUT_VERSION;
    changed = true;
  }
  await fs.mkdir(dataPath("账户数据"), { recursive: true });
  await fs.mkdir(dataPath("证据资料"), { recursive: true });
  await fs.mkdir(dataPath("班级资料包"), { recursive: true });

  for (const account of vault.accounts || []) {
    changed = migrateAccountAiSettings(account) || changed;
    if (await discardAllDraftEvidence(account)) changed = true;
    const evidenceRoot = accountEvidenceRoot(account);
    for (const evidence of account.evidence || []) {
      const source = String(evidence.storedPath || "");
      if (!source || !await pathExists(source) || pathWithin(evidenceRoot, source) || !pathWithin(dataRoot(), source)) continue;
      const targetDirectory = evidenceStorageDirectory(account, evidence);
      const target = await availableFilePath(targetDirectory, evidence.originalName || path.basename(source));
      await moveFile(source, target);
      evidence.storedPath = target;
      changed = true;
    }

    const classRoot = accountClassRoot(account);
    const usedClassNames = new Set();
    for (const item of account.classImports || []) {
      const baseName = classImportFolderName(item);
      let folderName = baseName;
      let suffix = 2;
      while (usedClassNames.has(folderName)) folderName = `${baseName}（${suffix++}）`;
      usedClassNames.add(folderName);
      if (item.storageFolderName !== folderName) {
        item.storageFolderName = folderName;
        changed = true;
      }
      const source = String(item.extractedRoot || "");
      const target = path.join(classRoot, folderName);
      if (source && await pathExists(source) && !pathWithin(classRoot, source) && pathWithin(dataRoot(), source)) {
        const targetPath = await pathExists(target) ? path.join(classRoot, `${folderName}（${suffix}）`) : target;
        await moveFile(source, targetPath);
        item.extractedRoot = targetPath;
        changed = true;
      } else if (await pathExists(target) && item.extractedRoot !== target) {
        item.extractedRoot = target;
        changed = true;
      }
    }

    await removeDirectoryIfEmpty(dataPath("evidence", account.id));
    await removeDirectoryIfEmpty(dataPath("class-evidence", account.id));
  }
  await removeDirectoryIfEmpty(dataPath("evidence"));
  await removeDirectoryIfEmpty(dataPath("class-evidence"));

  const guidePath = dataPath("数据目录说明.txt");
  if (!await pathExists(guidePath)) {
    await fs.writeFile(guidePath, [
      "操行统计助手 · 本地数据目录说明",
      "",
      "账户数据\\账户库.enc.json：加密保存本地账户、API Key、个人信息、活动记录和设置。",
      "证据资料\\账户-姓名_学号：按账户保存原始证据。操行收集按级别和学期分类，其他证据按项目名称分类。",
      "班级资料包\\账户-姓名_学号：保存班长导入的学生资料包，按学生姓名和学号分类。",
      "导出结果：保存学生资料包、班级操行明细汇总表、班级综测汇总工作簿和班级证据包。",
      "数据目录说明.txt：本说明文件。",
      "",
      "API Key 仅保存在加密账户库中，不会单独生成明文 Key 文件。",
    ].join("\n"), "utf8");
  }

  const oldVaults = legacyVaultPaths().filter((candidate) => !samePath(candidate, vaultPath()));
  for (const oldVault of oldVaults) {
    if (await pathExists(oldVault)) {
      changed = true;
      break;
    }
  }
  if (changed || !await pathExists(vaultPath())) await writeVault();
  for (const oldVault of oldVaults) {
    if (await pathExists(oldVault)) {
      try { await fs.unlink(oldVault); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

async function organizeEvidenceFile(account, evidence) {
  const source = String(evidence.storedPath || "");
  if (!source || !await pathExists(source) || !pathWithin(dataRoot(), source)) return false;
  const targetDirectory = evidenceStorageDirectory(account, evidence);
  if (path.resolve(path.dirname(source)).toLowerCase() === path.resolve(targetDirectory).toLowerCase()) return false;
  const target = await availableFilePath(targetDirectory, evidence.originalName || path.basename(source));
  await moveFile(source, target);
  evidence.storedPath = target;
  return true;
}

async function organizeAccountEvidence(account) {
  let changed = false;
  for (const evidence of account.evidence || []) changed = await organizeEvidenceFile(account, evidence) || changed;
  return changed;
}

async function removeAccountData(account) {
  const targets = [
    accountEvidenceRoot(account),
    accountClassRoot(account),
    dataPath("evidence", account.id),
    dataPath("class-evidence", account.id),
  ];
  for (const target of targets) {
    const resolved = path.resolve(target);
    if (!pathWithin(dataRoot(), resolved) || samePath(dataRoot(), resolved)) throw new Error("账户数据目录校验失败，未删除账户");
    if (await pathExists(resolved)) await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function collectFiles(inputPaths) {
  const result = [];
  for (const target of inputPaths || []) {
    try {
      const stat = await fs.stat(target);
      if (stat.isFile() && /\.(pdf|png|jpe?g|docx?)$/i.test(target)) result.push(target);
    } catch { /* ignore missing drag paths */ }
  }
  return [...new Set(result)];
}

async function extractPdfText(filePath) {
  const executable = process.platform === "win32" ? "pdftotext.exe" : "pdftotext";
  const candidates = [
    process.env.PDFTOTEXT_PATH,
    path.join(appRoot, "vendor", "poppler", process.platform, process.arch, executable),
    executable,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const result = await execFileAsync(candidate, ["-layout", filePath, "-"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return result.stdout || "";
    } catch { /* try next candidate */ }
  }
  return "";
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function extractDocxText(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry("word/document.xml");
    if (!entry) return "";
    const xml = entry.getData().toString("utf8");
    return decodeXmlEntities(xml
      .replace(/<w:tab[^>]*\/?>(?:<\/w:tab>)?/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}

async function ingestEvidence(inputPaths, options = {}) {
  const account = requireAccount();
  const files = await collectFiles(inputPaths);
  const draftToken = typeof options.draftToken === "string" ? options.draftToken.trim() : "";
  const base = path.join(accountEvidenceRoot(account), "待关联证据");
  await fs.mkdir(base, { recursive: true });
  const added = [];
  for (const sourcePath of files) {
    const buffer = await fs.readFile(sourcePath);
    const extension = path.extname(sourcePath).toLowerCase();
    const evidenceId = id("evidence");
    const storedName = `${evidenceId}_${safeName(path.basename(sourcePath))}`;
    const storedPath = path.join(base, storedName);
    await fs.writeFile(storedPath, buffer);
    const record = {
      id: evidenceId,
      originalName: path.basename(sourcePath),
      sourcePath,
      storedPath,
      extension,
      size: buffer.length,
      sha256: hashBuffer(buffer),
      extractedText: extension === ".pdf"
        ? await extractPdfText(storedPath)
        : extension === ".docx"
          ? await extractDocxText(storedPath)
          : "",
      draft: Boolean(draftToken),
      draftToken,
      createdAt: now(),
    };
    account.evidence.push(record);
    added.push({ ...record, extractedText: undefined });
  }
  return { state: await saveAndState(), added };
}

async function removeStoredEvidenceFile(account, evidence) {
  const storedPath = path.resolve(String(evidence.storedPath || ""));
  const allowedRoots = [accountEvidenceRoot(account), dataPath("evidence", account.id)].map((root) => path.resolve(root));
  if (allowedRoots.some((root) => pathWithin(root, storedPath) && !samePath(root, storedPath))) {
    try { await fs.unlink(storedPath); } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
  }
}

async function removeEvidenceRecords(account, predicate) {
  const removed = (account.evidence || []).filter(predicate);
  if (!removed.length) return 0;
  const removedIds = new Set(removed.map((item) => item.id));
  for (const evidence of removed) await removeStoredEvidenceFile(account, evidence);
  account.evidence = (account.evidence || []).filter((item) => !removedIds.has(item.id));
  for (const list of [account.activities, account.volunteers, account.positions]) {
    for (const item of list || []) item.evidenceIds = (item.evidenceIds || []).filter((evidenceId) => !removedIds.has(evidenceId));
  }
  return removed.length;
}

async function discardDraftEvidence(account, draftToken) {
  const token = String(draftToken || "").trim();
  if (!token) return 0;
  return removeEvidenceRecords(account, (item) => item.draft === true && item.draftToken === token);
}

async function discardAllDraftEvidence(account) {
  return removeEvidenceRecords(account, (item) => item.draft === true || Boolean(item.draftToken));
}

async function commitDraftEvidence(account, evidenceIds = [], draftToken = "") {
  const token = String(draftToken || "").trim();
  if (!token) return;
  const wanted = new Set((evidenceIds || []).filter(Boolean));
  await removeEvidenceRecords(account, (item) => item.draft === true && item.draftToken === token && !wanted.has(item.id));
  for (const evidence of account.evidence || []) {
    if (evidence.draft === true && evidence.draftToken === token && wanted.has(evidence.id)) {
      delete evidence.draft;
      delete evidence.draftToken;
    }
  }
}

async function deleteEvidence(evidenceId) {
  const account = requireAccount();
  const evidence = account.evidence.find((item) => item.id === evidenceId);
  if (!evidence) throw new Error("证据文件不存在");
  await removeStoredEvidenceFile(account, evidence);
  account.evidence = account.evidence.filter((item) => item.id !== evidenceId);
  for (const list of [account.activities, account.volunteers, account.positions]) {
    for (const item of list || []) item.evidenceIds = (item.evidenceIds || []).filter((id) => id !== evidenceId);
  }
  return saveAndState();
}

async function deleteEvidenceBatch(evidenceIds = []) {
  const account = requireAccount();
  const wanted = new Set((evidenceIds || []).filter(Boolean));
  const removed = account.evidence.filter((item) => wanted.has(item.id));
  if (!removed.length) throw new Error("请选择要删除的证据文件");
  for (const evidence of removed) await removeStoredEvidenceFile(account, evidence);
  account.evidence = account.evidence.filter((item) => !wanted.has(item.id));
  for (const list of [account.activities, account.volunteers, account.positions]) {
    for (const item of list || []) item.evidenceIds = (item.evidenceIds || []).filter((id) => !wanted.has(id));
  }
  return saveAndState();
}

async function deleteActivity(activityId) {
  const account = requireAccount();
  const activity = account.activities.find((item) => item.id === activityId);
  if (!activity) throw new Error("操行记录不存在");

  const linkedEvidenceIds = new Set((activity.evidenceIds || []).filter(Boolean));
  const remainingRecords = [
    ...(account.activities || []).filter((item) => item.id !== activityId),
    ...(account.volunteers || []),
    ...(account.positions || []),
  ];
  const stillReferencedEvidenceIds = new Set(remainingRecords.flatMap((item) => item.evidenceIds || []).filter(Boolean));
  const removableEvidenceIds = new Set([...linkedEvidenceIds].filter((evidenceId) => !stillReferencedEvidenceIds.has(evidenceId)));

  await removeEvidenceRecords(account, (item) => removableEvidenceIds.has(item.id));
  account.activities = account.activities.filter((item) => item.id !== activityId);
  await organizeAccountEvidence(account);
  return saveAndState();
}

async function linkEvidence(evidenceId, target) {
  const account = requireAccount();
  if (!account.evidence.some((item) => item.id === evidenceId)) throw new Error("证据文件不存在");
  const [kind, itemId] = String(target || "").split(":");
  const collection = kind === "activity" ? account.activities : kind === "volunteer" ? account.volunteers : kind === "position" ? account.positions : null;
  const item = collection?.find((entry) => entry.id === itemId);
  if (!item) throw new Error("请选择有效的关联项目");
  item.evidenceIds = [...new Set([...(item.evidenceIds || []), evidenceId])];
  await organizeEvidenceFile(account, account.evidence.find((entry) => entry.id === evidenceId));
  return saveAndState();
}

async function linkEvidenceBatch(evidenceIds = [], target) {
  const account = requireAccount();
  const wanted = [...new Set((evidenceIds || []).filter(Boolean))];
  if (!wanted.length) throw new Error("请选择要关联的证据文件");
  if (!wanted.every((evidenceId) => account.evidence.some((item) => item.id === evidenceId))) throw new Error("部分证据文件不存在或已被删除");
  const [kind, itemId] = String(target || "").split(":");
  const collection = kind === "activity" ? account.activities : kind === "volunteer" ? account.volunteers : kind === "position" ? account.positions : null;
  const item = collection?.find((entry) => entry.id === itemId);
  if (!item) throw new Error("请选择有效的关联项目");
  item.evidenceIds = [...new Set([...(item.evidenceIds || []), ...wanted])];
  await organizeAccountEvidence(account);
  return saveAndState();
}

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isOfficialDeepSeekBase(base) {
  return /^https?:\/\/api\.deepseek\.com(?:\/v1)?$/i.test(base);
}

function versionedBaseUrl(value, version = "v1") {
  const base = trimUrl(value);
  if (!base) return "";
  return /\/v\d+(?:beta)?$/i.test(base) ? base : `${base}/${version}`;
}

function providerBaseUrl(ai) {
  const preset = AI_PROVIDER_PRESETS[ai.provider] || AI_PROVIDER_PRESETS.manual;
  const base = trimUrl(ai.baseUrl || preset.baseUrl);
  // DeepSeek's official OpenAI-compatible endpoint is rooted at the host.
  // Keep accepting legacy saved values ending in /v1, but do not rewrite
  // custom proxies because their route contract may intentionally differ.
  if (ai.provider === "deepseek" && isOfficialDeepSeekBase(base)) {
    return base.replace(/\/v1$/i, "");
  }
  if (ai.protocol === "gemini-generate") return versionedBaseUrl(base, "v1beta");
  return versionedBaseUrl(base, "v1");
}

function modelEndpoint(ai, pathname) {
  const base = providerBaseUrl(ai);
  if (ai.protocol === "gemini-generate") return `${base}/models/${encodeURIComponent(ai.model)}:generateContent`;
  return `${base}/${pathname.replace(/^\/+/, "")}`;
}

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`模型请求超时：${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(payload, status) {
  return payload?.error?.message || payload?.error?.status || payload?.message || payload?.promptFeedback?.blockReason || `模型请求失败：HTTP ${status}`;
}

function visionAdapterError(cause, ai, hasImages) {
  const raw = cause?.message || String(cause);
  if (!hasImages || !/(messages\.content\.type|image_url|图片|vision|仅支持.*text|只支持.*文本|content.*type)/i.test(raw)) return raw;
  if (ai.provider === "deepseek") {
    return `当前 DeepSeek 接口没有接受图片输入。请确认模型为 deepseek-v4-flash-vision-exp、协议为 OpenAI Chat Completions，并使用官方 Base URL https://api.deepseek.com；如果填写的是 API Manager 或其他代理，请确认该代理已开启视觉请求转发。原始错误：${raw}`;
  }
  return `当前接口或代理不接受图片输入，请改用支持视觉的模型/协议，或检查代理是否支持图片转发。原始错误：${raw}`;
}

function outputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.choices)) {
    const content = payload.choices[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((item) => item?.text || "").join("\n");
  }
  if (Array.isArray(payload?.content)) return payload.content.map((item) => item?.text || "").join("\n");
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((item) => item?.text || "").join("\n");
  const output = payload?.output;
  if (Array.isArray(output)) return output.flatMap((item) => item?.content || []).map((item) => item?.text || "").join("\n");
  return "";
}

function parseModelJson(value) {
  const text = String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!text) throw new Error("模型没有返回识别结果");
  const ensureObject = (parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型返回的识别结果不是对象");
    return parsed;
  };
  try {
    return ensureObject(JSON.parse(text));
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return ensureObject(JSON.parse(text.slice(start, end + 1))); } catch { /* fall through with a readable adapter error */ }
    }
    throw new Error("模型返回的识别结果不是有效 JSON，请重新识别或手动填写");
  }
}

async function callOpenAIChat(ai, system, userText, image) {
  const content = [{ type: "text", text: userText }];
  const images = Array.isArray(image) ? image : image ? [image] : [];
  images.forEach((item, index) => {
    content.push({ type: "text", text: `\n[附图 ${index + 1}：${item.name || "未命名图片"}]` });
    content.push({ type: "image_url", image_url: { url: item.dataUrl } });
  });
  const { response, payload } = await fetchJson(modelEndpoint(ai, "chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify({ model: ai.model, temperature: AI_REQUEST_DEFAULTS.temperature, max_tokens: AI_REQUEST_DEFAULTS.maxTokens, messages: [{ role: "system", content: system }, { role: "user", content }] }),
  });
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return outputText(payload);
}

async function callOpenAIResponses(ai, system, userText, image) {
  const content = [{ type: "input_text", text: userText }];
  const images = Array.isArray(image) ? image : image ? [image] : [];
  images.forEach((item, index) => {
    content.push({ type: "input_text", text: `\n[附图 ${index + 1}：${item.name || "未命名图片"}]` });
    content.push({ type: "input_image", image_url: item.dataUrl });
  });
  const { response, payload } = await fetchJson(modelEndpoint(ai, "responses"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify({ model: ai.model, temperature: AI_REQUEST_DEFAULTS.temperature, max_output_tokens: AI_REQUEST_DEFAULTS.maxTokens, input: [{ role: "system", content: [{ type: "input_text", text: system }] }, { role: "user", content }] }),
  });
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return outputText(payload);
}

async function callAnthropic(ai, system, userText, image) {
  const content = [{ type: "text", text: userText }];
  const images = Array.isArray(image) ? image : image ? [image] : [];
  images.forEach((item, index) => {
    content.push({ type: "text", text: `\n[附图 ${index + 1}：${item.name || "未命名图片"}]` });
    content.push({ type: "image", source: { type: "base64", media_type: item.mime, data: item.base64 } });
  });
  const { response, payload } = await fetchJson(modelEndpoint(ai, "messages"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ai.model, system, temperature: AI_REQUEST_DEFAULTS.temperature, max_tokens: AI_REQUEST_DEFAULTS.maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return outputText(payload);
}

async function callGemini(ai, system, userText, image) {
  const parts = [{ text: `${system}\n\n${userText}` }];
  const images = Array.isArray(image) ? image : image ? [image] : [];
  images.forEach((item, index) => {
    parts.push({ text: `\n[附图 ${index + 1}：${item.name || "未命名图片"}]` });
    parts.push({ inlineData: { mimeType: item.mime, data: item.base64 } });
  });
  const endpoint = `${modelEndpoint(ai, "")}?key=${encodeURIComponent(ai.apiKey)}`;
  const { response, payload } = await fetchJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: AI_REQUEST_DEFAULTS.temperature, maxOutputTokens: AI_REQUEST_DEFAULTS.maxTokens } }),
  });
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return outputText(payload);
}

async function callModel(ai, system, userText, image) {
  if (ai.protocol === "openai-chat") return callOpenAIChat(ai, system, userText, image);
  if (ai.protocol === "openai-responses") return callOpenAIResponses(ai, system, userText, image);
  if (ai.protocol === "anthropic-messages") return callAnthropic(ai, system, userText, image);
  if (ai.protocol === "gemini-generate") return callGemini(ai, system, userText, image);
  throw new Error(`不支持的模型协议：${ai.protocol}`);
}

async function queryApiManagerStatus(input = {}) {
  const account = requireAccount();
  const ai = normalizeAiSettings({ ...account.settings?.ai, ...input });
  if (ai.provider !== "api-manager") throw new Error("当前接口方式不是 API Manager");
  if (!ai.apiKey) throw new Error("请先填写 API Manager 项目专用 API Key");
  const endpoint = `${providerBaseUrl({ ...ai, protocol: "openai-chat" })}/integration/status`;
  const { response, payload } = await fetchJson(endpoint, { headers: { authorization: `Bearer ${ai.apiKey}` } }, 8_000);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload;
}

function normalizeOnlineModels(payload, provider = "") {
  const candidates = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  return [...new Set(candidates.map((item) => {
    const raw = typeof item === "string" ? item : item?.id || item?.name || item?.model;
    return String(raw || "").replace(/^models\//, "").trim();
  }).filter((model) => model && !(provider === "deepseek" && /^deepseek-(?:chat|reasoner)$/i.test(model))))];
}

function modelListEndpoint(ai) {
  return `${providerBaseUrl(ai)}/models`;
}

function aiSettingsFromHistory(account, historyId, overrides = {}) {
  const history = normalizeAiHistory(account.settings?.ai?.history);
  const entry = history.find((item) => item.id === historyId);
  if (!entry) throw new Error("接口记录不存在");
  const current = normalizeAiSettings(account.settings?.ai);
  const historySecrets = normalizeAiHistorySecrets(account.settings?.ai?.historySecrets);
  const apiKey = historySecrets[historyId] || (aiHistoryIdentity(current) === aiHistoryIdentity(entry) ? current.apiKey : "");
  return normalizeAiSettings({ ...entry, ...overrides, apiKey });
}

async function queryAiModels(input = {}) {
  const account = requireAccount();
  const { historyId = "", ...settings } = input && typeof input === "object" ? input : {};
  const ai = historyId
    ? aiSettingsFromHistory(account, historyId, settings)
    : normalizeAiSettings({ ...account.settings?.ai, ...settings });
  if (!ai.apiKey) throw new Error("请先填写 API Key");
  const startedAt = Date.now();

  if (ai.provider === "api-manager") {
    const status = await queryApiManagerStatus(ai);
    const models = normalizeOnlineModels(status.models, ai.provider);
    if (!models.length) throw new Error("在线模型列表为空或格式不受支持");
    return { provider: ai.provider, source: "online", endpoint: "integration/status", models, latencyMs: Date.now() - startedAt, fetchedAt: now() };
  }

  const endpoint = modelListEndpoint(ai);
  const headers = { accept: "application/json" };
  if (ai.protocol === "gemini-generate") {
    headers["x-goog-api-key"] = ai.apiKey;
  } else if (ai.protocol === "anthropic-messages") {
    headers["x-api-key"] = ai.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${ai.apiKey}`;
  }
  const { response, payload } = await fetchJson(endpoint, { headers }, 8_000);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  const models = normalizeOnlineModels(payload, ai.provider);
  if (!models.length) throw new Error("在线模型列表为空或格式不受支持");
  return { provider: ai.provider, source: "online", endpoint, models, latencyMs: Date.now() - startedAt, fetchedAt: now() };
}

async function activateAiHistoryModel(input = {}) {
  const account = requireAccount();
  const historyId = typeof input.historyId === "string" ? input.historyId : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!historyId || !model) throw new Error("请选择要启用的模型");
  const history = normalizeAiHistory(account.settings?.ai?.history);
  const entry = history.find((item) => item.id === historyId);
  if (!entry) throw new Error("接口记录不存在");
  const current = normalizeAiSettings(account.settings?.ai);
  const historySecrets = normalizeAiHistorySecrets(account.settings?.ai?.historySecrets);
  const apiKey = historySecrets[historyId] || (aiHistoryIdentity(current) === aiHistoryIdentity(entry) ? current.apiKey : "");
  if (!apiKey) throw new Error("该接口没有可用 API Key，请先编辑并保存接口");
  const ai = normalizeAiSettings({ ...entry, model, enabled: current.enabled, apiKey });
  if (!ai.model) throw new Error("该模型不能作为实际使用模型");
  saveAiHistory(account, ai, null, historyId, true);
  return saveAndState();
}

async function testAiConnection(input = {}) {
  const account = requireAccount();
  const { historyId = "", ...settings } = input && typeof input === "object" ? input : {};
  const ai = historyId
    ? aiSettingsFromHistory(account, historyId, settings)
    : normalizeAiSettings({ ...account.settings?.ai, ...settings });
  const startedAt = Date.now();
  let result;
  try {
    if (!ai.apiKey) throw new Error("请先填写 API Key");
    if (!ai.model) throw new Error("请先在模型列表中启用一个模型");
    if (ai.provider === "api-manager") {
      if (!["openai-chat", "openai-responses"].includes(ai.protocol)) throw new Error("API Manager 仅支持 OpenAI Chat Completions 或 Responses 协议");
      const status = await queryApiManagerStatus(ai);
      const selected = Array.isArray(status.models) ? status.models.find((item) => item.id === ai.model) : null;
      if (selected?.available === false) throw new Error(selected.status_message || `模型 ${ai.model} 当前不可用`);
      result = {
        success: true,
        status: "connected",
        modelAvailable: selected?.available ?? null,
        models: Array.isArray(status.models) ? status.models : [],
        message: selected ? `API Manager 已连接，模型 ${ai.model} 可用` : "API Manager 已连接，但当前模型未出现在模型目录中",
      };
    } else {
      const output = await callModel(ai, "你正在进行模型连接测试。", "请只回复 OK。不要输出其他内容。", null);
      if (!String(output || "").trim()) throw new Error("模型已响应，但没有返回可读内容");
      result = { success: true, status: "connected", modelAvailable: true, message: `${ai.provider} 已连接，模型 ${ai.model} 返回正常` };
    }
  } catch (cause) {
    result = { success: false, status: "error", modelAvailable: false, message: cause?.message || String(cause) };
  }
  result.latencyMs = Date.now() - startedAt;
  saveAiHistory(account, ai, result, historyId, false);
  result.state = await saveAndState();
  return result;
}

async function classifyEvidenceBatch(evidenceIds = []) {
  const account = requireAccount();
  const ids = [...new Set((Array.isArray(evidenceIds) ? evidenceIds : [evidenceIds]).map((item) => String(item || "").trim()).filter(Boolean))];
  const evidences = ids.map((evidenceId) => account.evidence.find((item) => item.id === evidenceId)).filter(Boolean);
  if (!evidences.length) throw new Error("请先上传至少一份操行证据文件");
  const ai = normalizeAiSettings(account.settings?.ai);
  if (!ai.enabled) return { status: "disabled", message: "AI 当前未开启，请手动填写。" };
  if (!ai.apiKey || !ai.model) throw new Error("请先在 AI 设置中填写 API Key，并在模型列表中启用一个模型");
  if (ai.provider === "api-manager" && !["openai-chat", "openai-responses"].includes(ai.protocol)) throw new Error("API Manager 仅支持 OpenAI Chat Completions 或 Responses 协议");
  const project = normalizeProject(account.project);
  const academicYearRanges = semesterRangesForAcademicYear(project.academicYear);
  const firstSemester = academicYearRanges?.first || project.semesters.first;
  const secondSemester = academicYearRanges?.second || project.semesters.second;
  const assessmentPeriod = academicYearRanges?.assessment || { start: firstSemester.start, end: secondSemester.end };
  const system = [
    "你是中国药科大学本科生综合素质测评证据整理助手。",
    "当前输入包含同一项活动的多页证据。必须把所有证据作为一个整体阅读和判断，不得逐页当成不同活动，也不得只依据某一页的片段下结论。重复出现的姓名、学号、活动名称、日期、主办单位和盖章信息应合并去重。",
    "常见结构是：第一页或某一页为证明正文，后续页面为参加人员名单、表格或附页。应使用证明正文确定活动名称、活动日期、级别依据和署名单位，把名单页仅作为同一活动证明的补充；不要把名单中的人名、学号、页码或文件名当成活动名称，也不要因为后续页面缺少标题就把它们拆成其他活动。",
    "只根据输入的证据正文、标题、表格文字和图片可见文字判断，不要臆造、补全或使用常识替代证据。无法可靠确定时，相关字段必须保持空字符串，不要填写 unknown、无法识别或其他占位词。",
    "只返回 JSON 对象，不要 Markdown。字段为 activityName、level、date、semester、issuer、score、reason、levelBasis、semesterBasis。",
    "level 只能是 school、college、class 或空字符串；semester 只能是 first、second 或空字符串。",
    "活动级别必须按以下顺序判断，不能倒置：第一步，先在全部证据的正文、标题、表格说明、证明语句和图片可见文字中查找明确的级别表述，包括“校级操行/校级活动/校级”“院级操行/院级活动/院级/学院级”“班级操行/班级活动/班级级”等。只要任一页出现明确表述，就以明确表述为第一依据。",
    "第二步，只有全部证据都没有明确级别表述时，才综合查看落款、盖章、主办单位或署名单位进行兜底推断：学校或中国药科大学校级单位判定 school，学院或学院团委等学院级单位判定 college，班委、班级或本班组织等班级单位判定 class。单独看到“中国药科大学”几个字，不足以替代对完整署名单位的判断。",
    "如果明确文字与署名单位冲突，不要用署名单位覆盖明确文字；保留明确文字结论，并在 reason 中指出冲突，levelBasis 填 explicit_text_conflict。若明确文字和署名都不能可靠支持结论，level 必须为空字符串。",
    "levelBasis 只能是 explicit_text、issuer_fallback、explicit_text_conflict 或空字符串，用于说明级别来源；不得把 issuer_fallback 当作第一判断依据。",
    `本次测评周期为 ${project.academicYear}，总时间范围为 ${assessmentPeriod.start} 至 ${assessmentPeriod.end}。上学期为 ${firstSemester.start} 至 ${firstSemester.end}，下学期为 ${secondSemester.start} 至 ${secondSemester.end}。`,
    "先检查全部证据中明确写出的活动日期是否在上述总时间范围内；如果明确日期早于总范围开始或晚于总范围结束，必须将 level、semester、score 分别输出为空字符串、空字符串、null，并在 reason 中完整填写：活动操行时间与设置学年匹配不一致，请检查操行文件或者在设置-测评周期与学期里面修改学年。此规则优先于明确学期文字。",
    "学期要在全部证据合并后判断：先查找任一页明确写出的“上学期/下学期/上半学期/下半学期/第一学期/第二学期”；没有明确学期时，再使用证据中的具体活动日期与上面的学期范围匹配；不能使用文件创建日期、识别日期或当前日期代替活动日期。",
    "如果日期在总时间范围内但与明确学期文字冲突，保留明确学期文字并在 reason 中说明冲突；如果日期缺失、模糊或无法解析，semester 必须为空字符串。",
    "semesterBasis 只能是 explicit_text、date_range、explicit_text_conflict 或空字符串。",
    "按测评表固定规则计算 score：school 且 semester 明确为 0.3，college 且 semester 明确为 0.2，class 且 semester 明确为 0.1；level 或 semester 为空字符串时 score 必须为 null。",
    "集体获奖、先进个人、学术科研与技能属于表格中的独立类别，通常只能确认项目名称和类别；证据没有明确分数时 score 必须为 null，不要猜测。",
    "活动名称优先从完整证据中的标题、证明正文和明确项目名称提取；例如标题中的“爱国三行诗”就是活动名称，不要把“活动操行分认证”或参加人员名单当成活动名称。来源文件夹名称只能作为辅助线索，不能覆盖证据正文。",
    "reason 必须简要说明综合了哪些证据页、采用了哪一处明确文字或哪一个署名单位，以及学期采用了明确表述还是日期范围；不要编造证据中不存在的原文。",
  ].join("\n");
  const images = [];
  const evidenceDocument = [];
  for (let index = 0; index < evidences.length; index += 1) {
    const evidence = evidences[index];
    const extracted = evidence.extractedText?.trim() || "（该文件没有可直接提取的文字，请结合同序附图判断。）";
    const sourceFolder = evidence.sourcePath ? path.basename(path.dirname(evidence.sourcePath)) : "";
    const folderHint = sourceFolder ? `\n来源文件夹辅助线索（不可替代正文）：${sourceFolder}` : "";
    evidenceDocument.push(`[证据页 ${index + 1}：${evidence.originalName}]${folderHint}\n${extracted.slice(0, 50_000)}`);
    if (/\.(png|jpe?g)$/i.test(evidence.extension)) {
      const buffer = await fs.readFile(evidence.storedPath);
      const mime = evidence.extension === ".png" ? "image/png" : "image/jpeg";
      images.push({ name: evidence.originalName, mime, base64: buffer.toString("base64"), dataUrl: `data:${mime};base64,${buffer.toString("base64")}` });
    }
  }
  const userText = [
    "请把下面的全部证据页和附图视为同一项活动的完整证明，先合并信息，再输出一个 JSON 结果。不要为每一页单独输出结果。",
    "请按系统提示词规定的顺序判断：先查找全部证据中的明确操行级别表述，再在确实没有明确表述时查看署名单位；同时综合识别活动名称、活动日期、学期和署名单位。日期超出所选学年总范围时，按系统规定返回空字段、null 分数和指定提示。无法可靠识别的字段保持空值。",
    "合并后的证据文档：",
    evidenceDocument.join("\n\n"),
  ].join("\n");
  let output;
  try {
    output = await callModel(ai, system, userText, images);
  } catch (cause) {
    throw new Error(visionAdapterError(cause, ai, images.length > 0));
  }
  const parsed = parseModelJson(output);
  const suggestion = buildActivitySuggestion(parsed, project);
  suggestion.evidenceIds = evidences.map((item) => item.id);
  return { status: "suggested", suggestion, evidenceIds: suggestion.evidenceIds };
}

function upsert(list, item, prefix) {
  const next = { ...item, id: item.id || id(prefix), updatedAt: now() };
  const index = list.findIndex((entry) => entry.id === next.id);
  if (index >= 0) list[index] = next;
  else list.push({ ...next, createdAt: now() });
}

function bundledTemplateCandidates(kind) {
  const templatesRoot = path.join(appRoot, "templates");
  if (kind === "individual") {
    return [path.join(templatesRoot, "individual-standard.xlsx")];
  }
  if (kind === "class") {
    return [path.join(templatesRoot, "class-summary-standard.xlsx")];
  }
  if (kind === "class-detail") {
    return [path.join(templatesRoot, "class-detail-standard.xlsx")];
  }
  return [];
}

async function templatePath(kind) {
  for (const candidate of bundledTemplateCandidates(kind)) {
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`找不到${kind === "individual" ? "个人" : "班级"}Excel模板`);
}

function setCellValue(sheet, row, col, value) {
  sheet.getCell(row, col).value = value ?? null;
}

function numericOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function copyRowStyle(sheet, fromRow, toRow, maxCol) {
  for (let col = 1; col <= maxCol; col += 1) {
    const source = sheet.getCell(fromRow, col);
    const target = sheet.getCell(toRow, col);
    target.style = JSON.parse(JSON.stringify(source.style));
    target.numFmt = source.numFmt;
    target.alignment = source.alignment ? { ...source.alignment } : undefined;
    target.border = source.border ? JSON.parse(JSON.stringify(source.border)) : undefined;
    target.fill = source.fill ? JSON.parse(JSON.stringify(source.fill)) : undefined;
    target.font = source.font ? JSON.parse(JSON.stringify(source.font)) : undefined;
  }
  sheet.getRow(toRow).height = sheet.getRow(fromRow).height;
}

async function buildIndividualWorkbook(account, outputPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await templatePath("individual"));
  const sheet = workbook.getWorksheet("1.素质拓展测评统计");
  if (!sheet) throw new Error("个人模板缺少 1.素质拓展测评统计 sheet");
  sheet.getCell("A1").value = `${account.project.academicYear}学年${account.profile.college || "本科生"}素质拓展分汇总`;
  const activityRows = account.activities.filter((item) => item.status !== "rejected");
  const end = Math.max(65, 3 + activityRows.length);
  for (let row = 4; row <= end; row += 1) {
    if (row > 66) copyRowStyle(sheet, 4, row, 7);
    for (let col = 1; col <= 7; col += 1) setCellValue(sheet, row, col, null);
  }
  for (let index = 0; index < activityRows.length; index += 1) {
    const item = activityRows[index];
    const row = index + 4;
    const score = activityScore(item, account.project);
    const semester = item.semester || semesterForDate(item.date, account.project);
    const label = levelLabel(item.level, semester, account.project);
    [account.profile.major, account.profile.classId, account.profile.studentId, account.profile.name, label, item.name, score].forEach((value, colIndex) => setCellValue(sheet, row, colIndex + 1, value));
  }
  const totalRow = Math.max(66, 4 + activityRows.length);
  if (totalRow > 66) copyRowStyle(sheet, 66, totalRow, 7);
  setCellValue(sheet, totalRow, 7, { formula: `SUM(G4:G${Math.max(3, totalRow - 1)})` });
  await workbook.xlsx.writeFile(outputPath);
}

function mdHeader(title, account) {
  return `# ${title}\n\n- 姓名：${account.profile.name}\n- 学号：${account.profile.studentId}\n- 测评周期：${account.project.academicYear}\n- 生成时间：${now()}\n\n`;
}

function findEvidenceOwner(records, evidenceId) {
  const collections = [
    ["activity", records.activities || []],
    ["volunteer", records.volunteers || []],
    ["position", records.positions || []],
  ];
  for (const [kind, items] of collections) {
    const record = items.find((item) => item.evidenceIds?.includes(evidenceId));
    if (record) return { kind, record };
  }
  return null;
}

function activityEvidenceLevel(activity) {
  const special = {
    award: "集体获奖",
    individual: "先进个人",
    academic: "学术科研与技能",
  };
  if (special[activity?.activityType]) return special[activity.activityType];
  return {
    school: "校级活动",
    college: "院级活动",
    class: "班级活动",
  }[activity?.level] || "其他操行";
}

function evidenceGroupName(owner) {
  if (!owner) return "未分类证据";
  if (owner.kind === "activity") return `操行-${owner.record.name || "未命名活动"}-${activityEvidenceLevel(owner.record)}`;
  if (owner.kind === "volunteer") return `额外志愿-${owner.record.name || "未命名项目"}`;
  return `相关任职-${owner.record.name || "未命名任职"}`;
}

function evidenceExtension(evidence) {
  const extension = path.extname(String(evidence?.originalName || evidence?.storedPath || ""));
  if (extension) return extension;
  const fallback = String(evidence?.extension || "").trim();
  return fallback ? (fallback.startsWith(".") ? fallback : `.${fallback}`) : "";
}

function evidenceExportFileName(groupName, sequence, evidence) {
  return `${safeName(`${groupName}-${sequence}`)}${evidenceExtension(evidence)}`;
}

function nextEvidenceSequence(sequences, groupName) {
  const sequence = (sequences.get(groupName) || 0) + 1;
  sequences.set(groupName, sequence);
  return sequence;
}

function legacyEvidenceGroupName(owner) {
  if (!owner) return "未分类证据";
  if (owner.kind === "activity") return `操行_${owner.record.name || "未命名活动"}`;
  if (owner.kind === "volunteer") return `额外志愿_${owner.record.name || "未命名项目"}`;
  return `相关任职_${owner.record.name || "未命名任职"}`;
}

async function listFilesRecursively(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await walk(root);
  return files;
}

async function findPackageEvidenceSource(sourceRoot, owner, evidence, groupName, sequence, files, usedFiles) {
  const newPath = path.join(sourceRoot, safeName(groupName), evidenceExportFileName(groupName, sequence, evidence));
  const legacyPath = path.join(sourceRoot, safeName(legacyEvidenceGroupName(owner)), safeName(evidence.originalName || path.basename(evidence.storedPath || "未命名文件")));
  const candidates = [newPath, legacyPath];
  for (const candidate of candidates) {
    const key = path.resolve(candidate).toLowerCase();
    if (!usedFiles.has(key) && await pathExists(candidate)) return candidate;
  }

  const expectedName = safeName(evidence.originalName || path.basename(evidence.storedPath || "未命名文件")).toLowerCase();
  const legacyGroup = safeName(legacyEvidenceGroupName(owner)).toLowerCase();
  return files.find((file) => {
    const key = path.resolve(file).toLowerCase();
    if (usedFiles.has(key) || path.basename(file).toLowerCase() !== expectedName) return false;
    return path.dirname(file).toLowerCase().endsWith(`${path.sep}${legacyGroup}`) || path.dirname(file).toLowerCase() === sourceRoot.toLowerCase();
  }) || null;
}

async function exportPackageEvidence({ records, evidences, sourceRoot, targetRoot }) {
  const files = await listFilesRecursively(sourceRoot);
  const usedFiles = new Set();
  const sequences = new Map();
  for (const evidence of evidences || []) {
    const owner = findEvidenceOwner(records, evidence.id);
    const groupName = evidenceGroupName(owner);
    const sequence = nextEvidenceSequence(sequences, groupName);
    const source = await findPackageEvidenceSource(sourceRoot, owner, evidence, groupName, sequence, files, usedFiles);
    if (!source) continue;
    const sourceKey = path.resolve(source).toLowerCase();
    usedFiles.add(sourceKey);
    const targetDir = path.join(targetRoot, safeName(groupName));
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(source, path.join(targetDir, evidenceExportFileName(groupName, sequence, evidence)));
  }

  for (const source of files) {
    if (usedFiles.has(path.resolve(source).toLowerCase())) continue;
    const groupName = "未分类证据";
    const sequence = nextEvidenceSequence(sequences, groupName);
    const targetDir = path.join(targetRoot, groupName);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(source, path.join(targetDir, evidenceExportFileName(groupName, sequence, { originalName: path.basename(source) })));
  }
}

async function buildStudentPackage() {
  const account = requireAccount();
  const finalizedEvidence = (account.evidence || []).filter((item) => item.draft !== true && !item.draftToken);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ymliuCaoXingAgent-student-"));
  const evidenceRoot = path.join(root, "evidence");
  await fs.mkdir(evidenceRoot, { recursive: true });
  const xlsxPath = path.join(root, "素质拓展测评统计.xlsx");
  await buildIndividualWorkbook(account, xlsxPath);
  const volunteer = extraVolunteerScore(account.volunteers, account.project);
  await fs.writeFile(path.join(root, "额外志愿服务.md"), `${mdHeader("额外志愿服务统计", account)}| 活动名称 | 日期 | 得分 |\n|---|---|---:|\n${account.volunteers.map((item) => `| ${item.name} | ${item.date || ""} | 0.1 |`).join("\n") || "| 暂无 |  | 0 |"}\n\n最终分数：**${volunteer.finalScore.toFixed(1)}** 分（${volunteer.count} 次，单次 0.1 分，最高 1 分）。\n`, "utf8");
  const position = effectivePositionScore(account.positions, account.project);
  await fs.writeFile(path.join(root, "相关任职统计.md"), `${mdHeader("相关任职统计", account)}| 职位 | 组织 | 任职时间 | 填写分数 |\n|---|---|---|---:|\n${account.positions.map((item) => `| ${item.name} | ${item.organization || ""} | ${item.term || ""} | ${Number(item.score || 0).toFixed(1)} |`).join("\n") || "| 暂无 |  |  | 0 |"}\n\n按办法取最高分、不累计：**${position.finalScore.toFixed(1)}** 分。\n`, "utf8");
  const sequences = new Map();
  for (const evidence of finalizedEvidence) {
    const owner = findEvidenceOwner(account, evidence.id);
    const groupName = evidenceGroupName(owner);
    const sequence = nextEvidenceSequence(sequences, groupName);
    const targetDir = path.join(evidenceRoot, safeName(groupName));
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(evidence.storedPath, path.join(targetDir, evidenceExportFileName(groupName, sequence, evidence)));
  }
  const manifest = {
    schemaVersion: "0.1.0",
    type: "student-evaluation-package",
    generatedAt: now(),
    profile: account.profile,
    project: account.project,
    activities: account.activities,
    volunteers: account.volunteers,
    positions: account.positions,
    evidence: finalizedEvidence.map(({ storedPath, extractedText, draft, draftToken, ...item }) => item),
    summaries: { activities: activitySummary(account.activities, account.project), volunteer, position },
  };
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const outputDir = exportRoot();
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${safeName(account.profile.name || account.name)}-${account.project.academicYear}-学生资料包.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(root);
  zip.writeZip(outputPath);
  return outputPath;
}

function validateZipEntry(name) {
  return !path.posix.normalize(name).startsWith("../") && !name.includes("..\\");
}

async function importPackages(inputPaths) {
  const account = requireAccount();
  const packages = (inputPaths || []).filter((item) => /\.conductpkg$|\.zip$/i.test(item));
  const imported = [];
  const importRoot = accountClassRoot(account);
  await fs.mkdir(importRoot, { recursive: true });
  for (const packagePath of packages) {
    const zip = new AdmZip(packagePath);
    const manifestEntry = zip.getEntry("manifest.json");
    if (!manifestEntry) continue;
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    if (!new Set(["student-evaluation-package", "student-conduct-package"]).has(manifest.type)) continue;
    const packageId = id("package");
    const profile = manifest.profile || {};
    const baseFolderName = safeName([profile.name || "未命名学生", profile.studentId].filter(Boolean).join("_") || "未命名学生资料");
    const existingNames = new Set((account.classImports || []).map((item) => item.storageFolderName).filter(Boolean));
    let folderName = baseFolderName;
    let suffix = 2;
    while (existingNames.has(folderName) || await pathExists(path.join(importRoot, folderName))) folderName = `${baseFolderName}（${suffix++}）`;
    const target = path.join(importRoot, folderName);
    await fs.mkdir(target, { recursive: true });
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !validateZipEntry(entry.entryName)) continue;
      const out = path.join(target, entry.entryName.replace(/[/\\]/g, path.sep));
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, entry.getData());
    }
    imported.push({ packageId, packagePath, manifest, storageFolderName: folderName, extractedRoot: target, importedAt: now() });
  }
  const existingByStudent = new Map((account.classImports || []).map((item) => [item.manifest?.profile?.studentId, item]));
  for (const item of imported) existingByStudent.set(item.manifest?.profile?.studentId || item.packageId, item);
  account.classImports = [...existingByStudent.values()];
  return { state: await saveAndState(), imported: imported.map((item) => item.manifest.profile) };
}

async function deleteClassImports(packageIds = []) {
  const account = requireAccount();
  const wanted = new Set((Array.isArray(packageIds) ? packageIds : [packageIds]).map((item) => String(item || "").trim()).filter(Boolean));
  const selected = (account.classImports || []).filter((item) => wanted.has(item.packageId));
  if (!selected.length) throw new Error("请先选择要删除的学生资料包");
  const selectedIds = new Set(selected.map((item) => item.packageId));
  const remaining = (account.classImports || []).filter((item) => !selectedIds.has(item.packageId));
  const remainingSources = new Set(remaining.map((item) => path.resolve(String(item.packagePath || "")).toLowerCase()).filter(Boolean));
  const classRoot = accountClassRoot(account);
  let deletedArchives = 0;
  for (const item of selected) {
    const extractedRoot = String(item.extractedRoot || "");
    if (extractedRoot && pathWithin(classRoot, extractedRoot) && !samePath(classRoot, extractedRoot)) {
      await fs.rm(extractedRoot, { recursive: true, force: true });
    }
    const packagePath = String(item.packagePath || "");
    if (!packagePath || !/\.(conductpkg|zip)$/i.test(packagePath)) continue;
    if (remainingSources.has(path.resolve(packagePath).toLowerCase())) continue;
    try {
      const stat = await fs.stat(packagePath);
      if (stat.isFile()) {
        await fs.unlink(packagePath);
        deletedArchives += 1;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  account.classImports = remaining;
  await removeDirectoryIfEmpty(classRoot);
  return { state: await saveAndState(), removed: selected.map((item) => item.manifest?.profile || {}), deletedArchives };
}

function getClassRows(account) {
  return (account.classImports || []).map((item) => {
    const manifest = item.manifest;
    const activities = manifest.activities || [];
    const summary = activitySummary(activities, account.project);
    const position = effectivePositionScore(manifest.positions || [], account.project);
    const volunteer = extraVolunteerScore(manifest.volunteers || [], account.project);
    return { manifest, summary, position, volunteer };
  }).sort((left, right) => {
    const leftName = String(left.manifest?.profile?.name || "").trim();
    const rightName = String(right.manifest?.profile?.name || "").trim();
    if (!leftName && rightName) return 1;
    if (leftName && !rightName) return -1;
    return leftName.localeCompare(rightName, "zh-CN", { sensitivity: "base", numeric: true });
  });
}

async function buildClassEvidenceArchive(account, rows, archiveName, classInfo = {}) {
  await prepareClassExportInfo(account, classInfo);
  const classRows = rows || getClassRows(account);
  if (!classRows.length) throw new Error("请先导入至少一个学生资料包");
  const outputDir = exportRoot();
  await fs.mkdir(outputDir, { recursive: true });
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ymliuCaoXingAgent-class-evidence-"));
  try {
    const usedNames = new Set();
    for (const item of classRows) {
      const profile = item.manifest?.profile || {};
      const baseName = safeName([profile.name || "未命名学生", profile.studentId].filter(Boolean).join("_") || item.manifest?.packageId || "未命名学生");
      let folderName = baseName;
      let suffix = 2;
      while (usedNames.has(folderName)) folderName = `${baseName}（${suffix++}）`;
      usedNames.add(folderName);
      const target = path.join(evidenceRoot, folderName);
      await fs.mkdir(target, { recursive: true });
      const extractedRoot = item.extractedRoot
        || (item.storageFolderName ? path.join(accountClassRoot(account), item.storageFolderName) : item.packageId ? dataPath("class-evidence", account.id, item.packageId) : null);
      const source = extractedRoot ? path.join(extractedRoot, "evidence") : null;
      if (source && await pathExists(source)) {
        await exportPackageEvidence({
          records: item.manifest || {},
          evidences: item.manifest?.evidence || [],
          sourceRoot: source,
          targetRoot: target,
        });
      }
    }
    const evidenceZipPath = path.join(outputDir, archiveName || `${classExportPrefix(account)}-学生证明文件汇总.zip`);
    const evidenceZip = new AdmZip();
    evidenceZip.addLocalFolder(evidenceRoot);
    evidenceZip.writeZip(evidenceZipPath);
    return evidenceZipPath;
  } finally {
    await fs.rm(evidenceRoot, { recursive: true, force: true });
  }
}

async function buildClassExports(classInfo = {}) {
  const account = requireAccount();
  await prepareClassExportInfo(account, classInfo);
  const rows = getClassRows(account);
  if (!rows.length) throw new Error("请先导入至少一个学生资料包");
  const outputDir = exportRoot();
  await fs.mkdir(outputDir, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await templatePath("class"));
  const sheet = workbook.getWorksheet("5.部分细分表");
  if (!sheet) throw new Error("班级模板缺少 5.部分细分表 sheet");
  const roster = new Map();
  for (let row = 4; row <= sheet.rowCount; row += 1) {
    const studentId = String(sheet.getCell(row, 3).value || "").trim();
    if (studentId) roster.set(studentId, row);
  }
  let nextBlank = 4;
  for (const item of rows) {
    const profile = item.manifest.profile || {};
    let row = roster.get(String(profile.studentId || ""));
    if (!row) {
      while (sheet.getCell(nextBlank, 3).value) nextBlank += 1;
      row = nextBlank;
      if (row > 4) copyRowStyle(sheet, 4, row, 17);
    }
    [profile.major, profile.classId, profile.studentId, profile.name].forEach((value, index) => setCellValue(sheet, row, index + 1, value));
    const s = item.summary;
    [s.schoolFirst, s.schoolSecond, s.collegeFirst, s.collegeSecond, s.classAverage].forEach((value, index) => setCellValue(sheet, row, index + 5, numericOrZero(value)));
    setCellValue(sheet, row, 10, { formula: `MIN(5,(E${row}+F${row})/2+(G${row}+H${row})/2+I${row})` });
    setCellValue(sheet, row, 11, numericOrZero(item.position.finalScore));
    setCellValue(sheet, row, 12, 0);
    setCellValue(sheet, row, 13, 0);
    setCellValue(sheet, row, 14, { formula: `K${row}+L${row}+M${row}` });
    setCellValue(sheet, row, 15, 0);
    setCellValue(sheet, row, 16, numericOrZero(item.volunteer.finalScore));
    setCellValue(sheet, row, 17, { formula: `O${row}+P${row}` });
  }
  const prefix = classExportPrefix(account);
  const classWorkbookPath = path.join(outputDir, `${prefix}-班级综测汇总工作簿.xlsx`);
  await workbook.xlsx.writeFile(classWorkbookPath);

  const detail = new ExcelJS.Workbook();
  let detailSheet;
  try {
    await detail.xlsx.readFile(await templatePath("class-detail"));
    detailSheet = detail.getWorksheet("班级操行明细汇总") || detail.worksheets[0];
  } catch {
    detailSheet = detail.addWorksheet("班级操行明细汇总");
    detailSheet.columns = [
      { header: "专业", key: "major", width: 18 }, { header: "班级", key: "classId", width: 12 },
      { header: "学号", key: "studentId", width: 15 }, { header: "姓名", key: "name", width: 14 },
      { header: "级别", key: "level", width: 22 }, { header: "活动、任职、科研等名称", key: "title", width: 45 },
      { header: "得分", key: "score", width: 10 }, { header: "备注", key: "remark", width: 16 },
    ];
  }
  if (!detailSheet) throw new Error("班级操行明细模板缺少工作表");
  const hasTitleRow = String(detailSheet.getCell(1, 1).value || "").trim()
    && String(detailSheet.getCell(2, 1).value || "").trim() === "专业";
  const detailStartRow = hasTitleRow ? 3 : 2;
  for (let row = detailStartRow; row <= detailSheet.rowCount; row += 1) {
    for (let col = 1; col <= 8; col += 1) detailSheet.getCell(row, col).value = null;
  }
  let nextDetailRow = detailStartRow;
  const addDetailRow = (values) => {
    if (nextDetailRow > detailSheet.rowCount && nextDetailRow > detailStartRow) {
      copyRowStyle(detailSheet, detailStartRow, nextDetailRow, 8);
    }
    detailSheet.getRow(nextDetailRow).values = values;
    nextDetailRow += 1;
  };
  const detailRemark = (entry) => entry.evidenceIds?.length ? `证据${entry.evidenceIds.length}份` : null;
  for (const item of rows) {
    const p = item.manifest.profile || {};
    for (const activity of item.manifest.activities || []) addDetailRow([
      p.major, p.classId, p.studentId, p.name,
      levelLabel(activity.level, activity.semester, account.project), activity.name,
      activityScore(activity, account.project), detailRemark(activity),
    ]);
    for (const position of item.manifest.positions || []) addDetailRow([
      p.major, p.classId, p.studentId, p.name, "相关任职", position.name,
      position.score, detailRemark(position),
    ]);
    for (const volunteer of item.manifest.volunteers || []) addDetailRow([
      p.major, p.classId, p.studentId, p.name, "额外志愿", volunteer.name,
      0.1, detailRemark(volunteer),
    ]);
  }
  const detailPath = path.join(outputDir, `${prefix}-班级操行明细汇总表.xlsx`);
  await detail.xlsx.writeFile(detailPath);

  const evidenceZipPath = await buildClassEvidenceArchive(account, rows, `${prefix}-班级证据包.zip`, classInfo);
  return { classWorkbookPath, detailPath, evidenceZipPath };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  await mainWindow.loadFile(path.join(appRoot, "src", "index.html"));
}

function registerIpc() {
  ipcMain.handle("app:state", () => stateForRenderer());
  ipcMain.handle("app:update:check", () => checkForUpdates(true));
  ipcMain.handle("app:update:download", () => downloadUpdate());
  ipcMain.handle("app:update:install", () => installUpdate());
  ipcMain.handle("storage:move", (_event, target) => moveDataRoot(target));
  ipcMain.handle("account:list", () => (vault.accounts || []).map(accountFromVault));
  ipcMain.handle("account:create", async (_event, payload) => {
    if (!payload?.accountName || !payload?.password) throw new Error("请输入账户名称和密码");
    const account = blankAccount(payload.accountName, payload.password, payload.profile);
    vault.accounts.push(account);
    assignReadableStorageFolderNames(vault.accounts);
    sessionAccountId = account.id;
    return saveAndState();
  });
  ipcMain.handle("account:login", async (_event, payload) => {
    const account = vault.accounts.find((item) => item.id === payload?.accountId);
    if (!account) throw new Error("账户不存在");
    const actual = passwordDigest(payload.password, account.passwordSalt);
    if (!timingSafeEqual(Buffer.from(actual, "base64"), Buffer.from(account.passwordHash, "base64"))) throw new Error("密码错误");
    sessionAccountId = account.id;
    return stateForRenderer();
  });
  ipcMain.handle("account:delete", async (_event, payload = {}) => {
    const account = vault.accounts.find((item) => item.id === payload.accountId);
    if (!account) throw new Error("账户不存在");
    if (!payload.password) throw new Error("请输入要删除账户的密码");
    const actual = passwordDigest(payload.password, account.passwordSalt);
    if (!timingSafeEqual(Buffer.from(actual, "base64"), Buffer.from(account.passwordHash, "base64"))) throw new Error("密码错误，未删除账户");
    await removeAccountData(account);
    vault.accounts = vault.accounts.filter((item) => item.id !== account.id);
    if (sessionAccountId === account.id) sessionAccountId = null;
    return saveAndState();
  });
  ipcMain.handle("account:logout", () => { sessionAccountId = null; return stateForRenderer(); });
  ipcMain.handle("profile:update", async (_event, profile) => { const account = requireAccount(); account.profile = { ...account.profile, ...profile }; return saveAndState(); });
  ipcMain.handle("project:update", async (_event, project) => {
    const account = requireAccount();
    const academicYear = String(project?.academicYear || "").trim();
    if (!ACADEMIC_YEAR_OPTIONS.includes(academicYear)) throw new Error("测评周期只能选择 2024-2025、2025-2026 或 2026-2027");
    account.project = normalizeProject({ ...project, academicYear });
    return saveAndState();
  });
  ipcMain.handle("activity:save", async (_event, item = {}) => { const account = requireAccount(); const { draftToken = "", ...record } = item || {}; await commitDraftEvidence(account, record.evidenceIds, draftToken); upsert(account.activities, record, "activity"); await organizeAccountEvidence(account); return saveAndState(); });
  ipcMain.handle("activity:delete", (_event, itemId) => deleteActivity(itemId));
  ipcMain.handle("volunteer:save", async (_event, item = {}) => { const account = requireAccount(); const { draftToken = "", ...record } = item || {}; await commitDraftEvidence(account, record.evidenceIds, draftToken); upsert(account.volunteers, record, "volunteer"); await organizeAccountEvidence(account); return saveAndState(); });
  ipcMain.handle("volunteer:delete", async (_event, itemId) => { const account = requireAccount(); account.volunteers = account.volunteers.filter((item) => item.id !== itemId); await organizeAccountEvidence(account); return saveAndState(); });
  ipcMain.handle("position:save", async (_event, item = {}) => { const account = requireAccount(); const { draftToken = "", ...record } = item || {}; await commitDraftEvidence(account, record.evidenceIds, draftToken); upsert(account.positions, record, "position"); await organizeAccountEvidence(account); return saveAndState(); });
  ipcMain.handle("position:delete", async (_event, itemId) => { const account = requireAccount(); account.positions = account.positions.filter((item) => item.id !== itemId); await organizeAccountEvidence(account); return saveAndState(); });
  ipcMain.handle("evidence:ingest", (_event, payload) => Array.isArray(payload) ? ingestEvidence(payload) : ingestEvidence(payload?.paths, payload));
  ipcMain.handle("evidence:discard-draft", async (_event, draftToken) => { const account = requireAccount(); await discardDraftEvidence(account, draftToken); return saveAndState(); });
  ipcMain.handle("evidence:delete", (_event, evidenceId) => deleteEvidence(evidenceId));
  ipcMain.handle("evidence:delete-batch", (_event, evidenceIds) => deleteEvidenceBatch(evidenceIds));
  ipcMain.handle("evidence:link", (_event, payload = {}) => linkEvidence(payload.evidenceId, payload.target));
  ipcMain.handle("evidence:link-batch", (_event, payload = {}) => linkEvidenceBatch(payload.evidenceIds, payload.target));
  ipcMain.handle("evidence:classify-batch", (_event, evidenceIds) => classifyEvidenceBatch(evidenceIds));
  ipcMain.handle("ai:save", async (_event, settings = {}) => {
    const account = requireAccount();
    const { historyId = "", ...input } = settings || {};
    const ai = normalizeAiSettings({ ...account.settings.ai, ...input });
    saveAiHistory(account, ai, null, historyId, true);
    return saveAndState();
  });
  ipcMain.handle("ai:history:delete", async (_event, historyId) => {
    const account = requireAccount();
    const history = normalizeAiHistory(account.settings?.ai?.history).filter((item) => item.id !== historyId);
    const historySecrets = normalizeAiHistorySecrets(account.settings?.ai?.historySecrets);
    delete historySecrets[historyId];
    account.settings.ai = { ...normalizeAiSettings(account.settings.ai), history, historySecrets };
    return saveAndState();
  });
  ipcMain.handle("ai:history:activate", async (_event, historyId) => {
    const account = requireAccount();
    const history = normalizeAiHistory(account.settings?.ai?.history);
    const entry = history.find((item) => item.id === historyId);
    if (!entry) throw new Error("接口记录不存在");
    const current = normalizeAiSettings(account.settings.ai);
    const historySecrets = normalizeAiHistorySecrets(account.settings?.ai?.historySecrets);
    const sameAsCurrent = aiHistoryIdentity(current) === aiHistoryIdentity(entry);
    const apiKey = historySecrets[historyId] || (sameAsCurrent ? current.apiKey : "");
    const ai = normalizeAiSettings({ ...entry, enabled: current.enabled, apiKey });
    account.settings.ai = { ...ai, history, historySecrets };
    return saveAndState();
  });
  ipcMain.handle("ai:status", () => queryApiManagerStatus());
  ipcMain.handle("ai:models", (_event, settings) => queryAiModels(settings));
  ipcMain.handle("ai:history:model:activate", (_event, settings) => activateAiHistoryModel(settings));
  ipcMain.handle("ai:test", (_event, settings) => testAiConnection(settings));
  ipcMain.handle("export:student", () => buildStudentPackage());
  ipcMain.handle("class:import", (_event, paths) => importPackages(paths));
  ipcMain.handle("class:delete", (_event, packageIds) => deleteClassImports(packageIds));
  ipcMain.handle("class:settings:update", async (_event, info) => { const account = requireAccount(); await prepareClassExportInfo(account, info); return saveAndState(); });
  ipcMain.handle("export:class", (_event, info) => buildClassExports(info));
  ipcMain.handle("export:class-evidence", async (_event, info) => ({ evidenceZipPath: await buildClassEvidenceArchive(requireAccount(), undefined, undefined, info) }));
  ipcMain.handle("shell:openPath", (_event, filePath) => shell.openPath(filePath));
  ipcMain.handle("dialog:openFiles", async (_event, options = {}) => {
const result = await dialog.showOpenDialog(mainWindow, { properties: ["openFile", "multiSelections"], filters: options.classPackages ? [{ name: "操行资料包", extensions: ["zip"] }] : [{ name: "证据文件", extensions: ["pdf", "png", "jpg", "jpeg", "doc", "docx"] }] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("dialog:chooseDirectory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择数据储存文件夹", properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? "" : result.filePaths[0] || "";
  });
}

app.whenReady().then(async () => {
  await initializeDataRoot();
  vault = await readVault();
  await migrateReadableDataLayout();
  registerIpc();
  await createWindow();
  await initializeAutoUpdater();
  app.on("activate", async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); });
});

app.on("before-quit", () => { if (updateCheckTimer) clearInterval(updateCheckTimer); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
