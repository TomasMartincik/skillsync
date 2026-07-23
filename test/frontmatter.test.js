import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/frontmatter.js';

test('parses top-level scalars as strings (name/version)', () => {
  const { data, body } = parseFrontmatter('---\nname: grilling\nversion: 1.2\n---\nBODY\n');
  assert.equal(data.name, 'grilling');
  assert.equal(data.version, '1.2');
  assert.equal(body, 'BODY\n');
});

test('quoted strings keep inner content', () => {
  const { data } = parseFrontmatter('---\na: "hello: world"\nb: \'x #y\'\n---\n');
  assert.equal(data.a, 'hello: world');
  assert.equal(data.b, 'x #y');
});

test('comments and blank lines ignored; trailing comment stripped', () => {
  const { data } = parseFrontmatter('---\n# a comment\n\nname: x  # trailing\n---\n');
  assert.equal(data.name, 'x');
});

test('CRLF delimiters accepted', () => {
  const { data } = parseFrontmatter('---\r\nname: y\r\n---\r\nbody');
  assert.equal(data.name, 'y');
});

test('no frontmatter block returns empty data', () => {
  const { data, body } = parseFrontmatter('just text\n');
  assert.deepEqual(data, {});
  assert.equal(body, 'just text\n');
});

test('does NOT eval a ---js block (treated as no frontmatter)', () => {
  const { data } = parseFrontmatter('---js\nmodule.exports = {}\n---\n');
  assert.deepEqual(data, {});
});

test('quoted scalar followed by a trailing comment parses cleanly', () => {
  const { data } = parseFrontmatter('---\nversion: "1.0" # release\n---\n');
  assert.equal(data.version, '1.0');
});

test('a leading UTF-8 BOM does not hide the frontmatter', () => {
  const { data } = parseFrontmatter('﻿---\nname: x\nversion: 1.0\n---\nbody');
  assert.equal(data.name, 'x');
  assert.equal(data.version, '1.0');
});

test('duplicate identity keys are rejected (fail closed)', () => {
  assert.throws(
    () => parseFrontmatter('---\nversion: 1.0\nversion: 2.0\n---\n'),
    (err) => err.code === 'BAD_FRONTMATTER' && /duplicate/.test(err.message),
  );
});

test('exotic YAML elsewhere is accepted, not rejected; name/version still parse', () => {
  // Nested mapping, block scalar, and inline/block sequences are all ignored
  // (their top-level key line records a scalar; indented content is skipped).
  const { data } = parseFrontmatter(
    '---\nname: x\nversion: 1.0\nnested:\n  a: 1\n  b: 2\ndescription: >-\n  one two\n  three\nagents: [claude, codex]\n---\n',
  );
  assert.equal(data.name, 'x');
  assert.equal(data.version, '1.0');
});

test('an unterminated quote does not fail closed (only duplicate identity keys do)', () => {
  assert.doesNotThrow(() => parseFrontmatter('---\ndescription: "oops\nname: x\nversion: 1.0\n---\n'));
  const { data } = parseFrontmatter('---\ndescription: "oops\nname: x\nversion: 1.0\n---\n');
  assert.equal(data.name, 'x');
  assert.equal(data.version, '1.0');
});
