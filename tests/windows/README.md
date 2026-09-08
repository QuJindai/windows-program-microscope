# Windows ETW 验收

在已安装 .NET 8 SDK 的 Windows 上，先独立编译两个项目：

```powershell
dotnet build collector/windows/ProgramMicroscope.Collector.csproj -c Release
dotnet build collector/probe/ProgramMicroscope.Probe.csproj -c Release
```

再使用**管理员 PowerShell 7**运行真实采集验收：

```powershell
pwsh -NoProfile -File tests/windows/test_capture.ps1
```

默认查找各项目的 `bin/Release/net8.0-windows/*.exe`，默认输出到
`artifacts/windows-etw`。也可以显式指定发布后的 EXE 或 DLL：

```powershell
pwsh -NoProfile -File tests/windows/test_capture.ps1 `
  -CollectorPath C:/build/ProgramMicroscope.Collector.dll `
  -ProbePath C:/build/ProgramMicroscope.Probe.dll `
  -OutputDirectory C:/results/windows-etw
```

脚本不执行编译，也不将编译成功或非 Windows 跳过当作 ETW 验收成功。
`acceptance-report.json` 分别记录编译步骤未在本脚本执行、真实运行结果和逐项检查结果；
标准输出、标准错误、完整采集、提前停止采集和探针报告都会保留，便于检查失败原因。
失败时退出码为 1。

探针首先输出 `waiting` JSON。只有采集器输出 `READY`，脚本才通过标准输入发送 `go`。
探针随后创建唯一文件并写入、读回 65536 字节；创建 HKCU 唯一注册表键并设置、查询和
删除值；通过真实 localhost TCP 双向传输；启动并结束一个短生命周期原生线程；加载
系统模块。探针输出实际路径、值名、端口和线程 ID，供脚本核对 ETW 证据。
注册表值的内容仅由探针自行验证，不宣称 ETW 可恢复值内容。

第一次采集按 8 秒时长结束。第二次采集请求 60 秒，在启动后约 1.2 秒发送 `stop`，
验证结果为 `completed`、`stop_reason=requested` 且最终 JSON 可解析。
脚本验证真实证据引用、数组形状、事件数量上限、时间边界、CPU/内存实际采样，
并拒绝 Observe 模式凭空生成的因果边和程序变量。超时及失败均执行进程和临时注册表键清理。
