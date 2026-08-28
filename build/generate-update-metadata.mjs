import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outputDir = path.resolve(process.cwd(), process.argv[2] || "release-installer");
const isMac = process.argv.includes("--mac");
const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
const expectedNames = isMac ? ["ymliuCaoXingAgent.zip", "ymliuCaoXingAgent.dmg"] : ["ymliuCaoXingAgent.exe"];
const metadataName = isMac ? "latest-mac.yml" : "latest.yml";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (filePath) => crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
const stat = (filePath) => fs.statSync(filePath).size;

for (const name of expectedNames) {
  if (!fs.existsSync(path.join(outputDir, name))) throw new Error(`未找到发布文件：${path.join(outputDir, name)}`);
}

const primary = expectedNames[0];
const lines = [
  `version: ${quote(packageJson.version)}`,
  "files:",
  ...expectedNames.flatMap((name) => [
    `  - url: ${quote(name)}`,
    `    sha512: ${quote(digest(path.join(outputDir, name)))}`,
    `    size: ${stat(path.join(outputDir, name))}`,
  ]),
  `path: ${quote(primary)}`,
  `sha512: ${quote(digest(path.join(outputDir, primary)))}`,
  `releaseDate: ${quote(new Date().toISOString())}`,
  "",
];
const metadataPath = path.join(outputDir, metadataName);
fs.writeFileSync(metadataPath, lines.join("\n"), "utf8");
console.log(`已生成 ${metadataPath}`);
