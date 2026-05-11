'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  chunkText,
  createGene,
  createKnowledgeCapsule,
  processChunk,
  SCHEMA_VERSION,
  GENE_ID_PREFIX,
  CAPSULE_ID_PREFIX,
} = require('../index');

const pkg = require('../package.json');

test('chunkText splits text by chunk size', () => {
  const out = chunkText('abcdefghij', 4);
  assert.deepEqual(out, ['abcd', 'efgh', 'ij']);
});

test('chunkText falls back to default on bad size', () => {
  const out = chunkText('abc', 0);
  assert.equal(out.length, 1);
  assert.equal(out[0], 'abc');
});

test('createGene emits a knowledge_reference Gene with required fields', () => {
  const sourceDesc = {
    name: 'paper',
    url: 'https://example.com/paper.pdf',
    sha256: 'a'.repeat(64),
  };
  const gene = createGene(sourceDesc, 0, 'b'.repeat(64));
  assert.equal(gene.type, 'Gene');
  assert.ok(gene.id.startsWith(GENE_ID_PREFIX));
  assert.equal(gene.category, 'knowledge_reference');
  assert.equal(gene.schema_version, SCHEMA_VERSION);
  assert.deepEqual(gene.validation, []);
  assert.equal(gene._source.source_type, 'pdf_knowledge');
  assert.equal(gene._source.claims_outside_scope, 'knowledge_extraction');
  assert.ok(Array.isArray(gene.signals_match) && gene.signals_match.length > 0);
});

test('createKnowledgeCapsule carries the chunk without forging execution evidence', () => {
  const sourceDesc = { name: 'paper', url: null, path: '/tmp/paper.pdf', sha256: 'a'.repeat(64) };
  const gene = createGene(sourceDesc, 0, 'b'.repeat(64));
  const cap = createKnowledgeCapsule(gene, 'hello world', 0, sourceDesc, 'b'.repeat(64));
  assert.equal(cap.type, 'Capsule');
  assert.ok(cap.id.startsWith(CAPSULE_ID_PREFIX));
  assert.equal(cap.gene, gene.id);
  assert.equal(cap.source_type, 'pdf_knowledge');
  assert.equal(cap.outcome.status, 'knowledge_reference');
  assert.equal(cap.outcome.score, null);
  assert.deepEqual(cap.execution_trace, []);
  assert.equal(cap.blast_radius.files, 0);
  assert.equal(cap.blast_radius.lines, 0);
  assert.equal(cap.blast_radius.chunk_chars, 'hello world'.length);
  assert.equal(cap.content, 'hello world');
});

test('processChunk returns a consistent gene+capsule pair', async () => {
  const sourceDesc = { name: 'paper', url: null, path: '/tmp/paper.pdf', sha256: 'a'.repeat(64) };
  const { gene, capsule } = await processChunk('chunk body', 3, sourceDesc);
  assert.equal(capsule.gene, gene.id);
  assert.equal(gene._source.chunk_index, 3);
  assert.equal(capsule._source.chunk_index, 3);
  assert.equal(gene._source.chunk_sha256, capsule._source.chunk_sha256);
});

test('outcome.status is never "success" for pdf_knowledge capsules', async () => {
  const sourceDesc = { name: 'paper', url: null, path: '/tmp/paper.pdf', sha256: 'a'.repeat(64) };
  const { capsule } = await processChunk('x', 0, sourceDesc);
  assert.notEqual(capsule.outcome.status, 'success');
  assert.notEqual(capsule.outcome.status, 'failed');
});

test('package.json declares the @evomap scope and v1.2.0 bin entry', () => {
  assert.equal(pkg.name, '@evomap/pdf2gep');
  assert.ok(typeof pkg.version === 'string' && pkg.version.length > 0);
  assert.ok(pkg.bin && pkg.bin.pdf2gep, 'bin.pdf2gep must be defined');
  const binTarget = path.resolve(__dirname, '..', pkg.bin.pdf2gep);
  assert.ok(fs.existsSync(binTarget), 'bin target file must exist on disk: ' + binTarget);
});

test('CLI entry has a node shebang so global install can launch it', () => {
  const binPath = path.resolve(__dirname, '..', pkg.bin.pdf2gep);
  const firstLine = fs.readFileSync(binPath, 'utf8').split('\n', 1)[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});
