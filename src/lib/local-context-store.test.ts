import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalContextStore } from "@/lib/local-context-store";

test("本地上下文存储按会话写入、分块读取并拒绝跨会话", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-context-"));
  try {
    const store = new LocalContextStore(root);
    const controller = new AbortController();
    const stored = await store.write({
      sessionId: "session-a",
      content: "你好abcdef",
      signal: controller.signal,
    });
    assert.match(stored.reference, /^context:\/\/v1\//);
    const chunk = await store.read({
      sessionId: "session-a",
      reference: stored.reference,
      offset: 0,
      limit: 3,
      signal: controller.signal,
    });
    assert.equal(chunk.content, "你好a");
    assert.equal(chunk.hasMore, true);
    await assert.rejects(store.read({
      sessionId: "session-b",
      reference: stored.reference,
      offset: 0,
      limit: 3,
      signal: controller.signal,
    }), /无效|过期|不属于/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("只清理超过期限且不属于活动会话的孤儿目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-context-"));
  try {
    const store = new LocalContextStore(root);
    const old = path.join(root, "old-session");
    const active = path.join(root, "active-session");
    const recent = path.join(root, "recent-session");
    await Promise.all([
      mkdir(old),
      mkdir(active),
      mkdir(recent),
    ]);
    await Promise.all([
      utimes(old, 1, 1),
      utimes(active, 1, 1),
    ]);
    const removed = await store.cleanupExpiredSessions({
      olderThanMs: 1_000,
      protectedSessionIds: new Set(["active-session"]),
      now: 2_000_000,
    });
    assert.equal(removed, 1);
    await assert.rejects(access(old));
    await access(active);
    await access(recent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("拒绝路径形式和符号链接引用", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-context-"));
  try {
    const store = new LocalContextStore(root);
    const signal = new AbortController().signal;
    await assert.rejects(store.read({
      sessionId: "session",
      reference: "../../secret",
      offset: 0,
      limit: 1,
      signal,
    }));
    const stored = await store.write({ sessionId: "session", content: "safe", signal });
    const objectId = stored.reference.split("/").at(-1);
    assert.ok(objectId);
    const target = path.join(root, "session", `${objectId}.txt`);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside");
    await rm(target);
    await symlink(outside, target);
    await assert.rejects(store.read({
      sessionId: "session",
      reference: stored.reference,
      offset: 0,
      limit: 4,
      signal,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
