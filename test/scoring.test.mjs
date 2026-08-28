import test from "node:test";
import assert from "node:assert/strict";
import {
  ACADEMIC_YEAR_OPTIONS,
  DEFAULT_PROJECT,
  activitySummary,
  buildActivitySuggestion,
  effectivePositionScore,
  extraVolunteerScore,
  issuerLevelHint,
  semesterForDate,
  semesterRangesForAcademicYear,
} from "../src/core/scoring.mjs";

test("测评周期提供三个可选学年", () => {
  assert.deepEqual(ACADEMIC_YEAR_OPTIONS, ["2024-2025", "2025-2026", "2026-2027"]);
});

test("测评周期按学年生成总周期和学期边界", () => {
  assert.deepEqual(semesterRangesForAcademicYear("2024-2025"), {
    assessment: { start: "2024-09-01", end: "2025-08-31" },
    first: { label: "上学期", start: "2024-09-01", end: "2025-01-31" },
    second: { label: "下学期", start: "2025-02-01", end: "2025-08-31" },
  });
  assert.equal(semesterForDate("2025-09-01", { academicYear: "2024-2025" }), "unknown");
});

test("2025-2026 学年上、下学期边界可识别", () => {
  assert.equal(semesterForDate("2025-09-01", DEFAULT_PROJECT), "first");
  assert.equal(semesterForDate("2026-01-31", DEFAULT_PROJECT), "first");
  assert.equal(semesterForDate("2026-02-01", DEFAULT_PROJECT), "second");
  assert.equal(semesterForDate("2026-08-31", DEFAULT_PROJECT), "second");
  assert.equal(semesterForDate("2026-09-01", DEFAULT_PROJECT), "unknown");
});

test("活动统计按校院班级别和学期分栏", () => {
  const summary = activitySummary([
    { level: "school", semester: "first", score: 0.3, status: "accepted" },
    { level: "college", semester: "second", score: 0.2, status: "accepted" },
    { level: "class", semester: "first", score: 0.1, status: "accepted" },
  ], DEFAULT_PROJECT);
  assert.equal(summary.schoolFirst, 0.3);
  assert.equal(summary.collegeSecond, 0.2);
  assert.equal(summary.classAverage, 0.05);
  assert.equal(summary.finalTotal, 0.3);
});

test("相关任职只取最高分、不累计", () => {
  const result = effectivePositionScore([
    { score: 0.8, status: "accepted" },
    { score: 1.2, status: "accepted" },
    { score: 2.0, status: "rejected" },
  ], DEFAULT_PROJECT);
  assert.equal(result.finalScore, 1.2);
});

test("额外志愿服务一次 0.1 分且上限 1 分", () => {
  const records = Array.from({ length: 12 }, (_, index) => ({ id: String(index), status: "accepted" }));
  assert.equal(extraVolunteerScore(records, DEFAULT_PROJECT).finalScore, 1);
});

test("盖章署名可给出保守的院校级提示", () => {
  assert.equal(issuerLevelHint("共青团中国药科大学中药学院委员会"), "college");
  assert.equal(issuerLevelHint("中国药科大学本科招生办公室"), "school");
  assert.equal(issuerLevelHint("未找到明确署名"), "unknown");
});

test("AI 操行建议按测评表自动带出固定分值", () => {
  const college = buildActivitySuggestion({ activityName: "学院活动", level: "院级活动", semester: "上学期" }, DEFAULT_PROJECT);
  const school = buildActivitySuggestion({ activityName: "学校活动", level: "school", date: "2026-03-10" }, DEFAULT_PROJECT);
  const uncertain = buildActivitySuggestion({ activityName: "待确认活动", level: "unknown", date: "2026-02-01" }, DEFAULT_PROJECT);
  assert.equal(college.level, "college");
  assert.equal(college.semester, "first");
  assert.equal(college.score, 0.2);
  assert.equal(school.level, "school");
  assert.equal(school.semester, "second");
  assert.equal(school.score, 0.3);
  assert.equal(uncertain.score, null);
  assert.equal(uncertain.status, "needs-review");
});

test("AI 结果兼容中文活动名称字段", () => {
  const suggestion = buildActivitySuggestion({ "活动名称": "爱国三行诗", "操行类型": "校级操行", "学期": "上学期" }, DEFAULT_PROJECT);
  assert.equal(suggestion.activityName, "爱国三行诗");
  assert.equal(suggestion.level, "school");
  assert.equal(suggestion.score, 0.3);
});

test("活动日期超出所选学年时保持待确认并给出不匹配提示", () => {
  const suggestion = buildActivitySuggestion({ activityName: "校级活动", level: "校级操行", date: "2024年8月31日" }, DEFAULT_PROJECT);
  assert.equal(suggestion.activityName, "校级活动");
  assert.equal(suggestion.level, "school");
  assert.equal(suggestion.semester, "");
  assert.equal(suggestion.score, null);
  assert.equal(suggestion.periodMismatch, true);
  assert.equal(suggestion.reason, "活动操行时间与设置学年匹配不一致，请检查操行文件或者在设置-测评周期与学期里面修改学年");
});

test("无法可靠识别时建议字段保持空值", () => {
  const suggestion = buildActivitySuggestion({ activityName: "unknown", level: "unknown", semester: "unknown", date: "unknown" }, DEFAULT_PROJECT);
  assert.equal(suggestion.activityName, "");
  assert.equal(suggestion.level, "");
  assert.equal(suggestion.semester, "");
  assert.equal(suggestion.date, "");
  assert.equal(suggestion.issuer, "");
  assert.equal(suggestion.score, null);
  assert.equal(suggestion.status, "needs-review");
});
