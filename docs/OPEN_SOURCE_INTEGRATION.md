# 开源整合与能力边界（V0.2）

本仓库是独立的 Windows 程序显微镜。以下表格区分实际依赖、格式适配和产品思想参考，避免把参考项目清单当成已实现能力。

| 项目 | 采用方式 | 本版落实 | 验证位置 |
| --- | --- | --- | --- |
| [Microsoft TraceEvent / PerfView](https://github.com/microsoft/perfview/tree/v3.2.6) | MIT，NuGet 固定 3.2.6 | Windows ETW 采集，进程/线程/模块/文件/注册表/TCP，以及采集损失诊断 | collector/windows、tests/windows |
| [Tauri](https://github.com/tauri-apps/tauri) | MIT/Apache-2.0，Cargo.lock 与 package-lock.json 固定解析版本 | 原生进程桥接、单会话控制、记录持久化、桌面安装包 | src-tauri、tests/runtime |
| [Perfetto](https://perfetto.dev/docs/getting-started/other-formats) | 支持其可导入的 Trace Event JSON 格式；不捆绑 Perfetto 程序 | 真实时间戳、线程轨道、完整事件/瞬时事件、已观测计数器导出 | app/trace-core.js、adapters/perfetto_export.py |
| [Aarchify](https://github.com/QuJindai/Aarchify) | MIT，借鉴显式图、来源和可检查关系的设计思想 | MTP 显式边生成图、上下游遍历、最短路径、分叉证据追溯；未复制项目实现 | analysis/trace_engine.py、app/trace-core.js |

Aarchify 提供的图表达和本产品的运行采集各有用途。这里只对具体可检验能力做对照，不宣称整体性能或功能已超过 Aarchify。

## 人能直接使用的组合

选择 Windows 进程 → 启动采集器 → ETW 和进程计数器 → 独立 MTP 记录 → GUI 的总览、时间线、流程、状态、I/O 和对比 → 导出 Perfetto。

图中的时间顺序与因果关系分开。顺序相邻、同线程、时间重叠不会自动产生“导致”关系。值来源追溯只沿记录明确提供的证据边；Observe 没有捕获的局部变量、堆内存、原生调用参数和完整指令回放显示不可用。

## 尚未集成

DbgEng/Time Travel Debugging、Detours、Tracy、xyflow、符号服务器和任意原生程序变量历史没有在本版实现。GUI 不把这些入口伪装为已经可用的采集模式。

## 许可证

仓库自身代码为 MIT。运行库通过官方包引用，源码依赖版本由锁文件控制；完整上游版权声明随依赖及发布产物保留。微软 ETW 是 Windows 的系统能力，Linux 编译通过不代表 Windows 采集验收通过。
