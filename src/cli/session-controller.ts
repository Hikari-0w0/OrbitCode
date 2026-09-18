import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationCheckpoint } from "@/core/conversations/types";
import type { PermissionUserDecision } from "@/core/permissions/approval";
import { executablePlanId, PLAN_EXECUTION_PROMPT } from "@/core/conversations/plan-execution";
import { LocalConversationExporter } from "@/lib/local-conversation-exporter";
import type { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import type { AgentRuntime } from "@/runtime/agent-runtime";
import type { ConversationService } from "@/runtime/conversation-service";
import type { PermissionSessionManager } from "@/runtime/permission-session-manager";
import { resolveRuntimeProvider, summarizeProviders, type ProviderContext } from "@/runtime/config";
import { resolveWorkspaceBoundary, type WorkspaceCatalog } from "@/runtime/workspace-config";
import { parseCliInput, COMMAND_HELP } from "@/cli/commands";
import type { TerminalRenderer } from "@/cli/renderer";

export type SessionControllerOptions = {
  readonly cwd: string;
  readonly terminal: boolean;
  readonly runtime: AgentRuntime;
  readonly conversations: ConversationService;
  readonly permissions: PermissionSessionManager;
  readonly log: LocalAgentRunLog;
  readonly renderer: TerminalRenderer;
  readonly loadConfig: () => Promise<ProviderContext>;
  readonly loadWorkspaces: () => Promise<WorkspaceCatalog>;
};
export class CliInteractionError extends Error {}

export class SessionController {
  private checkpoint?: ConversationCheckpoint;
  private permissionId: string;
  private active?: AbortController;
  private plan?: { readonly revision: number; readonly id: string };
  private confirmation?: { readonly token: string; readonly kind: "clear" | "delete"; readonly id: string; readonly revision: number };
  private unsaved = false;
  private interrupted = false;
  private readonly latestResults = new Map<string, string>();
  exitRequested = false;
  exitCode = 0;
  constructor(private readonly options: SessionControllerOptions) {
    this.permissionId = options.permissions.createSession().id;
  }
  get busy(): boolean { return this.active !== undefined; }
  async initialize(selection: { readonly providerName?: string; readonly workspaceId?: string; readonly resumeId?: string }): Promise<void> {
    if (selection.resumeId) await this.resume(selection.resumeId);
    else {
      const config = await this.options.loadConfig();
      const providerId = selection.providerName ?? (config.providers.length === 1 ? config.providers[0].name : undefined);
      if (!providerId) throw new CliInteractionError("存在多个 Provider，请使用 --provider 选择。");
      const catalog = await this.options.loadWorkspaces();
      await this.create(providerId, selection.workspaceId ?? catalog.defaultWorkspaceId);
    }
    this.status();
  }
  cancel(): void { this.confirmation = undefined; this.active?.abort(); }
  close(): void {
    this.exitRequested = true;
    this.cancel();
    this.options.permissions.closeSession(this.permissionId);
  }
  async handleLine(line: string): Promise<void> {
    try {
      const parsed = parseCliInput(line);
      if (parsed.type === "empty") return;
      if (parsed.type === "command") {
        if (parsed.name === "exit") {
          if (this.unsaved) this.options.renderer.notice("退出后未保存的进程内结果将丢失；磁盘检查点仍保留。");
          this.exitRequested = true; this.cancel(); return;
        }
        if (parsed.name === "cancel") { this.cancel(); return; }
        if (parsed.name === "status") { this.status(); return; }
        if (parsed.name === "approve") { this.approve(parsed.argument); return; }
        if (this.busy) throw new CliInteractionError("当前操作尚未结束，请稍后重试。可使用 /cancel。");
        if (this.unsaved && !["history", "tool", "export", "retry-save", "help"].includes(parsed.name))
          throw new CliInteractionError("本轮尚未保存，请先 /retry-save；退出将丢失进程内未保存结果。");
        if (parsed.name !== "confirm") this.confirmation = undefined;
        const controller = new AbortController();
        this.active = controller;
        try { await this.command(parsed.name, parsed.argument, controller.signal); }
        finally { if (this.active === controller) this.active = undefined; }
      } else {
        if (this.busy) throw new CliInteractionError("正在生成，正文未发送；请结束后重发。");
        await this.run(parsed.text);
      }
    } catch (error) {
      this.options.renderer.error(error instanceof Error ? error.message : "操作失败。");
      if (!this.options.terminal) this.exitCode = 1;
    }
  }
  private current(): ConversationCheckpoint {
    if (!this.checkpoint) throw new CliInteractionError("没有当前会话，请 /new 或 /resume <id>。");
    return this.checkpoint;
  }
  private mutation() {
    const current = this.current();
    return { conversationId: current.summary.id, expectedRevision: current.summary.revision };
  }
  private replace(checkpoint: ConversationCheckpoint): void {
    this.options.permissions.closeSession(this.permissionId);
    this.permissionId = this.options.permissions.createSession().id;
    this.checkpoint = checkpoint;
    this.plan = undefined;
    this.confirmation = undefined;
    this.latestResults.clear();
    this.unsaved = false;
  }
  private async create(providerId: string, workspaceId: string): Promise<void> {
    resolveRuntimeProvider(await this.options.loadConfig(), providerId);
    await resolveWorkspaceBoundary(await this.options.loadWorkspaces(), workspaceId);
    this.replace(await this.options.conversations.create({ providerId, workspaceId }));
    this.interrupted = false;
  }
  private async resume(id: string): Promise<void> {
    const checkpoint = await this.options.conversations.load(id);
    const activity = await this.options.conversations.guard.inspect(id);
    this.replace(checkpoint);
    this.interrupted = activity.status === "interrupted";
    if (activity.status !== "idle") this.options.renderer.notice(`会话状态：${activity.status}；中断时需 /recover，已有副作用不会回滚。`);
    try {
      resolveRuntimeProvider(await this.options.loadConfig(), checkpoint.summary.providerId);
      await resolveWorkspaceBoundary(await this.options.loadWorkspaces(), checkpoint.summary.workspaceId);
    } catch { this.options.renderer.notice("绑定配置不可用，历史可读；恢复有效配置前不能执行。"); }
  }
  private status(): void {
    const c = this.checkpoint;
    this.options.renderer.notice(c ? `会话 ${c.summary.id} revision ${c.summary.revision}；Provider ${c.summary.providerId}；Workspace ${c.summary.workspaceId}；${c.mode.toUpperCase()}；权限 ${this.permissionMode()}；${this.unsaved ? "未保存" : this.busy ? "运行中" : "空闲"}` : "没有当前会话。");
  }
  private permissionMode() {
    try { return this.options.permissions.getSession(this.permissionId).mode; }
    catch {
      this.permissionId = this.options.permissions.createSession().id;
      this.options.renderer.notice("权限会话已过期，旧授权失效，恢复 default 模式。");
      return "default" as const;
    }
  }
  private approve(argument: string): void {
    if (!this.options.terminal) throw new CliInteractionError("非交互输入不能提交人工授权。");
    const [id, scope, extra] = argument.split(/\s+/);
    const choices: Readonly<Record<string, PermissionUserDecision>> = { once: "allow-once", session: "allow-session", permanent: "allow-permanent", deny: "deny" };
    if (!id || !Object.hasOwn(choices, scope) || extra) throw new CliInteractionError("用法：/approve <request-id> <once|session|permanent|deny>");
    this.options.permissions.resolveDecision(this.permissionId, id, choices[scope]);
  }
  private async run(text: string, signal?: AbortSignal): Promise<void> {
    if (this.unsaved) throw new CliInteractionError("本轮尚未保存，请先 /retry-save。");
    if (this.interrupted) throw new CliInteractionError("会话含中断标记，请先 /recover。");
    if (!text.trim() || text.length > 20_000) throw new CliInteractionError("输入必须为 1–20000 个字符。");
    const current = this.current();
    this.permissionMode();
    this.plan = undefined;
    this.confirmation = undefined;
    const controller = new AbortController();
    this.active = controller;
    try {
      const modeTurn = current.modeTurn + 1;
      for await (const item of this.options.runtime.streamTurn({
        conversationId: current.summary.id, expectedRevision: current.summary.revision,
        input: text, mode: current.mode, modeTurn, permissionSessionId: this.permissionId,
        source: "cli", signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      })) {
        this.options.renderer.event(item);
        if (item.type === "agent" && item.event.type === "tool-result")
          this.latestResults.set(item.event.callId, JSON.stringify(item.event.result, null, 2));
        if (item.type === "agent" && item.event.type === "permission-requested" && !this.options.terminal) {
          this.options.renderer.notice("非交互输入无法审批，本次拒绝。");
          this.options.permissions.resolveDecision(this.permissionId, item.event.prompt.requestId, "deny");
        }
        if (item.type === "finished") {
          this.unsaved = item.persistence.status !== "saved";
          if (!this.unsaved) this.checkpoint = await this.options.conversations.load(current.summary.id);
          const id = executablePlanId(current.mode, item.stopped.reason, randomUUID());
          if (id && !this.unsaved) this.plan = { id, revision: this.current().summary.revision };
          if (!this.options.terminal && item.stopped.reason !== "final-response") this.exitCode = 1;
          if (this.unsaved) this.exitCode = 1;
        }
      }
    } finally { if (this.active === controller) this.active = undefined; }
  }
  private async command(name: string, argument: string, signal: AbortSignal): Promise<void> {
    const { renderer, conversations } = this.options;
    switch (name) {
      case "help": renderer.notice(COMMAND_HELP); return;
      case "providers": renderer.content(JSON.stringify(summarizeProviders(await this.options.loadConfig()), null, 2)); return;
      case "workspaces": renderer.content(JSON.stringify((await this.options.loadWorkspaces()).summaries, null, 2)); return;
      case "provider": await this.create(argument, this.current().summary.workspaceId); this.status(); return;
      case "workspace": await this.create(this.current().summary.providerId, argument); this.status(); return;
      case "new": {
        if (this.checkpoint) await this.create(this.checkpoint.summary.providerId, this.checkpoint.summary.workspaceId);
        else await this.initialize({});
        this.status(); return;
      }
      case "conversations": renderer.content(JSON.stringify(await conversations.list(), null, 2)); return;
      case "resume": await this.resume(argument); this.status(); return;
      case "plan": case "do":
        this.checkpoint = await conversations.setMode({ ...this.mutation(), mode: name }); this.plan = undefined; this.status(); return;
      case "execute-plan": {
        const plan = this.plan;
        if (!plan || plan.revision !== this.current().summary.revision) throw new CliInteractionError("没有可执行的最新成功计划。");
        this.checkpoint = await conversations.setMode({ ...this.mutation(), mode: "do" });
        await this.run(PLAN_EXECUTION_PROMPT, signal); return;
      }
      case "permissions":
        if (argument !== "strict" && argument !== "default" && argument !== "permissive") throw new CliInteractionError("权限模式必须为 strict/default/permissive。");
        this.options.permissions.setMode(this.permissionId, argument); this.status(); return;
      case "history": {
        const pending = conversations.manager.pendingSave(this.current().summary.id);
        renderer.content(JSON.stringify(pending?.checkpoint.displayMessages ?? this.current().displayMessages, null, 2)); return;
      }
      case "rename": this.checkpoint = await conversations.rename({ ...this.mutation(), title: argument }); this.plan = undefined; this.status(); return;
      case "clear": case "delete": {
        if (!this.options.terminal) throw new CliInteractionError("清空或删除需要交互确认。");
        const target = name === "clear" ? this.current() : await conversations.load(argument);
        this.confirmation = { kind: name, id: target.summary.id, revision: target.summary.revision, token: randomUUID() };
        renderer.notice(`将${name === "clear" ? "清空" : "删除"} ${target.summary.title} [${target.summary.id}]；/confirm ${this.confirmation.token} 确认，/cancel 放弃。`); return;
      }
      case "confirm": {
        const confirmation = this.confirmation; this.confirmation = undefined;
        if (!confirmation || argument !== confirmation.token) throw new CliInteractionError("确认已失效或不匹配。");
        const input = { conversationId: confirmation.id, expectedRevision: confirmation.revision };
        if (confirmation.kind === "clear") { this.replace(await conversations.clear(input)); this.interrupted = false; }
        else {
          await conversations.delete(input);
          if (this.checkpoint?.summary.id === confirmation.id) {
            const binding = this.checkpoint.summary;
            this.checkpoint = undefined;
            this.plan = undefined;
            await this.create(binding.providerId, binding.workspaceId);
          }
        }
        renderer.notice("操作完成。"); return;
      }
      case "compress": {
        const result = await conversations.compress({ ...this.mutation(), signal });
        this.checkpoint = result.checkpoint; this.plan = undefined;
        renderer.content(JSON.stringify(result.report, null, 2)); return;
      }
      case "retry-save": this.checkpoint = await conversations.retrySave(this.mutation()); this.unsaved = false; this.status(); return;
      case "recover": this.checkpoint = await conversations.recover(this.mutation()); this.interrupted = false; this.plan = undefined; renderer.notice("已恢复磁盘检查点；已有副作用未回滚，不会自动重放。"); return;
      case "tool": {
        const cached = this.latestResults.get(argument);
        const stored = this.current().displayMessages.flatMap((message) => message.toolExecutions ?? []).findLast((tool) => tool.callId === argument);
        if (!cached && !stored) throw new CliInteractionError("当前会话没有该工具结果。");
        const content = cached ?? JSON.stringify(stored?.result, null, 2);
        renderer.content(content);
        const references = new Set(content.match(/context:\/\/v1\/[0-9a-f-]{36}/g) ?? []);
        for (const reference of references) {
          let offset = 0;
          do {
            const chunk = await conversations.store.read({ sessionId: this.current().summary.id,
              reference, offset, limit: 64 * 1024, signal });
            renderer.content(chunk.content);
            if (!chunk.hasMore) break;
            if (chunk.nextOffset <= offset) throw new CliInteractionError("上下文读取没有前进。");
            offset = chunk.nextOffset;
          } while (!signal.aborted);
        }
        return;
      }
      case "export": {
        if (!argument) throw new CliInteractionError("用法：/export <path>");
        if (this.unsaved) {
          const pending = conversations.manager.pendingSave(this.current().summary.id);
          await writeFile(path.resolve(this.options.cwd, argument), JSON.stringify({ format: "orbitcode-unsaved-checkpoint", checkpoint: pending?.checkpoint }, null, 2), { mode: 0o600, flag: "wx" });
        } else {
          const data = await new LocalConversationExporter(this.options.log, conversations.store).createExport(this.current().summary.id);
          await writeFile(path.resolve(this.options.cwd, argument), JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
        }
        renderer.notice("已导出；包含完整对话与工具内容，请按敏感数据保管。"); return;
      }
    }
  }
}
