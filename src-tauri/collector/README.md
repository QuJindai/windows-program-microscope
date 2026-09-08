# Packaged collector

Publish the Windows collector here before creating an installer:

```
dotnet publish collector/windows/ProgramMicroscope.Collector.csproj -c Release -r win-x64 --self-contained true -o src-tauri/collector
npm run tauri -- build
```

The bundle includes this directory and all collector dependencies. The desktop app resolves `collector/ProgramMicroscope.Collector.exe` relative to its resources. Missing binaries produce an explicit unavailable state. A local development override may set `MICROSCOPE_COLLECTOR_PATH` to an absolute executable path.
