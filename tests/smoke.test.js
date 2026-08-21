import test from 'node:test';
import assert from 'node:assert/strict';

test('engineering workspace smoke test', () => {
  assert.equal(typeof process.version, 'string');
});
