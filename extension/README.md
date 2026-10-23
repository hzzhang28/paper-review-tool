# Paper Review Tool 0.3.9r3

在 VS Code 中管理单个 LaTeX 文件的人工草稿、Master 和 AI 修改，持续保留审计高亮与 Issue。本版可通过本地 VSIX 分享安装，尚未发布到扩展市场。

## 安装前准备

- 桌面版 VS Code 1.103.2 或以上，只支持本机已信任工作区。网页内联功能另需带 Integrated Browser 的新版 VS Code。
- **无需另外安装 Node.js。** 后台服务使用 VS Code 自带 Node，在独立 Worker 线程中处理 HTTP、SQLite 和合并；由扩展按需启动和关闭。安装包包含服务和 jsdiff。运行时缺少 SQLite 能力时提示升级桌面 VS Code，不会自动调用外部 node。
- **自行安装支持编辑器内联显示的 PDF 阅读扩展**，并将它设为 PDF 默认打开方式。本工具不附带 PDF 渲染器；没有阅读器时仍可编辑正文。
- 需要编译时安装本机 LaTeX 工具链。Windows 可使用 MiKTeX；其他平台请自行安装并配置命令。不编译模式不需要 LaTeX 工具链。
- 需要 Agent 面板时自行安装对应扩展，例如 Codex、Claude Code，并在对应扩展中完成登录。Git 仅用于可选的阶段版本保存。

在 VS Code 扩展视图的 … → Install from VSIX… 选择 paper-review-tool-0.3.9r3.vsix，按提示重新加载窗口。升级后可在本 README 确认构建编号。本版的 VS Code 数字版本仍为 0.3.9，构建编号为 0.3.9r3；如提示同版本，请覆盖安装并重新加载窗口。

## 打开论文

1. 点击左侧 Paper → 初始化 / 打开项目，选择一个 .tex 文件。它所在的文件夹就是项目根目录。
2. 首次初始化选择“全部已审核”或“全部待审核”。后者以黄色标记现有正文，按段落或结构逐项审阅。
3. 已初始化的项目直接加载原有草稿、审计、Issue 和历史；不会重新初始化。侧栏文件夹按钮也可切换项目。

打开项目后才启动服务。人工编辑使用 paper:// 虚拟文件，真实 .tex 是受控 Master；不要在其他编辑器直接覆盖 Master。根目录已有同名 PDF 时，交给已安装的默认阅读器在右侧打开。

## 保存与同步

| 操作 | 行为 |
| --- | --- |
| Ctrl+S | 只保存 Human Draft，不提交 Master |
| Push | 提交正文与暂存的审计、Issue；不替换人类正文 |
| Update Only | 确认后放弃本地修改，载入最新 Master |
| Merge Update | 保存、合并、Push，并更新人类正文 |
| Push + 编译 | 先 Push，再执行选定方案；选择“不编译”时只 Push |

出现冲突时，左下角显示可点击的 Conflicts（数量）；Issues 标题栏也有打开按钮。点击后用原生 Merge Editor 查看 Base、Current、Incoming 与 Result，需要本机 code 命令可用。

从打开冲突处理页面开始冻结 Master。后来收到的正文版本提交先保存到 Pending，按到达顺序等待，不参与当前合并。左下角同时显示 Pending 数量；人工 Push、Merge Update 和历史恢复若在此期间收到，也作为版本提交排队。

保存合并结果后，点击左下角或结果页标题栏的“提交解决结果并更新正文”。一次完成提交 Master、同步 Human Draft、关闭本次合并标签并清除侧栏中的已解决冲突项，无需再点击 Push、Update 或 Merge。原始冲突快照和历史继续保留。

当前操作结束后才继续处理 Pending；再次冲突时暂停等待下一轮。后续成功版本仍通过 New Updates 提示，不会自动替换刚选定的正文。仅关闭合并标签不解除冻结，重新点击 Conflicts 可继续；服务重启会恢复当前冲突、已保存的结果和已接收的 Pending 快照。服务停机时未送达的外部输入由调用方恢复后重新提交，本工具不加入补偿或重试编排。

AI Push 后使用 VS Code 原生弹窗通知：提交成功显示信息提示，合并冲突显示警告提示。状态栏显示 Master rX | Unsaved | Unpushed | Updated / New Updates。前两项按需出现，New Updates 表示有尚未同步的 Master 更新；AI 不会自动替换正在编辑的正文。

关闭或切换项目由 VS Code 处理未保存内容的保存／不保存／取消。已保存草稿长期保留；窗口退出时的未保存恢复遵循 VS Code Hot Exit 设置。

## 审计、Issue 与章节

- 黄色为待审核，红色为 Needs Fix，Approve 后不再高亮；正文右键可批准、标黄、标红或 Reject。普通白色正文也可直接标黄或标红：选中文字，或将光标放在词内。操作先暂存在 Draft，Push 后提交。
- 审计遵循当前状态加本次修改：每次 AI 改动都重新待审，即使改回历史原词。人工再次修改黄色或红色文字也保留标记，直到显式批准或删除对应文字。旧批准不能清除较新的修改。
- History 独立保留 AI Change Event，当前颜色不通过历史原文推断；Reject 撤回最近一次对应修改，手动标记没有 AI 改动可撤回。升级不回溯改写既有批准记录。
- Paper 章节树按标题定位，支持将 \\appendix 显示为 Appendix 节，其后 \\subsection 为子项。Issues 栏用于长期笔记；默认绑定源码行，也可绑定普通段落或创建 General Issue。
- 左键点击 Anchored Issue 定位原文，右键 Edit Issue 打开 Markdown 编辑页，支持多行和反复编辑。Ctrl+S 保存笔记，Push 提交；支持删除、关闭、重开和重新绑定。
- 未保存输入会投影审计位置；局部改词不会自动批准整个新增段落。不能可靠定位时临时隐藏高亮，持久审计数据仍保留。

## Agent 与 Web

设置中的 **Default Agent** 选择 Codex、Claude Code 或其他；**Default Web** 选择 GPT、Claude 或其他。选“其他”时预填当前目标并打开自定义配置；已保存的自定义配置不会被覆盖。可在自定义 Agent 设置中检测已安装的类似扩展，也可填写命令 ID、名称和参数。

底部按钮直接打开默认目标，不再弹出选择菜单。名称随设置更新：Codex / Claude Code、ChatGPT Web / Claude Web；自定义目标使用填写的名称。目标仍尽量在 PDF 所在的右侧组打开，只有侧栏入口的扩展保留其自身布局。网页各自复用标签，不发送消息。

**Agent Instruction** 位于 Agent 旁，复制含当前服务端口的 HTTP Pull / Push 指令。设置中的同名多行文本默认保留现有请求说明，可以编辑前后文；{{port}} 每次复制时自动替换。Agent 不需要发现连接文件、配置 CLI 或处理版本；两个本地接口不要求认证，不规定使用哪种 Shell 或 HTTP 客户端。

设置 **修复chatgpt web latex编译失败报错**（paperReview.fixChatGPTWebLatex）默认开启：

- 仅选择 ChatGPT 时，通过 Debug 连接注入已有 LaTeX 源码模式脚本。
- 关闭时，同样打开右侧内联网页，不建立 Debug 连接。
- Claude 和其他网址始终为普通模式，不注入脚本。
- 关闭已有注入会话时会重开该标签以移除脚本，页面可能回到入口地址。请先保留尚未发送的输入。
- 登录与页面兼容性由网站和 VS Code 决定。当前机制仍依赖内置浏览器调试接口；仅在替代 API 正式稳定后考虑迁移。

## 编译方案

打开 **Paper: 编译设置**，有两层原生下拉选项：

- **Paper Compile**：默认 Windows / 默认 macOS / 其他。首次激活按本机平台自动选择；保留用户显式设置。选“其他”会预填当前完整方案列表并跳转配置。
- **Compile Profile**：pdf / pdf+bib / xe / xe+bib / 其他 / 不编译。选“其他”会预填当前引擎的名称和命令步骤并跳转配置；不编译仍表示只 Push。

| 引擎 | 步骤 |
| --- | --- |
| pdf | 一遍 pdfLaTeX |
| pdf+bib | pdfLaTeX → BibTeX → pdfLaTeX → pdfLaTeX |
| xe | 一遍 XeLaTeX |
| xe+bib | XeLaTeX → BibTeX → XeLaTeX → XeLaTeX |

默认 Windows 与 macOS 都使用标准命令名 pdflatex、xelatex、bibtex，默认引擎为 pdf+bib，不绑定某个 TeX 发行版。Mac 方案和平台识别经过模拟检查，未在 Mac 实机编译；用户安装的工具必须能被 VS Code 的环境找到，否则在“其他”配置中指定命令位置。

平台“其他”的全部方案位于 paperReview.customCompileProfiles；引擎“其他”的单个方案位于 paperReview.customCompile。命令仍以 command / args 分开传递，不经 shell；支持 ${file}、${stem}、${root}，BibTeX 可按 ifBibliography 跳过。修改设置不会保存、Push 或启动编译。

默认命令使用 nonstopmode 继续处理普通错误。若产生本轮完整 PDF，则显示并保留错误提示；严重错误、超时或取消会停止。工作目录固定为真实 Master 所在目录，输出留在该目录，不复制依赖，不备份或回滚编译产物。

**编译日志** 是独立开关，打开／隐藏原生 Paper Build 输出。**打开 PDF** 仅查看已有文件；**重新加载现有 PDF** 不触发编译，可能重置查看器页码或缩放。

## 按钮位置

- 正文标题栏：Push、Merge Update、编译／停止；其余进入 …，按文档、编译、Agent、项目分组。
- 章节栏：打开项目、刷新；其余项目操作进入 …。
- Issues 栏：新增与刷新；定位、编辑和删除在 Issue 自身操作中。
- 底部：状态、编译及日志、PDF、当前 Agent 名称、Agent Instruction、当前 Web 名称。

## 数据与使用边界

.paper-manager 保存草稿、数据库、审计、历史和冲突快照；请在论文的 .gitignore 中排除它。只有一个 .tex 进入本工具管理，图片、文献、实验代码等继续使用普通文件和 Git。

Paper: Save Master Version to Git 只提交明确选择的文件，不执行 git add .。本版没有多人实时协同、完整多文件管理、内置 PDF 阅读器或自动解决冲突。

本版的检查包括 HTTP 交接、配置与 VS Code API 模型，不等于真实窗口、不同 Agent 版本或 macOS/Linux 工具链已验收。建议先用论文副本试用。本轮另外通过真实隔离 VS Code 宿主检查：Worker 清空 PATH 后，使用宿主 Node 和 SQLite 完成 HTTP 交接、退出和重启。Worker 与宿主共享进程；它是后台线程隔离。macOS/Linux 和旧版 VS Code 尚未逐一实测。

## 源码与开发

npm run package:vsix 生成本地安装包；npm run check 仅做 JavaScript 语法检查。有限检查和手工验收边界记录在 源码中的 docs/verification-report.md。

接口说明见 源码中的 docs/agent-http.md，其他管理接口见 docs/api.md。运行时实现及验证边界见 docs/runtime-discussion.md。源码开发和打包仍使用本机 Node.js 24+，与安装包日常运行依赖分开。
