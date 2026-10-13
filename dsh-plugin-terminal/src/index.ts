/**
 * DSH 终端控制插件
 *
 * 将 DSH 底层的 `terminals` / `subprocess` 服务封装为 AI 可调用的 Tool，
 * 实现持久 PTY 会话管理（spawn / send / read / signal / list / kill）。
 */

// ---- 轻量内联类型（与 DSH 运行时契约一致） ----

interface Agent {
  readonly id: string;
}

interface TerminalSpawnRequest {
  type: string;
  name?: string;
  cwd?: string;
}

interface TerminalSessionSnapshot {
  sessionId: string;
  name?: string;
  type: string;
  pid?: number;
  status: { kind: string; exitCode?: number | null; signal?: string | null };
}

interface TerminalSpawnResult extends TerminalSessionSnapshot {
  motd: string;
}

interface TerminalSendRequest {
  text: string;
  submit: boolean;
  signal?: AbortSignal;
}

interface TerminalSendOperation {
  done: Promise<TerminalSendResult>;
  readOutput(): TerminalSendRead;
  cancel(): boolean;
}

interface TerminalSendRead {
  delta: string;
  truncated: boolean;
}

interface TerminalSendResult {
  viewport: string;
  waitReason: string;
  sessionStatus: { kind: string; exitCode?: number | null; signal?: string | null };
  truncated: boolean;
}

interface TerminalReadRequest {
  offset?: number;
  count?: number;
}

interface TerminalReadResult {
  text: string;
  totalLines: number;
  lineBegin: number;
  lineEnd: number;
  truncated: boolean;
}

type TerminalSignalName = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGTSTP" | "SIGHUP";

interface TerminalsService {
  registerBackend(backend: unknown): () => void;
  listBackends(): string[];
  spawn(owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult>;
  hasOwnerActivity(owner: Agent): boolean;
  startSend(owner: Agent, id: string, request: TerminalSendRequest): TerminalSendOperation;
  read(owner: Agent, id: string, request?: TerminalReadRequest): TerminalReadResult;
  signal(owner: Agent, id: string, sig: TerminalSignalName): Promise<{ delivered: true; targetPgid: number }>;
  kill(owner: Agent, id: string, reason?: string): Promise<boolean>;
  list(owner: Agent): TerminalSessionSnapshot[];
}

interface SubprocessTerminalSpawnSpec {
  argv: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  rows: number;
  cols: number;
  terminalType: string;
  shellActivity?: boolean;
  graceMs: number;
  signal?: AbortSignal;
}

interface SubprocessOutcome {
  exitCode: number | null;
  signal: string | null;
}

interface SubprocessTerminalHandle {
  readonly pid: number;
  readonly output: AsyncIterable<string>;
  readonly done: Promise<SubprocessOutcome>;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  inspectForeground(): Promise<{ processGroupId: number; inputWaiting: boolean } | undefined>;
  inspectActivity(): Promise<{ state: "idle" | "busy" | "unknown"; revision: number }>;
  signalForeground(sig: string): Promise<number>;
  terminate(): Promise<void>;
}

interface SubprocessService {
  resolveExecutable(cmd: string, env?: Record<string, string>, sig?: AbortSignal): Promise<string>;
  terminalEnvironment(sig?: AbortSignal): Promise<{ platform: "posix" | "windows"; defaultShell?: string }>;
  spawn(spec: unknown): unknown;
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
}

// Tool 相关类型
interface ToolExecutionContext {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: Agent;
  readonly signal: AbortSignal;
  deferContext(ctx: unknown): void;
  concludeTurn(): void;
}

type ContentBlock = { type: "text"; text: string };

// JSON Schema 简化类型
type JsonSchema = Record<string, unknown>;

// ---- 辅助函数 ----

/** 将 Tool 返回值渲染为标准文本 ContentBlock */
function textOutput(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** 快速 JSON Schema object 构造 */
function objSchema(props: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties: props, required, additionalProperties: false };
}

function strSchema(desc: string, enumVals?: string[]): JsonSchema {
  const s: JsonSchema = { type: "string", description: desc };
  if (enumVals) s["enum"] = enumVals;
  return s;
}

function intSchema(desc: string): JsonSchema {
  return { type: "integer", description: desc };
}

function boolSchema(desc: string): JsonSchema {
  return { type: "boolean", description: desc };
}

// ---- 插件主体 ----

interface PluginContext {
  /** Cordis 可选服务读取（无 inject 声明时的唯一合法途径） */
  get(name: string): unknown;
  tools: {
    register(def: ToolDefinition): () => void;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: JsonSchema;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  execute(args: any, exec: ToolExecutionContext): Promise<unknown>;
  presentCall?(args: any): unknown;
  presentResult?(args: any, result: { content: ContentBlock[]; isError: boolean }): unknown;
}

// 用 subprocess.spawnTerminal 实现的 fallback 后端
// 会话存储
interface ActiveSession {
  handle: SubprocessTerminalHandle;
  name?: string;
  type: string;
  bufferedOutput: string[];
}

const sessions = new Map<string, ActiveSession>();
let sessionCounter = 0;

/** 去除 ANSI 转义序列，使终端输出对 AI 可读 */
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function fallbackSpawn(
  subprocess: SubprocessService,
  request: TerminalSpawnRequest & { command?: string },
  signal?: AbortSignal,
): Promise<TerminalSpawnResult> {
  return Promise.resolve().then(async () => {
    const env = await subprocess.terminalEnvironment(signal);
    const isWindows = env.platform === "windows";
    const shell = env.defaultShell || (isWindows ? "cmd.exe" : "/bin/sh");
    const cwd = request.cwd || process.cwd();
    const command = request.command?.trim();

    // 给了 command 就真正执行它；否则开一个交互式 shell
    const argv: string[] = command
      ? isWindows
        ? [shell, "/k", command]
        : [shell, "-c", command]
      : isWindows
        ? [shell, "/k", "cd", "/d", cwd]
        : [shell, "-i"];

    const spec: SubprocessTerminalSpawnSpec = {
      argv,
      cwd,
      env: {},
      rows: 40,
      cols: 120,
      terminalType: "xterm-256color",
      shellActivity: true,
      graceMs: 3000,
      signal,
    };

    const handle = await subprocess.spawnTerminal(spec);
    const sid = `term_${++sessionCounter}`;

    sessions.set(sid, {
      handle,
      name: request.name,
      type: "subprocess-fallback",
      bufferedOutput: [],
    });

    // 在后台消费输出流
    (async () => {
      try {
        for await (const chunk of handle.output) {
          const rec = sessions.get(sid);
          if (rec) rec.bufferedOutput.push(chunk);
        }
      } catch {
        // 输出流关闭
      }
    })();

    return {
      sessionId: sid,
      name: request.name,
      type: "subprocess-fallback",
      pid: handle.pid,
      status: { kind: "running" },
      motd: `终端已启动 [pid=${handle.pid}] 类型: ${shell}`,
    };
  });
}

// ---- 导出的 Cordis 插件 ----

module.exports = function dshPluginTerminal(ctx: PluginContext) {
  // Cordis 服务访问：必须通过 ctx.get() 读取，不能直接读属性（会触发 inject 断言）
  const terminals = ctx.get("terminals") as TerminalsService | undefined;
  const subprocess = ctx.get("subprocess") as SubprocessService | undefined;
  const tools = ctx.get("tools") as PluginContext["tools"] | undefined;

  if (!tools) {
    console.error("[dsh-plugin-terminal] ctx.tools 不可用，跳过注册");
    return;
  }

  const hasTerminals = !!terminals;
  const hasSubprocess = !!subprocess;

  if (!hasTerminals && !hasSubprocess) {
    console.error("[dsh-plugin-terminal] terminals 和 subprocess 服务均不可用");
    return;
  }

  // ----- 发现可用后端 -----
  let availableBackends: string[] = [];
  if (hasTerminals) {
    availableBackends = terminals!.listBackends();
    console.log("[dsh-plugin-terminal] 可用终端后端:", availableBackends.join(", "));
  }

  // ----- 统一 spawn -------
  async function doSpawn(
    agent: Agent,
    req: TerminalSpawnRequest & { command?: string },
    signal?: AbortSignal,
  ): Promise<TerminalSpawnResult> {
    if (hasTerminals && availableBackends.length > 0) {
      // 优先使用 terminals 服务
      const type = availableBackends.includes(req.type) ? req.type : availableBackends[0];
      return terminals!.spawn(agent, { type, name: req.name, cwd: req.cwd }, signal);
    }
    if (hasSubprocess) {
      return fallbackSpawn(subprocess!, req, signal);
    }
    throw new Error("没有可用的终端后端");
  }

  function doList(agent: Agent): TerminalSessionSnapshot[] {
    if (hasTerminals) {
      const list = terminals!.list(agent);
      // 也加入 fallback 会话
      const extra: TerminalSessionSnapshot[] = [];
      for (const [sid, rec] of sessions) {
        extra.push({
          sessionId: sid,
          name: rec.name,
          type: rec.type,
          pid: rec.handle.pid,
          status: { kind: "running" },
        });
      }
      return [...list, ...extra];
    }
    // 纯 fallback
    const result: TerminalSessionSnapshot[] = [];
    for (const [sid, rec] of sessions) {
      result.push({
        sessionId: sid,
        name: rec.name,
        type: rec.type,
        pid: rec.handle.pid,
        status: { kind: "running" },
      });
    }
    return result;
  }

  function doRead(agent: Agent, sid: string, req?: TerminalReadRequest): TerminalReadResult {
    if (hasTerminals && !sessions.has(sid)) {
      return terminals!.read(agent, sid, req);
    }
    // fallback session
    const rec = sessions.get(sid);
    if (!rec) throw new Error(`会话不存在: ${sid}`);
    const all = rec.bufferedOutput.join("");
    const lines = all.split("\n");
    const totalLines = lines.length;
    const count = req?.count ?? 2000;
    const offset = req?.offset ?? Math.max(0, totalLines - count);
    const slice = lines.slice(offset, offset + count);
    return {
      text: stripAnsi(slice.join("\n")),
      totalLines,
      lineBegin: offset,
      lineEnd: offset + slice.length,
      truncated: slice.length < totalLines - offset,
    };
  }

  async function doSend(
    agent: Agent,
    sid: string,
    req: TerminalSendRequest,
  ): Promise<{ viewport: string; waitReason: string; status: string }> {
    if (hasTerminals && !sessions.has(sid)) {
      const op = terminals!.startSend(agent, sid, req);
      const result = await op.done;
      return {
        viewport: stripAnsi(result.viewport),
        waitReason: result.waitReason,
        status: result.sessionStatus.kind,
      };
    }
    // fallback session
    const rec = sessions.get(sid);
    if (!rec) throw new Error(`会话不存在: ${sid}`);
    const text = req.submit ? req.text + "\r\n" : req.text;
    await rec.handle.write(text);
    // 等待短暂时间收集输出
    await new Promise((r) => setTimeout(r, 300));
    const output = rec.bufferedOutput.slice(-100).join("");
    return {
      viewport: stripAnsi(output).slice(-4000),
      waitReason: "inferred_idle",
      status: "running",
    };
  }

  async function doSignal(
    agent: Agent,
    sid: string,
    sig: TerminalSignalName,
  ): Promise<{ delivered: boolean; targetPgid?: number }> {
    if (hasTerminals && !sessions.has(sid)) {
      return terminals!.signal(agent, sid, sig);
    }
    const rec = sessions.get(sid);
    if (!rec) throw new Error(`会话不存在: ${sid}`);
    const pgid = await rec.handle.signalForeground(sig);
    return { delivered: true, targetPgid: pgid };
  }

  async function doKill(agent: Agent, sid: string): Promise<boolean> {
    if (hasTerminals && !sessions.has(sid)) {
      return terminals!.kill(agent, sid);
    }
    const rec = sessions.get(sid);
    if (!rec) return false;
    await rec.handle.terminate();
    sessions.delete(sid);
    return true;
  }

  // ===================== 注册工具 =====================

  // 1. terminal_spawn
  tools.register({
    name: "terminal_spawn",
    description:
      "创建持久终端会话，启动 shell 或指定命令。返回 session_id 用于后续操作。支持交互式 TUI 程序（如 vim、htop、nano）。",
    parameters: objSchema({
      command: strSchema("启动命令，如 'vim file.txt' 或 'htop'。留空启动默认 shell。"),
      cwd: strSchema("工作目录路径，默认当前工作区。"),
      name: strSchema("会话标签名，便于识别。"),
    }),
    output: {
      schema: objSchema(
        {
          session_id: strSchema("终端会话唯一标识"),
          name: strSchema("会话名称"),
          type: strSchema("后端类型"),
          pid: intSchema("进程 PID"),
          motd: strSchema("启动信息"),
          status: strSchema("会话状态"),
        },
        ["session_id"],
      ),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const agent = exec.agent!;
      const result = await doSpawn(agent, {
        type: availableBackends[0] || "local",
        name: args.name || args.command || "terminal",
        cwd: args.cwd,
        command: args.command,
      }, exec.signal);
      return {
        session_id: result.sessionId,
        name: result.name,
        type: result.type,
        pid: result.pid,
        motd: result.motd,
        status: result.status.kind,
      };
    },
    presentCall(args: any) {
      return {
        card: "terminal",
        title: args.command || "shell",
        description: "启动持久终端会话",
        cwd: args.cwd,
      };
    },
    presentResult(_args: any, result: { content: ContentBlock[]; isError: boolean }) {
      if (result.isError) return undefined;
      try {
        const v = JSON.parse(result.content[0]?.text || "{}");
        return {
          card: "terminal",
          title: `终端: ${v.name || v.session_id}`,
          output: v.motd || "",
        };
      } catch {
        return undefined;
      }
    },
  });

  // 2. terminal_send
  tools.register({
    name: "terminal_send",
    description:
      "向指定终端会话发送输入。设置 submit=true 会附加回车换行（模拟按 Enter）。用于与 shell、REPL 或 TUI 程序交互。",
    parameters: objSchema(
      {
        session_id: strSchema("terminal_spawn 返回的会话 ID"),
        text: strSchema("要发送的文本或按键序列"),
        submit: boolSchema("是否附加回车（默认 true）"),
      },
      ["session_id", "text"],
    ),
    output: {
      schema: objSchema({
        viewport: strSchema("终端当前可见内容"),
        wait_reason: strSchema("等待原因：stdin_read / inferred_idle / timeout / session_exit"),
        status: strSchema("会话状态"),
      }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const result = await doSend(exec.agent!, args.session_id, {
        text: args.text,
        submit: args.submit !== false,
        signal: exec.signal,
      });
      return {
        viewport: result.viewport,
        wait_reason: result.waitReason,
        status: result.status,
      };
    },
    presentCall(args: any) {
      return {
        card: "terminal",
        title: `输入: ${String(args.text).slice(0, 60)}`,
        description: args.submit !== false ? "发送并回车" : "仅发送文本",
      };
    },
    presentResult(_args: any, result: { content: ContentBlock[]; isError: boolean }) {
      if (result.isError) return undefined;
      try {
        const v = JSON.parse(result.content[0]?.text || "{}");
        return {
          card: "terminal",
          title: `状态: ${v.status}`,
          output: v.viewport?.slice(-2000) || "",
        };
      } catch {
        return undefined;
      }
    },
  });

  // 3. terminal_read
  tools.register({
    name: "terminal_read",
    description: "读取终端会话的输出缓冲区内容。支持分页（offset + count）。",
    parameters: objSchema(
      {
        session_id: strSchema("terminal_spawn 返回的会话 ID"),
        offset: intSchema("起始行号（从 0 开始，默认最新）"),
        count: intSchema("读取行数（默认 2000）"),
      },
      ["session_id"],
    ),
    output: {
      schema: objSchema({
        text: strSchema("读到的文本"),
        total_lines: intSchema("缓冲区总行数"),
        line_begin: intSchema("返回的起始行"),
        line_end: intSchema("返回的结束行"),
        truncated: boolSchema("输出是否被截断"),
      }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const r = doRead(exec.agent!, args.session_id, {
        offset: args.offset,
        count: args.count,
      });
      // 必须与 output.schema 声明的 snake_case 字段严格一致
      return {
        text: r.text,
        total_lines: r.totalLines,
        line_begin: r.lineBegin,
        line_end: r.lineEnd,
        truncated: r.truncated,
      };
    },
    presentCall(args: any) {
      return {
        card: "terminal",
        title: `读取: ${args.session_id}`,
        description: `offset=${args.offset ?? "最新"} count=${args.count ?? 2000}`,
      };
    },
    presentResult(_args: any, result: { content: ContentBlock[]; isError: boolean }) {
      if (result.isError) return undefined;
      try {
        const v = JSON.parse(result.content[0]?.text || "{}");
        return {
          card: "terminal",
          title: `行 ${v.line_begin}-${v.line_end} / ${v.total_lines}`,
          output: v.text?.slice(-4000) || "",
        };
      } catch {
        return undefined;
      }
    },
  });

  // 4. terminal_list
  tools.register({
    name: "terminal_list",
    description: "列出当前所有活跃的终端会话。",
    parameters: objSchema({}),
    output: {
      schema: {
        type: "array",
        items: objSchema({
          session_id: strSchema("会话 ID"),
          name: strSchema("会话名称"),
          type: strSchema("后端类型"),
          pid: intSchema("进程 PID"),
          status: strSchema("运行状态"),
        }),
      },
      render: (_args, value) => textOutput(value),
    },
    async execute(_args, exec) {
      const list = doList(exec.agent!);
      return list.map((s) => ({
        session_id: s.sessionId,
        name: s.name,
        type: s.type,
        pid: s.pid,
        status: s.status.kind,
      }));
    },
    presentCall() {
      return {
        card: "terminal",
        title: "列出终端会话",
        description: "所有活跃会话",
      };
    },
    presentResult(_args: any, result: { content: ContentBlock[]; isError: boolean }) {
      if (result.isError) return undefined;
      try {
        const list = JSON.parse(result.content[0]?.text || "[]");
        return {
          card: "terminal",
          title: `${list.length} 个会话`,
          output: list.map((s: any) => `[${s.session_id}] ${s.name || "?"} pid=${s.pid} ${s.status}`).join("\n"),
        };
      } catch {
        return undefined;
      }
    },
  });

  // 5. terminal_kill
  tools.register({
    name: "terminal_kill",
    description: "关闭指定终端会话并释放资源。",
    parameters: objSchema(
      {
        session_id: strSchema("要关闭的会话 ID"),
      },
      ["session_id"],
    ),
    output: {
      schema: objSchema({
        closed: boolSchema("是否成功关闭"),
      }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const closed = await doKill(exec.agent!, args.session_id);
      return { closed };
    },
    presentCall(args: any) {
      return {
        card: "terminal",
        title: `关闭: ${args.session_id}`,
        description: "终止终端会话",
      };
    },
    presentResult(_args: any, result: { content: ContentBlock[]; isError: boolean }) {
      if (result.isError) return undefined;
      return { card: "terminal", title: "会话已关闭" };
    },
  });

  // 6. terminal_signal
  tools.register({
    name: "terminal_signal",
    description:
      "向终端会话的前台进程组发送信号（Ctrl-C: SIGINT, Ctrl-Z: SIGTSTP, 强制终止: SIGKILL）。",
    parameters: objSchema(
      {
        session_id: strSchema("终端会话 ID"),
        signal: strSchema("信号名称", ["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGHUP"]),
      },
      ["session_id", "signal"],
    ),
    output: {
      schema: objSchema({
        delivered: boolSchema("信号是否已送达"),
        target_pgid: intSchema("目标进程组 ID"),
      }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const result = await doSignal(exec.agent!, args.session_id, args.signal as TerminalSignalName);
      return { delivered: result.delivered, target_pgid: result.targetPgid };
    },
    presentCall(args: any) {
      return {
        card: "terminal",
        title: `信号: ${args.signal}`,
        description: `发送到 ${args.session_id}`,
      };
    },
    presentResult(_args: any, result: { content: ContentBlock[]; isError: boolean }) {
      if (result.isError) return undefined;
      return { card: "terminal", title: "信号已送达" };
    },
  });

  console.log(
    `[dsh-plugin-terminal] 已注册 6 个终端工具 (后端: ${hasTerminals ? availableBackends.join(",") || "无" : "subprocess fallback"})`,
  );
};