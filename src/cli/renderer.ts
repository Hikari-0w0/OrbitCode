import type { Writable } from "node:stream";
import type { RuntimeTurnEvent } from "@/runtime/types";
import { TerminalText, terminalText } from "@/cli/terminal-text";

export class TerminalRenderer {
  private readonly text = new TerminalText();
  private streaming = false;
  private phase = "";
  constructor(private readonly output: Writable, private readonly errors: Writable) {}
  notice(message: string): void {
    this.endText();
    this.output.write(`[OrbitCode] ${terminalText(message)}\n`);
  }
  error(message: string): void {
    this.endText();
    this.errors.write(`[OrbitCode 错误] ${terminalText(message)}\n`);
  }
  content(message: string): void {
    this.endText();
    this.output.write(terminalText(message).split("\n").map((line) => `│ ${line}`).join("\n") + "\n");
  }
  event(item: RuntimeTurnEvent): void {
    if (item.type === "warning") { this.error(item.detail); return; }
    if (item.type === "finished") {
      this.phase = "";
      this.notice(`停止：${item.stopped.reason}；${item.stopped.iterations} 轮；${item.stopped.durationMs} ms；副作用：${item.stopped.sideEffect}`);
      if (item.stopped.detail) this.notice(item.stopped.detail);
      if (item.stopped.verification) {
        this.notice("完成验证（仅覆盖所列检查）：");
        this.content(JSON.stringify(item.stopped.verification, null, 2));
      }
      if (item.persistence.status === "saved") this.notice(`已保存 revision ${item.persistence.revision}`);
      else this.error(item.persistence.detail);
      return;
    }
    const event = item.event;
    switch (event.type) {
      case "text-delta": {
        if (!this.streaming) { this.output.write("助手> "); this.streaming = true; }
        this.output.write(this.text.write(event.text).replaceAll("\n", "\n│ "));
        return;
      }
      case "progress": {
        const phase = `${event.iteration}:${event.phase}:${event.model?.stage ?? ""}`;
        if (phase !== this.phase) {
          this.phase = phase;
          this.notice(`第 ${event.iteration} 轮 ${event.phase} ${event.model?.stage ?? ""}`);
        }
        return;
      }
      case "tool-call": this.notice(`工具 ${event.call.name} [${event.call.id}]`); return;
      case "tool-started": this.notice(`执行 ${event.name} [${event.callId}]`); return;
      case "tool-result": {
        this.notice(`${event.name} [${event.callId}] ${event.result.ok ? "成功" : event.result.error.kind}`);
        const text = JSON.stringify(event.result, null, 2);
        this.content(text.length > 2000 ? `${text.slice(0, 2000)}\n… /tool ${event.callId} 查看完整结果` : text);
        return;
      }
      case "permission-requested":
        this.notice(`需要授权 ${event.prompt.toolName}；风险 ${event.prompt.risk.level}；Workspace ${event.prompt.workspace.name}`);
        this.content(JSON.stringify(event.prompt.summary, null, 2));
        this.notice(`/approve ${event.prompt.requestId} <once|session|permanent|deny>（${event.prompt.expiresAt} 到期）`);
        return;
      case "permission-resolved": this.notice(`授权 ${event.requestId}：${event.status} ${event.scope ?? ""}`); return;
      case "token-usage": {
        const format = (usage: typeof event.usage) => usage.availability === "reported"
          ? `输入 ${usage.promptTokens} / 输出 ${usage.completionTokens} / 总计 ${usage.totalTokens}` : "模型未报告";
        this.notice(`Token 本次：${format(event.usage)}；累计：${format(event.cumulative)}`);
      }
    }
  }
  private endText(): void {
    if (this.streaming) this.output.write("\n");
    this.streaming = false;
    this.text.reset();
  }
}
