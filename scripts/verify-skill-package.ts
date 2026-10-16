import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import ts from "typescript";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { record } from "@/runtime/skills/definition";

async function main() {
    const project = process.cwd();
    const evidence = path.resolve(process.argv[2] ?? `tmp/agent-evals/skill-package-${Date.now()}`);
    const data = path.join(evidence, "data"), workspace = path.join(evidence, "workspace");
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const traceFile = path.join(project, ".next/server/app/api/conversations/[conversationId]/skills/route.js.nft.json");
    const trace: unknown = JSON.parse(await readFile(traceFile, "utf8"));
    assert.ok(record(trace) && Array.isArray(trace.files));
    const tracePaths = trace.files.map(file => { assert.ok(typeof file === "string"); return path.relative(project, path.resolve(path.dirname(traceFile), file)); });
    const forbidden = tracePaths.filter(file => /(^|\/)\.env(?:\.|$)|^\.orbitcode\/|^tmp\/|^src\/|^orbitcode(?:\.workspaces)?\.yaml$/.test(file));
    await writeFile(path.join(evidence, "trace-audit.json"), JSON.stringify({ entries: tracePaths.length, forbidden, builtins: tracePaths.filter(file => /^skills\//.test(file)) }, null, 2));
    assert.deepEqual(forbidden, [], "生产文件跟踪清单不能夹带本地配置、临时数据或仓库源码。");
    for (const name of ["commit", "review", "test"]) assert.ok(tracePaths.includes(`skills/${name}/SKILL.md`));
    console.log("trace-audit-passed");
    const bundle = await mkdtemp(path.join(os.tmpdir(), "orbitcode-skill-package-"));
    assert.ok(path.relative(project, bundle).startsWith(".."), "隔离包必须脱离仓库祖先目录，避免 Next 向上查找本地配置。");
    await cp(path.join(project, ".next"), path.join(bundle, ".next"), { recursive: true, filter: source => ![path.join(project, '.next/cache'), path.join(project, '.next/dev')].some(excluded => source === excluded || source.startsWith(excluded + path.sep)), mode: constants.COPYFILE_FICLONE });
    await cp(path.join(project, "node_modules"), path.join(bundle, "node_modules"), { recursive: true, mode: constants.COPYFILE_FICLONE });
    await cp(path.join(project, "skills"), path.join(bundle, "skills"), { recursive: true });
    await writeFile(path.join(bundle, "package.json"), JSON.stringify({ name: "orbitcode-package-verification", version: "1.0.0", private: true }));
    const token = "PACKAGE_COPY_627";
    const commitFile = path.join(bundle, "skills/commit/SKILL.md");
    await writeFile(commitFile, (await readFile(commitFile, "utf8")).replace("description: ", `description: ${token} `));
    let compiledFiles = 0;
    async function compile(directory: string) {
        for (const item of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, item.name);
            if (item.isDirectory()) await compile(file);
            else if (/\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file)) {
                const relative = path.relative(path.join(project, 'src'), file).replace(/\.tsx?$/, '.js');
                const target = path.join(bundle, 'dist', relative);
                const output = ts.transpileModule(await readFile(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, output.outputText);
                compiledFiles++;
            }
        }
    }
    await compile(path.join(project, "src"));
    await writeFile(path.join(bundle, "dist/package.json"), '{"type":"module"}');
    await writeFile(path.join(bundle, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./dist/*"] } } }));
    await mkdir(workspace, { recursive: true });
    await new LocalSettingsStore(data).save(0, { schemaVersion: 1, providers: [{ id: "package", displayName: "隔离包测试", model: "synthetic-package-model", baseUrl: "http://127.0.0.1:9/v1", credential: { kind: "environment", variable: "SKILL_PACKAGE_SYNTHETIC_KEY" }, enabled: true, context: { windowTokens: 128000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 } }], workspaces: [{ id: "workspace", name: "包验证工作区", rootPath: workspace, enabled: true }], mcpServers: [], defaultProviderId: "package", defaultWorkspaceId: "workspace" });
    const checkpoint = await new LocalConversationStore(path.join(data, "conversations-v1")).create({ providerId: "package", workspaceId: "workspace" });
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", ORBITCODE_DATA_DIR: data, SKILL_PACKAGE_SYNTHETIC_KEY: "synthetic-package-key", TSX_TSCONFIG_PATH: path.join(bundle, 'tsconfig.json') };
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[key]) environment[key] = process.env[key];
    for (const forbidden of ['src', '.env', 'orbitcode.yaml', '.orbitcode']) await assert.rejects(access(path.join(bundle, forbidden)));
    const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(() => resolve(address.port)); }); });
    const server = spawn(process.execPath, [path.join(bundle, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: bundle, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const exited = new Promise<void>(resolve => server.once('close', () => resolve()));
    let stdout = '', stderr = '';
    server.stdout.on('data', chunk => { stdout += chunk.toString(); }); server.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const url = `http://127.0.0.1:${port}`;
    try {
        let response: Response | undefined;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (server.exitCode !== null) throw new Error('隔离包服务器提前退出。');
            try { response = await fetch(`${url}/api/conversations/${checkpoint.summary.id}/skills`); if (response.ok) break; } catch { /* 等待本任务服务器监听。 */ }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(response?.ok, '生产包的 Skill API 未就绪。');
        const catalog: unknown = await response.json();
        assert.ok(record(catalog) && Array.isArray(catalog.entries));
        assert.deepEqual(catalog.entries.map(entry => { assert.ok(record(entry)); return entry.name; }).sort(), ['commit', 'review', 'test']);
        assert.ok(catalog.entries.some(entry => record(entry) && entry.name === 'commit' && typeof entry.description === 'string' && entry.description.includes(token)));
        await writeFile(path.join(evidence, 'production-catalog.json'), JSON.stringify(catalog, null, 2));
        const page = await fetch(url);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /OrbitCode/);
        const cli = spawn(process.execPath, ['--import', path.join(bundle, 'node_modules/tsx/dist/loader.mjs'), path.join(bundle, 'dist/cli/main.js'), '--data-dir', data, '--resume', checkpoint.summary.id], { cwd: workspace, env: environment, stdio: 'pipe', detached: true });
        let cliOutput = '', cliErrors = '';
        cli.stdout.on('data', chunk => { cliOutput += chunk.toString(); }); cli.stderr.on('data', chunk => { cliErrors += chunk.toString(); });
        const cliDeadline = setTimeout(() => { try { if (cli.pid) process.kill(-cli.pid, 'SIGKILL'); } catch { } }, 20000);
        cli.stdin.end('/skills\n/exit\n');
        const cliExit = await new Promise<number | null>(resolve => cli.once('close', resolve));
        clearTimeout(cliDeadline);
        await writeFile(path.join(evidence, 'cli.txt'), cliOutput + '\n' + cliErrors);
        assert.equal(cliExit, 0, cliErrors);
        for (const name of ['commit', 'review', 'test', token]) assert.ok(cliOutput.includes(name));
        await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, bundle, port, conversationId: checkpoint.summary.id, sourceDirectoryPresent: false, localConfigurationPresent: false, compiledFiles, webBuiltins: ['commit', 'review', 'test'], cliExit, builtinCopyMarker: token }, null, 2));
        console.log(JSON.stringify({ passed: true, port, compiledFiles, cliExit, evidence }));
    } finally {
        try { if (server.pid) process.kill(-server.pid, 'SIGTERM'); } catch { }
        const force = setTimeout(() => { try { if (server.pid) process.kill(-server.pid, 'SIGKILL'); } catch { } }, 3000);
        await exited; clearTimeout(force);
        await writeFile(path.join(evidence, 'server.txt'), stdout + '\n' + stderr);
    }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '隔离包验证失败'); process.exitCode = 1; });
