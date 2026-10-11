import { McpStdioTransport } from '../../../src/mcp/stdio-transport';
import { installMcpShutdown } from '../../../src/runtime/mcp-host';
const transport = new McpStdioTransport({command: process.execPath, args: ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready',params:{pid:process.pid}})+'\\n')`], cwd: process.cwd(), env: {}});
installMcpShutdown(() => transport.close());
if (process.argv[2] === 'immediate') process.on('SIGTERM', () => process.exit(0));
void transport.start({message(m) { if ('method' in m) process.stdout.write(String(m.params?.pid)+'\n'); }, closed() {}}, new AbortController().signal);
