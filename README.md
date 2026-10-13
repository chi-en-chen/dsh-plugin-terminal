# dsh-plugin-terminal

DSH 终端控制插件 —— 为 AI Agent 提供**持久 PTY 会话**能力，可交互操作 shell、REPL 与 TUI 程序。

## 为什么需要它

DSH 内置的 `pwsh` 工具每次调用都启动一个**全新进程**，无法保持状态：

```
调用1: pwsh "set X=1"    → 进程结束，X 丢失
调用2: pwsh "echo %X%"   → 空
```

本插件通过真正的 PTY 会话解决了这个问题：

```
调用1: terminal_spawn  python        → session_id = term_2
调用2: terminal_send   "x = 4200"
调用3: terminal_send   "print(x)"    → 输出 4200   ← 状态保持
```

## 提供的工具

| 工具 | 说明 |
|---|---|
| `terminal_spawn` | 创建持久终端会话。可指定 `command` 直接运行程序（shell / python / vim / htop ...） |
| `terminal_send` | 向会话发送输入，`submit: true` 模拟回车 |
| `terminal_read` | 读取输出缓冲区，支持 `offset` / `count` 分页 |
| `terminal_list` | 列出所有活跃会话 |
| `terminal_signal` | 发送 SIGINT / SIGTERM / SIGKILL / SIGTSTP / SIGHUP |
| `terminal_kill` | 关闭会话并释放 PTY |

## 安装

```powershell
# 在 DSH 中通过 plugin_manager 安装（file: 协议指向本目录）
# action=install_bundle  target=file:<此目录绝对路径>
```

或使用 DSH CLI：

```bash
dsh plugin install file:/path/to/dsh-plugin-terminal
```

安装后验证：

```
plugin_manager list_plugins          # 应出现 include:terminal-control-v3 (fiberPhase: active)
cordis_inspect_query listTools       # 应出现上述 6 个工具
```

## 实现要点

### 服务访问（Cordis DI）

Cordis 的 Context 是 Proxy，**直接读属性会触发 inject 断言**：

```js
ctx.terminals          // ✗ Error: cannot get property "terminals" without inject
ctx.get("terminals")   // ✓ reflect 服务混入的方法，未提供时返回 undefined
```

本插件用 `ctx.get()` 做可选依赖探测，因此能在缺少 `terminals` 服务时自动降级。

### 双后端策略

1. **优先** `ctx.get("terminals")` —— DSH 原生终端服务（含后端注册表、Web UI 联动）
2. **降级** `ctx.get("subprocess").spawnTerminal()` —— 直接分配 PTY

当前 desktop profile 走的是降级路径（`terminals` 服务无注册后端），类型标记为 `subprocess-fallback`。

### bundle 格式

`package.json` 声明补丁文件：

```json
"dsh": { "bundle": { "patch": "dsh-patch.yaml" } }
```

`dsh-patch.yaml` 必须是**顶层 YAML 数组**，用 `insert` 而非 `include`：

```yaml
- insert:
    - id: terminal-control-v3
      name: dsh-plugin-terminal/lib/entry2.js
```

### ⚠️ 模块缓存陷阱（重要）

DSH 加载器**按模块规格符缓存**已加载的模块。修改代码后即使重新安装，仍会执行旧代码。
因此每次改动代码都需要**同时更换入口 ID 和模块规格符**：

```yaml
    - id: terminal-control-v4          # 换 ID
      name: dsh-plugin-terminal/lib/entry3.js   # 换文件
```

## 开发

```bash
node <node路径> node_modules/typescript/bin/tsc   # 编译 src/index.ts → lib/index.js
```

修改代码后按上面的缓存陷阱说明重新部署。

## 已知限制

- **`pid` 返回 0**：`SubprocessTerminalHandle.pid` 在当前 provider 下未暴露真实值。
- **ANSI 转义序列被剥离**：`terminal_read` / `terminal_send` 输出已清理，便于 AI 阅读；但这也意味着 TUI 界面（vim/htop）的光标定位信息丢失，无法还原完整屏幕。
- **无终端尺寸协商**：PTY 固定 120x40，未暴露 `resize`。
- **`terminal_signal` 的 `target_pgid` 返回 0**：Windows 进程组语义与 POSIX 不同；信号仍能正确送达前台进程（已验证 SIGINT 可中断 Python `time.sleep`）。
- **会话不跨插件重载保留**：重新安装 bundle 会重置会话表，旧的 OS 进程需手动清理。

## 验证记录

| 测试 | 结果 |
|---|---|
| 创建 shell 会话 | ✅ |
| 执行 `echo SPAWN_CMD_EXECUTED_OK` | ✅ 输出正确 |
| 跨调用变量持久化（`session_var`） | ✅ `PERSISTED: 4200` |
| 多会话并存 | ✅ 同时列出 2 个会话 |
| SIGINT 中断 `time.sleep(30)` | ✅ Python 抛 `KeyboardInterrupt` |
| 关闭会话 | ✅ |
