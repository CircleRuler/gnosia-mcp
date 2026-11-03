import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['F:/WBAIWorkSpace/chinese_default/gnosia-mcp/dist/index.js'],
  stderr: 'pipe'
});
const client = new Client({ name: 'gnosia-inspect', version: '0.1.0' });
await client.connect(transport);

const instructions = client.getInstructions() ?? '';
console.log('INSTRUCTIONS_CHARS', instructions.length);
console.log('INSTRUCTIONS_HEAD', instructions.split('\n').slice(0, 4).join(' / '));

const tools = await client.listTools();
console.log('TOOLS', tools.tools.length);
for (const tool of tools.tools) {
  console.log(`- ${tool.name} :: ${(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
}

const areas = await client.callTool({ name: 'gnosia_areas', arguments: {} });
console.log('AREAS', String(areas.content[0].text).replace(/\s+/g, ' ').slice(0, 400));

const field = await client.callTool({ name: 'gnosia_field', arguments: { type: 'application.MakeLoopScreen', path: 'yakuNum' } });
console.log('FIELD', String(field.content[0].text).replace(/\s+/g, ' ').slice(0, 300));

const prompt = await client.getPrompt({ name: 'gnosia_playbook' });
const playbook = prompt.messages[0].content.text;
console.log('PLAYBOOK_CHARS', playbook.length);
for (const heading of ['## 0. Read data, not pixels', '## 0.1 Do not drive this game with a mouse', '## 4.10 Character creation', '## 4.11 初期条件設定']) {
  console.log(heading, playbook.includes(heading));
}

const lore = await client.callTool({ name: 'gnosia_lore', arguments: {} });
const loreData = JSON.parse(lore.content[0].text);
console.log('LORE screens=', loreData.total_screens, 'chars=', lore.content[0].text.length, 'notes=', loreData.notes.length);

const skillIndex = await client.callTool({ name: 'gnosia_skills', arguments: {} });
const skillData = JSON.parse(skillIndex.content[0].text);
console.log('SKILLS mode=', skillData.mode, 'total=', skillData.total, 'chars=', skillIndex.content[0].text.length,
  'has_body=', JSON.stringify(skillData.skills[0]).includes('lines'));

const skillOne = await client.callTool({ name: 'gnosia_skills', arguments: { index: 0 } });
console.log('SKILL0', JSON.parse(skillOne.content[0].text).name, skillOne.content[0].text.length, 'chars');

const toc = await client.callTool({ name: 'gnosia_tutorial', arguments: {} });
const tocData = JSON.parse(toc.content[0].text);
console.log('TUTORIAL mode=', tocData.mode, 'total=', tocData.total, 'chars=', toc.content[0].text.length,
  'has_body=', JSON.stringify(tocData.contents[0]).includes('body'));

const onePage = await client.callTool({ name: 'gnosia_tutorial', arguments: { chapter: 1, page: 3 } });
console.log('TUTORIAL_PAGE chars=', onePage.content[0].text.length);

await client.close();
