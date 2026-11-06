const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripBom } = require('../src/stripBom');

test('stripBom removes a leading UTF-8 BOM', () => {
  const withBom = '﻿{"a":1}';
  assert.equal(stripBom(withBom), '{"a":1}');
});

test('stripBom leaves BOM-free text untouched', () => {
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
});

test('stripBom handles empty string', () => {
  assert.equal(stripBom(''), '');
});
