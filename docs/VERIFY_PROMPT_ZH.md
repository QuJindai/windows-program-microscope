# 复核提示词

请接手独立公开仓库 QuJindai/windows-program-microscope 的 V0.2 分支 `feat/v0.2-runtime-microscope`。本项目只面向 Windows，GUI 为简体中文，六个分析镜片加采集页，共七页。阅读 README、CORE_UPGRADE、TEST_REPORT 和实施规格后再修改。

目标：验证真实采集和 GUI 联动，不把编译成功、样例数据或 mock 桥接当作 Windows 实测。保留所有用户已有代码和证据。

按顺序执行：

1. 记录 HEAD、OS、.NET/Rust/Node 版本。运行 Python、Node、Rust 运行时和采集器行为测试。
2. 在 Windows 管理员环境发布自包含采集器和探针。运行 tests/windows/test_capture.ps1，核验实际文件路径、读写字节、注册表完整键和值、TCP端点、线程、计数器和停止行为。
3. 运行 tests/runtime 的真实采集器集成和强制终止后定向会话清理测试，不能删除或放宽断言来获得绿色结果。
4. 使用官方 jq 1.8.2 Windows amd64，先强制核对 SHA256 `a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627`，再运行 tests/windows/test_jq.ps1。该字节与用户Drive中的目标程序一致。
5. 构建NSIS，运行 tests/windows/test_desktop.ps1。区分构建、安装、采集器随包存在、实际窗口启动和截图是否成功。
6. 浏览器执行 npm run test:gui，检查1440×900和1600×1000七页。对比 docs/gui-prototypes 中原始设计，底部时间线始终可见。导入实际WindowsMTP，核验CPU/内存曲线、I/O选择和证据面板。没有真实内存/调用栈/变量时显示未采集。
7. 验证导出重开保留“示例数据”来源；未知时长不补零；证据REAL/DERIVED/UNAVAILABLE不混用；迟到轮询不能覆盖新会话；失败记录有效部分仍能保存重开。
8. 原始04-state.png源文件尾部损坏，不能将其解码失败当成本次GUI损坏。以本版完整运行截图验证当前状态页。
9. 逐项报告通过/失败/未运行，写出复现步骤、精确提交和日志路径。失败时先保留原始记录，再修复根因并重跑相关门禁。

交付：完整源码ZIP、Windows安装包、原型和实际截图、开发/测试文档、原始测试日志和校验摘要。不要宣称任意原生局部变量、完整内存快照、指令级时间旅行或所有第三方程序兼容性已经完成。
