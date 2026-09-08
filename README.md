# Windows 程序显微镜

独立、简体中文、GUI 主导的 Windows 程序观察工具。V0.2 将桌面界面连接到真实的 Windows ETW 采集器，并把运行记录贯通到总览、时间线、流程、状态、输入/输出和对比六个镜片。

## 现在能做什么

- 列出真实 Windows 进程，选择 PID 和采集时长，正常停止并保留记录。
- 采集进程、线程、模块、文件、注册表、TCP 等事件，以及进程 CPU、内存等可用计数器；显示来源、缺失能力与丢事件诊断。
- 保存、重新打开和校验 MTP 记录；导入失败保留当前有效记录。
- 在七个中文界面之间保持事件选择，查看时间轨道、原始详情和关联证据。
- 根据显式关系生成执行图，查询上下游、最短路径和分叉来源；时间顺序不会自动当作因果。
- 对齐可比较线程的事件，定位首次结果差异；无法对齐的线程会明确标记比较范围不足。
- 导出 MTP 和 Perfetto 可导入的 Trace Event JSON；读取 PE 文件的真实头部和节信息。

Observe 不提供任意原生程序的局部变量、完整内存快照或指令级时间旅行。这些模式明确禁用。示例需要主动打开，并持续标记“示例数据”。

## Windows 桌面运行

开发依赖：Windows 10/11 x64、.NET 8 SDK、Node.js 22、Rust stable、Visual Studio C++ Build Tools、WebView2。ETW 内核采集需要以管理员身份运行桌面程序。

```powershell
npm ci
npm run collector:publish
npm run dev
```

发布安装包：

```powershell
npm run build:windows
```

`collector:publish` 将自包含采集器放入 `src-tauri/collector/`，Tauri 随安装包携带。终端用户无需单独安装 .NET SDK。运行记录保存在 Tauri 应用数据目录的 `traces` 子目录中。

## 在云端或浏览器验证界面

```bash
python3 tools/serve.py
```

打开 `http://127.0.0.1:8765`。浏览器支持记录导入、显式示例和分析；Windows 进程采集通过桌面接口提供。Linux 不能通过安装 .NET 获得 Windows ETW。

```bash
npm ci
python3 -m unittest discover -s tests -v
npm run test:core
cargo test --manifest-path tests/runtime/Cargo.toml
npx playwright install chromium
npm run test:gui
```

浏览器测试自行启动审阅服务器，覆盖七页布局、记录导入/导出、选择联动和模拟桥接。模拟桥接测试单独标记，不能替代真实 Windows 验收。

## 真实 Windows ETW 验收

```powershell
dotnet publish collector/windows -c Release -r win-x64 --self-contained true -o src-tauri/collector
dotnet publish collector/probe -c Release -r win-x64 --self-contained true -o test-results/probe
./tests/windows/test_capture.ps1 -CollectorPath "$PWD/src-tauri/collector/ProgramMicroscope.Collector.exe" -ProbePath "$PWD/test-results/probe/ProgramMicroscope.Probe.exe" -OutputDirectory "$PWD/test-results/windows"
$env:MICROSCOPE_TEST_COLLECTOR="$PWD/src-tauri/collector/ProgramMicroscope.Collector.exe"
$env:MICROSCOPE_TEST_PROBE="$PWD/test-results/probe/ProgramMicroscope.Probe.exe"
cargo test --manifest-path tests/runtime/Cargo.toml -- --nocapture
```

探针在采集器就绪后实际读写临时文件、修改专用 HKCU 测试键、建立本机 TCP 连接并创建线程，最后清理测试资源。GitHub Actions 将编译、ETW 行为、运行时桥接与 GUI 验证分开执行并保存证据。

## 文档与交付

- [本版实施规格](docs/superpowers/specs/2026-09-08-runtime-v02.md)
- [任务计划](docs/superpowers/plans/2026-09-08-runtime-v02.md)
- [测试报告](docs/TEST_REPORT.md)
- [开源整合边界](docs/OPEN_SOURCE_INTEGRATION.md)
- [原型图与提示词](docs/gui-prototypes/PROMPTS.md)

`python tools/package.py` 运行 Python 测试并创建源码 ZIP，排除依赖、编译输出和本地环境文件；解压后逐文件校验内容摘要。
