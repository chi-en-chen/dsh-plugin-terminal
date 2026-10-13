/**
 * DSH 终端控制插件
 *
 * 将 DSH 底层的 `terminals` / `subprocess` 服务封装为 AI 可调用的 Tool，
 * 实现持久 PTY 会话管理（spawn / send / read / signal / list / kill）。
 */
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
    status: {
        kind: string;
        exitCode?: number | null;
        signal?: string | null;
    };
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
    sessionStatus: {
        kind: string;
        exitCode?: number | null;
        signal?: string | null;
    };
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
    signal(owner: Agent, id: string, sig: TerminalSignalName): Promise<{
        delivered: true;
        targetPgid: number;
    }>;
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
    inspectForeground(): Promise<{
        processGroupId: number;
        inputWaiting: boolean;
    } | undefined>;
    inspectActivity(): Promise<{
        state: "idle" | "busy" | "unknown";
        revision: number;
    }>;
    signalForeground(sig: string): Promise<number>;
    terminate(): Promise<void>;
}
interface SubprocessService {
    resolveExecutable(cmd: string, env?: Record<string, string>, sig?: AbortSignal): Promise<string>;
    terminalEnvironment(sig?: AbortSignal): Promise<{
        platform: "posix" | "windows";
        defaultShell?: string;
    }>;
    spawn(spec: unknown): unknown;
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
}
interface ToolExecutionContext {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
    readonly agent?: Agent;
    readonly signal: AbortSignal;
    deferContext(ctx: unknown): void;
    concludeTurn(): void;
}
type ContentBlock = {
    type: "text";
    text: string;
};
type JsonSchema = Record<string, unknown>;
/** 将 Tool 返回值渲染为标准文本 ContentBlock */
declare function textOutput(value: unknown): ContentBlock[];
/** 快速 JSON Schema object 构造 */
declare function objSchema(props: Record<string, JsonSchema>, required?: string[]): JsonSchema;
declare function strSchema(desc: string, enumVals?: string[]): JsonSchema;
declare function intSchema(desc: string): JsonSchema;
declare function boolSchema(desc: string): JsonSchema;
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
    presentResult?(args: any, result: {
        content: ContentBlock[];
        isError: boolean;
    }): unknown;
}
interface ActiveSession {
    handle: SubprocessTerminalHandle;
    name?: string;
    type: string;
    bufferedOutput: string[];
}
declare const sessions: Map<string, ActiveSession>;
declare let sessionCounter: number;
declare function fallbackSpawn(subprocess: SubprocessService, owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult>;
