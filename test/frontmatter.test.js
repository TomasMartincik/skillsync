import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/frontmatter.js';

test('parses scalars, booleans, numbers, null', () => {
  const { data, body } = parseFrontmatter(
    '---\nname: grilling\nversion: 1.2\ncount: 3\nenabled: true\noff: false\nnothing: null\n---\nBODY\n',
  );
  assert.equal(data.name, 'grilling');
  assert.equal(data.version, '1.2'); // stays a string (major.minor)
  assert.equal(data.count, 3);
  assert.equal(data.enabled, true);
  assert.equal(data.off, false);
  assert.equal(data.nothing, null);
  assert.equal(body, 'BODY\n');
});

test('quoted strings keep inner content', () => {
  const { data } = parseFrontmatter('---\na: "hello: world"\nb: \'x #y\'\n---\n');
  assert.equal(data.a, 'hello: world');
  assert.equal(data.b, 'x #y');
});

test('inline and block sequences', () => {
  const flow = parseFrontmatter('---\nagents: [claude, codex]\n---\n');
  assert.deepEqual(flow.data.agents, ['claude', 'codex']);
  const block = parseFrontmatter('---\nagents:\n  - claude\n  - codex\n---\n');
  assert.deepEqual(block.data.agents, ['claude', 'codex']);
});

test('comments and blank lines ignored', () => {
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

test('duplicate keys are rejected (fail closed)', () => {
  assert.throws(
    () => parseFrontmatter('---\nversion: 1.0\nversion: 2.0\n---\n'),
    (err) => err.code === 'BAD_FRONTMATTER' && /duplicate/.test(err.message),
  );
});

test('unsupported lines (nested map) are rejected, not silently dropped', () => {
  assert.throws(
    () => parseFrontmatter('---\nname: x\nnested:\n  a: 1\n---\n'),
    (err) => err.code === 'BAD_FRONTMATTER',
  );
});

test('unterminated quotes fail closed', () => {
  assert.throws(() => parseFrontmatter('---\nname: "oops\n---\n'), (err) => err.code === 'BAD_FRONTMATTER');
});

test('quoted commas inside a flow sequence are not split', () => {
  const { data } = parseFrontmatter('---\nitems: ["a,b", c]\n---\n');
  assert.deepEqual(data.items, ['a,b', 'c']);
});
