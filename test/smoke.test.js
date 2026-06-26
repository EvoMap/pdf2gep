'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  chunkText,
  createGene,
  createReferenceCapsule,
  createKnowledgeCapsule,
  processChunk,
  chunkIntegrityCheck,
  loadSdk,
  GENE_ID_PREFIX,
  CAPSULE_ID_PREFIX,
} = require('../index');

const pkg = require('../package.json');

// Minimal JSON-Schema-ish conformance checks against the real @evomap/gep-sdk
// schemas. We don't pull in Ajv (the SDK is zero-dep and so is this package's
// test surface); downstream Ajv consumers do full validation. Here we assert
// the invariants that the old sentinel-based output violated.
function loadSchema(name) {
  const p = require.resolve('@evomap/gep-sdk/schemas/' + name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function assertRequiredAndKnownKeys(obj, schema, label) {
  for (const r of schema.required) {
    assert.ok(r in obj, `${label}: missing required field "${r}"`);
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const k of Object.keys(obj)) {
      assert.ok(allowed.has(k), `${label}: field "${k}" is not allowed (additionalProperties:false)`);
    }
  }
}

test('chunkText splits text by chunk size', () => {
  const out = chunkText('abcdefghij', 4);
  assert.deepEqual(out, ['abcd', 'efgh', 'ij']);
});

test('chunkText falls back to default on bad size', () => {
  const out = chunkText('abc', 0);
  assert.equal(out.length, 1);
  assert.equal(out[0], 'abc');
});

test('createGene emits a schema-valid explore Gene (no sentinel category, no _source)', () => {
  const sourceDesc = { name: 'paper', url: 'https://example.com/paper.pdf', sha256: 'a'.repeat(64) };
  const gene = createGene(sourceDesc, 0, 'b'.repeat(64), '1.11.0');
  assert.equal(gene.type, 'Gene');
  assert.ok(gene.id.startsWith(GENE_ID_PREFIX));
  // Real protocol category, not the old "knowledge_reference" sentinel.
  assert.equal(gene.category, 'explore');
  assert.equal(gene.schema_version, '1.11.0');
  // Schema requires non-empty validation and max_files >= 1.
  assert.ok(Array.isArray(gene.validation) && gene.validation.length >= 1);
  assert.ok(gene.constraints.max_files >= 1);
  assert.ok(Array.isArray(gene.signals_match) && gene.signals_match.length > 0);
  // The side-channel "_source" object is gone.
  assert.ok(!('_source' in gene));
});

test('createReferenceCapsule produces reference material without forging execution evidence', () => {
  const sourceDesc = { name: 'paper', url: null, path: '/tmp/paper.pdf', sha256: 'a'.repeat(64) };
  const gene = createGene(sourceDesc, 0, 'b'.repeat(64), '1.11.0');
  const cap = createReferenceCapsule(gene, 'hello world', 0, sourceDesc, 'b'.repeat(64), '1.11.0');
  assert.equal(cap.type, 'Capsule');
  assert.ok(cap.id.startsWith(CAPSULE_ID_PREFIX));
  assert.equal(cap.gene, gene.id);
  // Honesty is encoded by source_type + empty trace + zero blast_radius, NOT
  // by a sentinel outcome.status.
  assert.equal(cap.source_type, 'reference');
  assert.deepEqual(cap.execution_trace, []);
  assert.equal(cap.blast_radius.files, 0);
  assert.equal(cap.blast_radius.lines, 0);
  // outcome must be a real enum value + numeric score (schema gate).
  assert.equal(cap.outcome.status, 'success');
  assert.equal(typeof cap.outcome.score, 'number');
  assert.equal(typeof cap.confidence, 'number');
  // content is an OBJECT (schema requires object|null), carrying the payload.
  assert.equal(typeof cap.content, 'object');
  assert.equal(cap.content.text, 'hello world');
  assert.equal(cap.content.claims_outside_scope, 'knowledge_extraction');
  // No side-channel "_source"; blast_radius has no extra keys.
  assert.ok(!('_source' in cap));
  assert.ok(!('chunk_chars' in cap.blast_radius));
});

test('createKnowledgeCapsule remains exported as a backward-compatible alias', () => {
  assert.equal(createKnowledgeCapsule, createReferenceCapsule);
});

test('chunkIntegrityCheck is a runnable command that verifies a piped chunk', () => {
  const { execFileSync } = require('node:child_process');
  const sha = require('node:crypto').createHash('sha256').update('payload').digest('hex');
  const cmd = chunkIntegrityCheck(sha);
  assert.match(cmd, /^node -e /);
  // Run it for real: piping the matching content must exit 0.
  const out = execFileSync('bash', ['-c', cmd], { input: 'payload' });
  // (execFileSync throws on non-zero exit; reaching here means exit 0.)
  assert.ok(out !== undefined);
  // A mismatching payload must exit non-zero.
  assert.throws(() => execFileSync('bash', ['-c', cmd], { input: 'tampered' }));
});

test('processChunk returns a conformant gene+capsule pair with valid asset_ids', async () => {
  const { verifyAssetId } = await loadSdk();
  const geneSchema = loadSchema('gene.schema.json');
  const capsuleSchema = loadSchema('capsule.schema.json');

  const sourceDesc = { name: 'paper', url: null, path: '/tmp/paper.pdf', sha256: 'a'.repeat(64) };
  const { gene, capsule } = await processChunk('chunk body', 3, sourceDesc);

  assert.equal(capsule.gene, gene.id);
  // asset_ids are present, well-formed, and self-consistent under the SDK.
  assert.match(gene.asset_id, /^sha256:[a-f0-9]{64}$/);
  assert.match(capsule.asset_id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(verifyAssetId(gene), 'gene asset_id must verify');
  assert.ok(verifyAssetId(capsule), 'capsule asset_id must verify');

  // Structural conformance: required fields present, no disallowed keys.
  assertRequiredAndKnownKeys(gene, geneSchema, 'gene');
  assertRequiredAndKnownKeys(capsule, capsuleSchema, 'capsule');

  // Provenance lives inside content now; gene.validation embeds the same hash.
  assert.equal(capsule.content.chunk_index, 3);
  assert.ok(gene.validation[0].includes(capsule.content.chunk_sha256));
});

test('package.json declares the @evomap scope, gep-sdk dep, and a bin entry', () => {
  assert.equal(pkg.name, '@evomap/pdf2gep');
  assert.ok(typeof pkg.version === 'string' && pkg.version.length > 0);
  assert.ok(pkg.dependencies['@evomap/gep-sdk'], 'must depend on @evomap/gep-sdk');
  assert.ok(pkg.bin && pkg.bin.pdf2gep, 'bin.pdf2gep must be defined');
  const binTarget = path.resolve(__dirname, '..', pkg.bin.pdf2gep);
  assert.ok(fs.existsSync(binTarget), 'bin target file must exist on disk: ' + binTarget);
});

test('CLI entry has a node shebang so global install can launch it', () => {
  const binPath = path.resolve(__dirname, '..', pkg.bin.pdf2gep);
  const firstLine = fs.readFileSync(binPath, 'utf8').split('\n', 1)[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});
