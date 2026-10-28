import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [day, output] = process.argv.slice(2);
if (!day || !output || !path.isAbsolute(output)) throw new Error('Usage: node scripts/smoke.mjs YYYY-MM-DD /absolute/private/result.json');
const client = new Client({ name: 'goto-read-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs')], stderr: 'pipe' });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map(t => t.name).sort();
  const expected = ['goto_auth_status', 'goto_get_call_day', 'goto_get_identity'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Unexpected tool surface');
  const parse = response => JSON.parse(response.content.find(x => x.type === 'text').text);
  const auth = parse(await client.callTool({ name: 'goto_auth_status', arguments: {} }));
  const identity = parse(await client.callTool({ name: 'goto_get_identity', arguments: {} }));
  const callDay = parse(await client.callTool({ name: 'goto_get_call_day', arguments: { work_date: day } }));
  const evidence = { collected_at: new Date().toISOString(), tools: names, auth, identity, call_day: callDay };
  await fs.writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await fs.chmod(output, 0o600);
  console.log(JSON.stringify({ protocol: 'MCP stdio', tools: names, authorized: auth.authorized, identity_complete: identity.provenance?.complete, call_status: callDay.status, call_rows: callDay.calls?.length, all_pages_complete: callDay.provenance?.all_pages_complete, source_errors: callDay.provenance?.access_errors, emails_sent: 0, external_record_writes: 0 }));
} finally { await client.close(); }
