"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskView } from "@/core/sub-agents/types";
import { startTaskPolling } from "./task-polling";

type TaskSnapshot = {
  readonly conversationId: string;
  readonly count: number;
  readonly tasks: readonly TaskView[];
  readonly usage?: unknown;
  readonly error?: string;
};
const EMPTY_TASKS: readonly TaskView[] = [];

export function useAgentTasks(conversationId: string, details: boolean, streaming: boolean) {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>();
  const poller = useRef<ReturnType<typeof startTaskPolling> | undefined>(undefined);
  useEffect(() => {
    if (!conversationId) return;
    const current = startTaskPolling({
      isVisible: () => document.visibilityState !== "hidden",
      onVisibilityChange: listener => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
      onError: () => setSnapshot(previous => ({ conversationId, count: previous?.conversationId === conversationId ? previous.count : 0, tasks: previous?.conversationId === conversationId ? previous.tasks : EMPTY_TASKS, error: "任务列表读取失败。" })),
      load: async signal => {
        const base = `/api/conversations/${encodeURIComponent(conversationId)}/tasks`;
        const response = await fetch(details ? base : `${base}?view=summary`, { signal });
        if (!response.ok) throw new Error("任务列表读取失败。");
        if (!details) {
          const data: { count: number; running: number } = await response.json();
          if (!Number.isSafeInteger(data.count) || data.count < 0 || !Number.isSafeInteger(data.running) || data.running < 0) throw new Error("任务计数无效。");
          if (!signal.aborted) setSnapshot({ conversationId, count: data.count, tasks: EMPTY_TASKS });
          return { active: streaming || data.running > 0 };
        }
        const data: { tasks: readonly TaskView[]; usage: unknown } = await response.json();
        if (!Array.isArray(data.tasks)) throw new Error("任务列表无效。");
        const count = data.tasks.filter(task => task.state.status !== "terminal" || !["committed", "invalidated"].includes(task.delivery.status)).length;
        if (!signal.aborted) setSnapshot({ conversationId, count, tasks: data.tasks, usage: data.usage });
        return { active: streaming || data.tasks.some(task => task.state.status !== "terminal") };
      },
    });
    poller.current = current;
    return () => { current.stop(); if (poller.current === current) poller.current = undefined; };
  }, [conversationId, details, streaming]);
  const refresh = useCallback(() => poller.current?.refresh(), []);
  return { count: snapshot?.conversationId === conversationId ? snapshot.count : 0,
    tasks: snapshot?.conversationId === conversationId ? snapshot.tasks : EMPTY_TASKS,
    usage: snapshot?.conversationId === conversationId ? snapshot.usage : undefined,
    error: snapshot?.conversationId === conversationId ? snapshot.error : undefined, refresh };
}
