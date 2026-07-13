import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSkillName, assertSkillName } from '../src/skill-name.js';

test('accepts valid Agent Skills names', () => {
  for (const n of ['grilling', 'a', 'a-b', 'foo-bar-baz', 'skill1', 'a1-b2']) {
    assert.ok(isValidSkillName(n), n);
  }
});

test('rejects path-unsafe and mal-formed names', () => {
  for (const n of ['.', '..', 'a/b', 'a\\b', 'A', 'Foo', 'a_b', '', '-a', 'a-', 'a--b', 'a b', ' a', 'x'.repeat(65)]) {
    assert.ok(!isValidSkillName(n), n);
    assert.throws(() => assertSkillName(n), (err) => err.code === 'BAD_SKILL_NAME');
  }
});

test('rejects non-strings', () => {
  assert.ok(!isValidSkillName(null));
  assert.ok(!isValidSkillName(42));
  assert.ok(!isValidSkillName(undefined));
});
