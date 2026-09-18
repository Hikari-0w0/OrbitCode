import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SessionController } from "@/cli/session-controller";

export async function runTerminalChat(options: {
  readonly session: Pick<SessionController, "busy" | "exitRequested" | "handleLine" | "cancel" | "close"> & { exitCode?: number };
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly terminal: boolean;
  readonly registerInterrupt?: (listener: () => void) => () => void;
}): Promise<void> {
  const { session, input, output, terminal } = options;
  const readline = createInterface({ input, output, terminal });
  const running = new Set<Promise<void>>();
  let serial = Promise.resolve();
  let closed = false;
  const prompt = () => { if (!closed && !session.exitRequested) output.write("你> "); };
  const interrupt = () => {
    if (session.busy) session.cancel();
    else { session.close(); readline.close(); }
  };
  const removeInterrupt = (options.registerInterrupt ?? ((listener) => {
    const processInterrupt = () => {
      if (!session.busy) session.exitCode = 130;
      listener();
    };
    process.on("SIGINT", processInterrupt);
    return () => process.off("SIGINT", processInterrupt);
  }))(interrupt);
  readline.on("SIGINT", interrupt);
  output.write("OrbitCode 已启动。输入 /help 查看命令，/exit 或 Ctrl-D 退出。\n");
  prompt();
  try {
    await new Promise<void>((resolve) => {
      readline.on("line", (line) => {
        const execute = async () => {
          if (session.exitRequested) return;
          await session.handleLine(line);
          if (session.exitRequested) readline.close();
          else if (!session.busy) prompt();
        };
        if (terminal) {
          const work = execute();
          running.add(work);
          void work.finally(() => running.delete(work));
        } else serial = serial.then(execute);
      });
      readline.once("close", () => {
        closed = true;
        // 管线 EOF 不丢弃已读取的完整行；交互 EOF 必须中止等待中的审批。
        if (terminal) session.cancel();
        resolve();
      });
    });
    await serial;
    await Promise.allSettled(running);
  } finally {
    session.close();
    readline.off("SIGINT", interrupt);
    removeInterrupt();
    readline.close();
  }
}
