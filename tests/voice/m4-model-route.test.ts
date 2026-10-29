import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelSelection } from '../../packages/dsh-adapter/src/chat-patch.ts';

test('shared Web model selection copies only safe route fields', () => {
  assert.deepEqual(extractModelSelection('- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    credential: never-copy\n'),
    { provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.equal(extractModelSelection('- id: other\n  config: {provider: deepseek-account, model: deepseek-flash}'), undefined);
  assert.equal(extractModelSelection('- id: agent-default-model\n  config: {provider: "${{ evil }}", model: deepseek-flash}'), undefined);
});
