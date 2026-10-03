import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { englishMessages } from '../src/shared/messages.en.ts';

async function sources(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? sources(join(root, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(root, entry.name)] : [])));
  return nested.flat();
}

test('every static Chinese msg() call and tagged template has an English catalog key', async () => {
  const missing: string[] = [];
  for (const path of await sources(fileURLToPath(new URL('../src', import.meta.url)))) {
    const source = parse(await readFile(path, 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
    const check = (node: any) => {
      if (!node || typeof node !== 'object') return;
      let template: any;
      let key: string | undefined;
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'msg') {
        const arg = node.arguments[0];
        if (arg?.type === 'StringLiteral') key = arg.value;
        else if (arg?.type === 'TemplateLiteral' && !arg.expressions.length) template = arg;
      } else if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && node.tag.name === 'msg') template = node.quasi;
      if (template) key = template.quasis.map((quasi: any, index: number) => `${index ? `{${index - 1}}` : ''}${quasi.value.cooked}`).join('');
      if (key && /\p{Script=Han}/u.test(key) && !Object.hasOwn(englishMessages, key)) missing.push(`${path.split('/src/')[1]}: ${key}`);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(check);
        else if (value && typeof value === 'object' && 'type' in value) check(value);
      }
    };
    check(source);
  }
  assert.deepEqual(missing, []);
});
