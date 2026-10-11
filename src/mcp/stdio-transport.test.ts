import assert from "node:assert/strict";
import test from "node:test";
import { McpClient } from "./client";
import { McpStdioTransport } from "./stdio-transport";
const options = () => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 2000 });
test("真实 stdio 子进程握手、发现、调用、超时与释放", async () => {
  const client = new McpClient(new McpStdioTransport({ command: process.execPath, args: ["tests/fixtures/mcp/stdio-server.mjs"], env: {}, cwd: process.cwd() }));
  try {
    await client.initialize(options());
    assert.equal((await client.listTools(options()))[0].name, "echo");
    assert.deepEqual((await client.callTool("echo", { text: "ok" }, options())).content, [{ type: "text", text: "ok" }]);
    await assert.rejects(client.callTool("echo", { text: "hang" }, { ...options(), deadlineMs: Date.now() + 30 }), /超时/);
    assert.equal(client.peer.pendingCount, 0);
    await assert.rejects(client.callTool("echo", { text: "malformed" }, options()), /MCP/);
  } finally { await client.close(); }
});

test("stdio 严格 UTF-8 分块、stderr 排空与忽略 TERM 的进程回收", async () => {
  let pid = 0;
  const code = `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);process.stdin.resume();process.stderr.write('fake-secret'.repeat(20000));const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'test',params:{text:'你好',pid:process.pid,arg:process.argv[1]}})+'\\n');for(const c of b)process.stdout.write(Buffer.from([c]));`;
  const transport = new McpStdioTransport({ command: process.execPath, args: ["-e", code, "$(not-a-shell)"], cwd: process.cwd(), env: {} });
  const received = new Promise<void>((resolve) => {
    void transport.start({ message(m) { if ("method" in m) { assert.equal(m.params?.text, "你好"); assert.equal(m.params?.arg, "$(not-a-shell)"); pid = Number(m.params?.pid); resolve(); } }, closed() {} }, new AbortController().signal);
  });
  await received;
  const started = Date.now(); await transport.close();
  assert.ok(Date.now() - started < 4000); assert.throws(() => process.kill(pid, 0));
});

test("stdio 启动失败和请求中进程退出有界收敛", async () => {
  const missing=new McpClient(new McpStdioTransport({command:'/no/such/mcp-executable',args:[],env:{},cwd:process.cwd()}));
  await assert.rejects(missing.initialize(options()));await missing.close();assert.equal(missing.peer.pendingCount,0);
  const client=new McpClient(new McpStdioTransport({command:process.execPath,args:['tests/fixtures/mcp/stdio-server.mjs'],env:{},cwd:process.cwd()}));
  try{await client.initialize(options());await assert.rejects(client.callTool('echo',{text:'exit'},options()));assert.equal(client.peer.pendingCount,0);}finally{await client.close();}
});
