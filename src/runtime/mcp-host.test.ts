import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
for (const mode of ['SIGINT', 'SIGTERM', 'immediate'] as const) test(`宿主 ${mode} 后不遗留 MCP 子进程`, async () => {
  const host = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/mcp/host.ts', mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pid = 0;
  try {
    const [chunk] = await once(host.stdout, 'data'); pid = Number(chunk.toString().trim()); assert.ok(pid > 0);
    const exited = once(host, 'exit'); host.kill(mode === 'immediate' ? 'SIGTERM' : mode); await exited;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return; } await new Promise(r => setTimeout(r, 10)); }
    assert.fail('MCP 子进程未回收');
  } finally { host.kill('SIGKILL'); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});
