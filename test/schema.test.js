'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { validateAsset, processChunk } = require('../index');

// Exercise the public validator against an SDK schema replacement without
// modifying node_modules or exporting validator internals. Each test file has
// its own process; the read hook is always restored before the next test.
function withSchema(schema, check) {
  const entry = require.resolve('../index');
  const schemaPath = require.resolve('@evomap/gep-sdk/schemas/gene.schema.json');
  const cached = require.cache[entry];
  const readFileSync = fs.readFileSync;
  delete require.cache[entry];
  try {
    const fresh = require('../index');
    fs.readFileSync = function (file, ...args) {
      return file === schemaPath ? JSON.stringify(schema) : readFileSync.call(this, file, ...args);
    };
    check(value => fresh.validateAsset(value, 'gene'));
  } finally {
    fs.readFileSync = readFileSync;
    require.cache[entry] = cached;
  }
}

test('validator rejects inherited-name additional properties in real SDK assets', async () => {
  const { gene, capsule } = await processChunk('Schema boundary', 0, { name: 'manual' });
  for (const asset of [gene, capsule]) {
    for (const key of ['constructor', 'toString', '__proto__']) {
      const invalid = JSON.parse(JSON.stringify(asset));
      Object.defineProperty(invalid, key, { value: 'unexpected', enumerable: true });
      assert.throws(() => validateAsset(invalid, asset.type.toLowerCase()), /additional/, key);
    }
  }
});

test('validator evaluates false item and property schemas', () => {
  withSchema({ type: 'array', items: false }, validate => {
    assert.doesNotThrow(() => validate([]));
    assert.throws(() => validate([1]), /false schema/);
  });
  withSchema({ type: 'object', properties: { blocked: false }, additionalProperties: true }, validate => {
    assert.doesNotThrow(() => validate({ allowed: 1 }));
    assert.throws(() => validate({ blocked: 1 }), /false schema/);
  });
});

test('validator evaluates false conditional branches and normal allOf clauses', () => {
  withSchema({ if: false, then: true, else: false }, validate => {
    assert.throws(() => validate('value'), /false schema/);
  });
  withSchema({ if: true, then: false }, validate => {
    assert.throws(() => validate('value'), /false schema/);
  });
  withSchema({ allOf: [{ type: 'number' }, { maximum: 1 }] }, validate => {
    assert.doesNotThrow(() => validate(1));
    assert.throws(() => validate(2), /maximum/);
  });
});

test('validator compares object constants and enum values structurally', () => {
  const expected = { first: 1, second: 2 };
  for (const schema of [{ const: expected }, { enum: [expected] }]) {
    withSchema(schema, validate => {
      assert.doesNotThrow(() => validate({ second: 2, first: 1 }));
      assert.throws(() => validate({ first: 1, second: 3 }));
    });
  }
});

test('validator fails closed for unimplemented future SDK keywords', () => {
  for (const schema of [
    { type: 'array', uniqueItems: true },
    { type: 'object', properties: { nested: { minProperties: 1 } } },
    { type: 'object', additionalProperties: { $ref: '#/$defs/item' } },
    { allOf: [{ properties: { nested: { format: 'email' } } }] },
  ]) {
    withSchema(schema, validate => assert.throws(() => validate({}), /Unsupported JSON Schema keyword/));
  }
});

test('validator counts Unicode code points and rejects nonfinite numbers', () => {
  withSchema({ type: 'string', minLength: 2, maxLength: 2 }, validate => {
    assert.doesNotThrow(() => validate('😀好'));
    assert.throws(() => validate('😀'), /minLength/);
    assert.throws(() => validate('😀好a'), /maxLength/);
  });
  withSchema({ type: 'number' }, validate => {
    for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => validate(value), /type/);
  });
  withSchema({ const: 0 }, validate => assert.doesNotThrow(() => validate(-0)));
});
