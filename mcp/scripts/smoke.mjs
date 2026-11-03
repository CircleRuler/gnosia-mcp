import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['F:/WBAIWorkSpace/chinese_default/gnosia-mcp/dist/index.js'],
  stderr: 'pipe'
});
const client = new Client({ name: 'gnosia-smoke', version: '0.1.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS', tools.tools.length, tools.tools.map((t) => t.name).join(','));

const prompts = await client.listPrompts();
console.log('PROMPTS', prompts.prompts.map((p) => p.name).join(','));

const status = await client.callTool({ name: 'gnosia_status', arguments: {} });
console.log('STATUS', status.content[0].text.slice(0, 700));

const health = await client.callTool({ name: 'gnosia_health', arguments: {} });
const healthData = JSON.parse(health.content[0].text);
console.log('HEALTH ok=', healthData.ok, 'failed=', healthData.failed);

const shot = await client.callTool({ name: 'gnosia_screenshot', arguments: { region: 'dialogue' } });
const kinds = shot.content.map((c) => c.type);
const meta = JSON.parse(shot.content.find((c) => c.type === 'text').text);
console.log('SHOT', kinds, meta.width + 'x' + meta.height, 'bytes=' + meta.bytes, 'luma=' + meta.mean_luma);

const adv = await client.callTool({ name: 'gnosia_advance', arguments: { max_presses: 4 } });
console.log('ADVANCE', adv.content[0].text.replace(/\s+/g, ' ').slice(0, 400));

const after = await client.callTool({ name: 'gnosia_screenshot', arguments: { region: 'dialogue', scale: 1 } });
const afterMeta = JSON.parse(after.content.find((c) => c.type === 'text').text);
console.log('SHOT2', afterMeta.width + 'x' + afterMeta.height, afterMeta.path);

const notes = await client.callTool({ name: 'gnosia_notes_write', arguments: { content: 'loop 1: test note', mode: 'replace' } });
console.log('NOTES', notes.content[0].text.replace(/\s+/g, ' ').slice(0, 200));

const mem = await client.callTool({ name: 'gnosia_memory_write', arguments: { key: 'test', value: 'smoke test', tags: ['smoke'] } });
console.log('MEM', mem.content[0].text.replace(/\s+/g, ' ').slice(0, 160));
const memRead = await client.callTool({ name: 'gnosia_memory_read', arguments: { query: 'smoke' } });
console.log('MEMREAD', memRead.content[0].text.replace(/\s+/g, ' ').slice(0, 200));
await client.callTool({ name: 'gnosia_memory_delete', arguments: { key: 'test' } });

await client.close();
