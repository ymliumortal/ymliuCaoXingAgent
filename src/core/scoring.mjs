export const DEFAULT_PROJECT = {
  academicYear: "2025-2026",
  semesters: {
    first: { label: "上学期", start: "2025-09-01", end: "2026-01-31" },
    second: { label: "下学期", start: "2026-02-01", end: "2026-08-31" },
  },
  scores: { school: 0.3, college: 0.2, class: 0.1 },
  limits: { activities: 5, positions: 2, extraVolunteer: 1 },
};

export const ACADEMIC_YEAR_OPTIONS = Object.freeze(["2024-2025", "2025-2026", "2026-2027"]);

export function semesterRangesForAcademicYear(academicYear = DEFAULT_PROJECT.academicYear) {
  const match = /^(20\d{2})-(20\d{2})$/.exec(String(academicYear || "").trim());
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  return {
    assessment: { start: `${startYear}-09-01`, end: `${endYear}-08-31` },
    first: { label: "上学期", start: `${startYear}-09-01`, end: `${endYear}-01-31` },
    second: { label: "下学期", start: `${endYear}-02-01`, end: `${endYear}-08-31` },
  };
}

export const LEVEL_LABELS = {
  school: "校级活动",
  college: "院级活动",
  class: "班级活动",
  unknown: "无法识别",
};

export function normalizeProject(project = {}) {
  return {
    ...DEFAULT_PROJECT,
    ...project,
    semesters: {
      ...DEFAULT_PROJECT.semesters,
      ...(project.semesters || {}),
    },
    scores: { ...DEFAULT_PROJECT.scores, ...(project.scores || {}) },
    limits: { ...DEFAULT_PROJECT.limits, ...(project.limits || {}) },
  };
}

export function semesterForDate(value, project = DEFAULT_PROJECT) {
  if (!value) return "unknown";
  const date = normalizeDateForComparison(value);
  if (!date) return "unknown";
  const config = normalizeProject(project);
  const ranges = semesterRangesForAcademicYear(config.academicYear);
  const semesters = ranges || config.semesters;
  for (const key of ["first", "second"]) {
    const semester = semesters[key];
    if (date >= semester.start && date <= semester.end) return key;
  }
  return "unknown";
}

export function scoreForLevel(level, project = DEFAULT_PROJECT) {
  const config = normalizeProject(project);
  return Number.isFinite(config.scores[level]) ? config.scores[level] : null;
}

export function levelLabel(level, semester, project = DEFAULT_PROJECT) {
  const config = normalizeProject(project);
  const suffix = config.semesters[semester]?.label || "未归类";
  return `${LEVEL_LABELS[level] || LEVEL_LABELS.unknown}(${suffix})`;
}

export function activityScore(activity, project = DEFAULT_PROJECT) {
  if (activity.scoreMode === "manual" && Number.isFinite(Number(activity.score))) {
    return Number(activity.score);
  }
  return scoreForLevel(activity.level, project);
}

export function activitySummary(activities = [], project = DEFAULT_PROJECT) {
  const config = normalizeProject(project);
  const valid = activities.filter((item) => item.status !== "rejected");
  const groups = {
    schoolFirst: 0,
    schoolSecond: 0,
    collegeFirst: 0,
    collegeSecond: 0,
    classFirst: 0,
    classSecond: 0,
  };
  for (const item of valid) {
    const score = activityScore(item, config);
    if (!Number.isFinite(score)) continue;
    const semester = item.semester || semesterForDate(item.date, config);
    if (semester === "unknown") continue;
    const group = `${item.level}${semester[0].toUpperCase()}${semester.slice(1)}`;
    if (group === "schoolFirst") groups.schoolFirst += score;
    if (group === "schoolSecond") groups.schoolSecond += score;
    if (group === "collegeFirst") groups.collegeFirst += score;
    if (group === "collegeSecond") groups.collegeSecond += score;
    if (group === "classFirst") groups.classFirst += score;
    if (group === "classSecond") groups.classSecond += score;
  }
  const classAverage = (groups.classFirst + groups.classSecond) / 2;
  const rawTotal =
    (groups.schoolFirst + groups.schoolSecond) / 2 +
    (groups.collegeFirst + groups.collegeSecond) / 2 +
    classAverage;
  return {
    ...groups,
    classAverage,
    rawTotal,
    finalTotal: Math.min(config.limits.activities, rawTotal),
    overLimit: rawTotal > config.limits.activities,
  };
}

export function extraVolunteerScore(records = [], project = DEFAULT_PROJECT) {
  const count = records.filter((item) => item.status !== "rejected").length;
  return {
    count,
    rawScore: count * 0.1,
    finalScore: Math.min(normalizeProject(project).limits.extraVolunteer, count * 0.1),
    overLimit: count * 0.1 > normalizeProject(project).limits.extraVolunteer,
  };
}

export function effectivePositionScore(positions = [], project = DEFAULT_PROJECT) {
  const values = positions
    .filter((item) => item.status !== "rejected")
    .map((item) => Number(item.score))
    .filter(Number.isFinite);
  const max = values.length ? Math.max(...values) : 0;
  return {
    rawValues: values,
    finalScore: Math.min(normalizeProject(project).limits.positions, max),
    overLimit: max > normalizeProject(project).limits.positions,
  };
}

export function issuerLevelHint(text = "") {
  const value = String(text);
  if (/(校级|学校|中国药科大学本科招生办公室|共青团中国药科大学委员会)/.test(value)) return "school";
  if (/(院级|学院|共青团中国药科大学中药学院委员会|基础医学与临床药学团委)/.test(value)) return "college";
  if (/(班级|班委|本班)/.test(value)) return "class";
  return "unknown";
}

function normalizeActivityLevel(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || /^(unknown|无法识别|不确定|未知)$/.test(text)) return "";
  if (text.includes("school") || text.includes("university") || text.includes("校级") || text.includes("学校")) return "school";
  if (text.includes("college") || text.includes("院级") || text.includes("学院")) return "college";
  if (text.includes("class") || text.includes("班级") || text.includes("班委") || text.includes("本班")) return "class";
  return "";
}

function normalizeActivitySemester(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || /^(unknown|无法识别|不确定|未知)$/.test(text)) return "";
  if (text.includes("first") || text.includes("上学期") || text.includes("上半学期") || text.includes("第一学期")) return "first";
  if (text.includes("second") || text.includes("下学期") || text.includes("下半学期") || text.includes("第二学期")) return "second";
  return "";
}

function normalizeDateForComparison(value) {
  const text = String(value || "").trim().replace(/\s+/g, "");
  const match = text.match(/(20\d{2})[年./-](\d{1,2})(?:[月./-](\d{1,2})[日号]?)?/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : 1;
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanSuggestionValue(value) {
  const text = String(value || "").trim();
  return /^(unknown|无法识别|不确定|未知|null|none)$/i.test(text) ? "" : text;
}

export function buildActivitySuggestion(input = {}, project = DEFAULT_PROJECT) {
  const config = normalizeProject(project);
  const levelValue = input.level ?? input.activityLevel ?? input["活动级别"] ?? input["操行类型"];
  const semesterValue = input.semester ?? input.activitySemester ?? input["学期"];
  const date = cleanSuggestionValue(input.date ?? input.activityDate ?? input["活动日期"]);
  const normalizedDate = normalizeDateForComparison(date);
  const ranges = semesterRangesForAcademicYear(config.academicYear);
  const dateOutOfRange = Boolean(normalizedDate && ranges && (normalizedDate < ranges.assessment.start || normalizedDate > ranges.assessment.end));
  const level = normalizeActivityLevel(levelValue) || normalizeActivityLevel(issuerLevelHint(`${input.text || ""} ${input.issuer || input["署名单位"] || ""}`));
  const semester = dateOutOfRange ? "" : normalizeActivitySemester(semesterValue) || (normalizedDate ? normalizeActivitySemester(semesterForDate(date, config)) : "");
  const score = level && semester ? scoreForLevel(level, config) : null;
  const activityName = [
    input.activityName,
    input.activity_name,
    input.activityTitle,
    input.title,
    input.name,
    input["活动名称"],
    input["项目名称"],
  ].map(cleanSuggestionValue).find(Boolean) || "";
  const reasonText = cleanSuggestionValue(input.reason);
  const usableReason = /unknown|无法识别|不确定|未知/i.test(reasonText) ? "" : reasonText;
  const periodMismatchMessage = "活动操行时间与设置学年匹配不一致，请检查操行文件或者在设置-测评周期与学期里面修改学年";
  return {
    activityName: cleanSuggestionValue(activityName),
    level,
    semester,
    date,
    issuer: cleanSuggestionValue(input.issuer || input["署名单位"]),
    score,
    periodMismatch: dateOutOfRange,
    status: dateOutOfRange || !level || !semester ? "needs-review" : "suggested",
    reason: dateOutOfRange ? periodMismatchMessage : usableReason || (score === null ? "未能可靠识别操行级别或学期，请人工选择并填写。" : `已按测评表规则预填得分：${score.toFixed(1)} 分，请核对后保存。`),
  };
}
