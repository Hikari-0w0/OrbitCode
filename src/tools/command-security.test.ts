import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_COMMAND_SECURITY, EVALUATION_COMMAND_SECURITY, parseCommandSecurity } from "@/tools/command-security";
import { createCommandSandbox } from "@/tools/platform-sandbox";
import { createRunCommandTool } from "@/tools/run-command";
import { collectSandboxProtectedEntries } from "@/tools/sandbox-protected-entries";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { SettingsService } from "@/runtime/settings-service";
import { loadProviderContext } from "@/runtime/config";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { isPublicNpmrc } from "@/tools/public-npmrc";

test("命令安全配置兼容旧设置，拒绝无界预算、错误类型与未知开关", () => {
  assert.deepEqual(parseCommandSecurity(undefined), DEFAULT_COMMAND_SECURITY);
  for (const config of [null, [], { network: null }, { environmentFileAccess: "auto" }, { macosAncestorDirectoryAccess: "all" }, { network: "whitelist" }, { defaultTimeoutMs: 0 },
    { defaultTimeoutMs: 300000 }, { maxTimeoutMs: 86400001 }, { maxScanEntries: 0 }, { maxScanEntries: 5000001 },
    { readOnlyRoots: ["relative"] }, { temporaryDirectory: "global" }, { disableSandbox: true }]) assert.throws(() => parseCommandSecurity(config));
  for(const config of [{commandPreflight:"maybe"},{npmrcAccess:"raw"},{preferFileTools:"false"},{maxProcesses:0},{processLogBytes:1},{defaultReadyTimeoutMs:60000},{maxCommandChars:1000000},{writableRoots:["relative"]}])assert.throws(()=>parseCommandSecurity(config));
  assert.deepEqual(parseCommandSecurity(EVALUATION_COMMAND_SECURITY),EVALUATION_COMMAND_SECURITY);
});

test("公开npm配置不预设域名白名单，认证字段与插值仍不能开放", () => {
  assert.equal(isPublicNpmrc("registry=https://auth.registry.example/\nalways-auth=false\nauth-type=web\n"),true);
  for(const content of ["//auth.registry.example/:_authToken=synthetic","registry=https://user:pass@registry.example/","registry=${TOKEN}","registry=https://registry.example/?token=synthetic","# token=synthetic"]){assert.equal(isPublicNpmrc(content),false);}
});

test("托管设置保存安全选项，运行快照不被后续保存污染，环境覆盖显示在工具描述中", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-command-settings-"));
  try {
    const store = new LocalSettingsStore(root); const service = new SettingsService(store);
    const saved = await service.apply(0, { type: "command-security-set", config: { network: "deny", maxTimeoutMs: 600000, maxScanEntries: 1000000, temporaryDirectory: "workspace" } });
    assert.equal(saved.commandSecurity?.network, "deny");
    const context = await loadProviderContext(root, {}, undefined, false, store, false);
    const old = createCommandSandbox({}, process.platform, context.managedSettings?.commandSecurity);
    assert.match(createRunCommandTool(old).description, /网络已关闭/);
    assert.equal(createRunCommandTool(old).inputSchema.parse({ command: "sleep 1", timeout_ms: 300000 }).ok, true);
    await service.apply(1, { type: "command-security-set", config: { network: "allow" } });
    assert.equal((await store.load())?.commandSecurity?.network, "allow");
    assert.equal(old.security?.network, "deny");
    assert.equal(createCommandSandbox({ ORBITCODE_SANDBOX_NETWORK: "allow", ORBITCODE_SANDBOX_READ_ROOTS: '["/opt/toolchain"]' }, process.platform, context.managedSettings?.commandSecurity).security?.network, "allow");
    await assert.rejects(service.apply(2, { type: "command-security-set", config: { maxScanEntries: -1 } }));
    await assert.rejects(service.apply(2, { type: "command-security-set", config: { readOnlyRoots: ["/"] } }));
    await assert.rejects(service.apply(2, { type: "command-security-set", config: { readOnlyRoots: [root] } }), /重叠/);
    await assert.rejects(service.apply(2, { type: "command-security-set", config: { writableRoots: [root] } }), /重叠/);
    await assert.rejects(service.apply(2, { type: "command-security-set", config: { writableRoots: [path.dirname(path.dirname(process.execPath))] } }), /系统/);
    const unopened = new LocalSettingsStore(path.join(root, "future-settings"));
    await assert.rejects(new SettingsService(unopened).apply(0, { type: "command-security-set", config: { readOnlyRoots: [await realpath(root)] } }), /重叠/);
    assert.equal(await unopened.load(), null);
    assert.equal((await store.load())?.revision, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("扩展单命令时限仍受本轮剩余总预算限制", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-command-deadline-"));
  try {
    const workspace = await createWorkspaceBoundary(root); let timeout = 0;
    const tool = createRunCommandTool({ security: parseCommandSecurity({ defaultTimeoutMs: 300000, maxTimeoutMs: 600000 }),
      async probe() { return { available: true }; }, async run(request) { timeout=request.timeoutMs; return { stdout: "ok", stderr: "", exitCode: 0, terminationSignal: null, timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false }; } });
    assert.equal((await tool.execute({ command: "test-command" }, { workspace, signal: new AbortController().signal, deadlineMs: Date.now()+5000 })).ok, true);
    assert.ok(timeout > 0 && timeout <= 5000);
    assert.equal(tool.inputSchema.parse({ command: "test-command", timeout_ms: 600001 }).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("提高扫描容量不跳过依赖目录中的凭据与硬链接保护", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-command-scan-"));
  try {
    await mkdir(path.join(root,"node_modules/package"),{recursive:true});
    await Promise.all(Array.from({length:1001},(_,i)=>writeFile(path.join(root,`file-${i}`),"x")));
    const secret=path.join(root,"node_modules/package/private.key");await writeFile(secret,"synthetic-secret");
    await assert.rejects(collectSandboxProtectedEntries(root,undefined,1000),/超过1000项/);
    assert.ok((await collectSandboxProtectedEntries(root,undefined,2000)).some(entry=>entry.path===secret));
  } finally { await rm(root,{recursive:true,force:true}); }
});
