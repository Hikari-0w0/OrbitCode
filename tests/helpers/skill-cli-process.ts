import path from 'node:path';
import { runCli } from '@/cli/main';
import { LocalConversationStore } from '@/lib/local-conversation-store';
import { LocalAgentRunLog } from '@/lib/local-agent-run-log';
const [root, id] = process.argv.slice(2);
void runCli({ argv: ['--config', path.join(root, 'orbitcode.yaml'), '--resume', id], cwd: root, environment: { FIXTURE_KEY: 'synthetic-fixture-secret' }, input: process.stdin, output: process.stdout, errorOutput: process.stderr, terminal: false, userConfigRoot: path.join(root, '.test-user'), store: new LocalConversationStore(path.join(root, '.conversations')), log: new LocalAgentRunLog(path.join(root, '.logs')) }).then(code => { process.exitCode = code; });
