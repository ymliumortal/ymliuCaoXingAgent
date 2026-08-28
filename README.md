# ymliuCaoXingAgent 0.1.0

这是中国药科大学本科生综合素质测评操行统计助手的首个可运行骨架。

## 首期确认配置

- 测评周期：2025-2026 学年
- 学期范围：可在“项目设置”中修改
- 班长端核心输出：班级操行明细汇总表、班级综测汇总工作簿
- 相关任职：严格只取最高分，不累计
- AI：默认关闭；开启后允许发送必要证据文本或图片到配置的外部模型，但结果必须人工确认

## 启动

```powershell
npm ci
npm start
```

构建 Windows 安装包后，安装向导会分别询问软件安装位置、本地数据储存位置和是否创建桌面快捷方式。账户库、密码库、证据、班级资料包、导出结果以及 Electron 用户目录都会使用这里选择的数据根目录，不再把业务数据强制写入系统盘默认应用目录。开发或迁移到新电脑时先执行 `npm ci`，再按构建命令生成安装包。

安装后可在“项目设置 → 本地数据储存位置”重新选择数据文件夹。迁移会复制账户库、证据文件和班级资料包，并同步更新内部文件引用；原位置不会自动删除。

## 在线更新（GitHub Releases）

软件已接入 GitHub Releases 更新流程：

- 仅正式安装包检查更新，开发模式不会联网检查。
- 启动后约 10 秒自动检查一次，之后每 6 小时检查一次；“项目设置 → 在线更新”可手动检查。
- 发现新版本时先询问是否下载；下载完成后再次询问是否重启安装，不会强制更新。
- 未配置 GitHub 仓库时功能保持停用，不影响本地使用。

当前项目已配置使用 GitHub 仓库 `ymliumortal/ymliuCaoXingAgent`，更新源配置位于 `electron/update-config.json`。构建时 electron-builder 会把 `app-update.yml` 自动放进安装包的 `resources` 目录，所以用户只下载并运行一个安装程序也能获得更新源配置：

```json
{
  "provider": "github",
  "owner": "ymliumortal",
  "repo": "ymliuCaoXingAgent",
  "releaseType": "release"
}
```

`latest.yml`（Windows）和 `latest-mac.yml`（macOS）是 GitHub Release 服务器端的更新索引，不是首次下载时让用户手动寻找的文件。发布流程会根据最终包的 SHA-512 自动生成并上传它们；不能删除这些索引，否则 `electron-updater` 无法判断远端版本。`.blockmap` 仅用于差分下载，不影响首次完整下载，当前流程不强制发布它。

发布更新时需要把 `package.json` 的 `version` 改为新版本，然后创建并推送带 `v` 前缀的标签：

```powershell
git add package.json package-lock.json
git commit -m "Prepare release v0.1.1"
git tag v0.1.1
git push origin main --follow-tags
```

GitHub Actions 会自动在 Windows 环境安装依赖、运行测试、构建并发布安装程序。工作流文件为 `.github/workflows/release.yml`。也可以在本机设置 `GH_TOKEN` 后执行：

```powershell
npm run build:installer -- --publish never
node build/generate-update-metadata.mjs release-installer
```

每个正式 Release 必须包含同一次构建生成的安装程序和对应的更新索引；工作流会自动上传这些更新资源。Release 不能保持 Draft 状态。建议正式公开发布前配置 Windows 代码签名证书；当前项目未配置签名证书，更新器仍会校验发布元数据中的文件摘要，但无法提供发布者签名校验。

## 当前目录结构

- `electron/`：Electron 主进程与本地 IPC
- `src/`：界面和统计规则
- `templates/`：随项目发布的个人、班级 Excel 模板
- `build/`：Windows 安装器的自定义安装页面脚本和更新索引生成脚本
- `test/`：规则与接口配置测试
- `package.json`、`package-lock.json`：需要继续开发或重新构建时使用

`release/`、`release-installer/` 和 `release-mac/` 仅为本机构建产物，不属于源代码；需要运行或发布时先执行 `npm ci`，再按目标平台执行构建命令。Windows 安装包和 macOS 安装包的新文件名统一为 `ymliuCaoXingAgent`。

当前版本已包含：本地账户、活动/志愿/任职录入、PDF/Word/图片证据文件选择与拖入、AI 设置、学生资料包导出、班长资料包导入、班级两类 Excel 输出基础能力。证据入口只接受文件，不再提供文件夹上传。

## AI 接口

AI 默认关闭。上方只配置 AI 开关、平台、协议、Base URL 和 API Key。模型列表位于下方“已保存的接口列表”内，展示平台预设和在线同步结果，每个模型都可以单独点击“启用”来确定实际使用模型。

设置页会在本机保留最多 12 条接口填写记录，只保存平台、协议、Base URL、模型和检测结果，不保存可见 API Key。点击“测试连接”后，程序发送不包含证据的最小测试请求，并记录连接状态和延迟。在线模型列表请求失败时只显示真实错误，不会伪造候选模型。内置平台包括 OpenAI、Claude、Grok、Gemini、DeepSeek、GLM、Kimi 和 OrcaRouter；OrcaRouter 默认使用 `https://api.orcarouter.ai/v1`，可同步其账户可用模型，也可选择 `orcarouter/auto` 自动路由。

支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini generateContent 四类协议。API Key 只保存在本机账户存储中；只有在用户开启 AI 并执行识别时，必要的证据文本或图片才会发送到所选接口，识别结果仍须人工确认。

Excel 模板已经随项目放在 `templates/` 中，项目不依赖外部参考目录，可以直接复制或从 GitHub 克隆到其他位置后重新安装依赖和构建。
