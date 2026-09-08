# V0.2 实施进展

- 仓库独立，Windows 专用，简体中文 GUI。主设计遵循原始七张原型。
- 开发分支 `feat/v0.2-runtime-microscope`；PR #1 已提交真实采集、桥接、分析及 GUI。
- 本地 Python/Node/Rust/采集器行为和浏览器集成测试通过；原生 Linux Tauri 编译启动通过。
- Windows 第一轮真实ETW获得455条事件，全部数据通过MTP Schema和两种分析引擎校验。注册表值归属验收失败，已据实际记录修正KCB生命周期映射，并增加63项采集器断言。
- Drive中的jq-windows-amd64.exe已下载，SHA256与官方jq1.8.2逐字节一致，将加入Windows第三方采集验证。
- 最终Windows测试和打包状态以TEST_REPORT.md及CI日志为准，不用本地编译替代运行证据。
