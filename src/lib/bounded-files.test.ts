import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readBounded, atomicText } from "./bounded-files";
test("有界读取拒绝链接越界、超长和无效 UTF8", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bounded-")), other = await mkdtemp(path.join(os.tmpdir(), "outside-"));
    try {
        await writeFile(path.join(other, "secret"), "outside");
        await symlink(path.join(other, "secret"), path.join(root, "link"));
        await assert.rejects(readBounded(root, path.join(root, "link"), 100));
        await atomicText(root, path.join(root, "x"), "中文");
        assert.equal((await readBounded(root, path.join(root, "x"), 6)).content, "中文");
        await assert.rejects(readBounded(root, path.join(root, "x"), 5));
        await writeFile(path.join(root, "bad"), Buffer.from([255]));
        await assert.rejects(readBounded(root, path.join(root, "bad"), 10));
    }
    finally {
        await rm(root, { recursive: true, force: true });
        await rm(other, { recursive: true, force: true });
    }
});
