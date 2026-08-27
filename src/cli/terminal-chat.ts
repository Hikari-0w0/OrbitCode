import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ConversationSession, TurnEvent } from "@/core/conversation";

type RegisterInterrupt = (listener: () => void) => () => void;

type TerminalChatOptions = {
  readonly session: ConversationSession;
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly terminal: boolean;
  readonly registerInterrupt?: RegisterInterrupt;
};

export async function runTerminalChat({
  session,
  input,
  output,
  errorOutput,
  terminal,
  registerInterrupt = registerProcessInterrupt,
}: TerminalChatOptions): Promise<void> {
  const readline = createInterface({ input, output, terminal });
  let activeController: AbortController | undefined;
  let exiting = false;
  const handleInterrupt = (): void => {
    if (activeController) {
      activeController.abort();
      return;
    }
    exiting = true;
    output.write("\n");
    readline.close();
  };
  const removeInterrupt = registerInterrupt(handleInterrupt);
  // TTY 模式下 readline 会消费 Ctrl-C 并发出自身的 SIGINT 事件，
  // 因此不能只监听 process，否则交互终端中的当前回复无法取消。
  readline.on("SIGINT", handleInterrupt);

  output.write("OrbitCode 已启动。输入 /exit 或按 Ctrl-D 退出。\n");
  writePrompt(output);

  try {
    for await (const line of readline) {
      if (exiting) {
        break;
      }
      const normalized = line.trim();
      if (normalized === "/exit") {
        output.write("再见。\n");
        break;
      }
      if (normalized.length === 0) {
        writePrompt(output);
        continue;
      }

      activeController = new AbortController();
      output.write("助手> ");
      try {
        for await (const event of session.streamTurn(
          line,
          activeController.signal,
        )) {
          writeTurnEvent(event, output, errorOutput);
        }
      } catch {
        output.write("\n");
        errorOutput.write("错误：对话轮次发生未知错误，请重试。\n");
      } finally {
        activeController = undefined;
      }

      if (!exiting) {
        writePrompt(output);
      }
    }
  } finally {
    activeController?.abort();
    readline.off("SIGINT", handleInterrupt);
    removeInterrupt();
    readline.close();
  }
}

function writeTurnEvent(
  event: TurnEvent,
  output: Writable,
  errorOutput: Writable,
): void {
  switch (event.type) {
    case "text-delta":
      output.write(event.text);
      return;
    case "completed":
      output.write("\n");
      return;
    case "cancelled":
      output.write("\n[当前回复已取消]\n");
      return;
    case "failed":
      output.write("\n");
      errorOutput.write(`错误：${event.error.message}\n`);
  }
}

function writePrompt(output: Writable): void {
  output.write("你> ");
}

function registerProcessInterrupt(listener: () => void): () => void {
  process.on("SIGINT", listener);
  return () => process.off("SIGINT", listener);
}
