'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  chunkText,
  fetchPdfBuffer,
  createGene,
  createReferenceCapsule,
  createKnowledgeCapsule,
  processChunk,
  chunkIntegrityCheck,
  loadSdk,
  GENE_ID_PREFIX,
  CAPSULE_ID_PREFIX,
  sha256Hex,
  stableSourceRef,
  describeSource,
  parseCliArgs,
  validateAsset,
  writeOutputs,
} = require('../index');

const pkg = require('../package.json');

// Structural checks complement the public validator and the independent
// schema conformance/differential checks run before release.
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

test('chunkIntegrityCheck is self-contained and verifies piped bytes', () => {
  const { execSync } = require('node:child_process');
  const sha = require('node:crypto').createHash('sha256').update('payload').digest('hex');
  const cmd = chunkIntegrityCheck(sha);
  assert.match(cmd, /^node -e /);
  assert.doesNotMatch(cmd, /pdf2gep verify/);
  execSync(cmd, { cwd: os.tmpdir(), input: 'payload', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.throws(() => execSync(cmd, { cwd: os.tmpdir(), input: 'tampered', stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.throws(() => chunkIntegrityCheck(`${sha}; rm -rf /`), /lowercase 64-character/);
  assert.throws(() => chunkIntegrityCheck(`${sha}\n`), /lowercase 64-character/);
  assert.throws(() => chunkIntegrityCheck({ toString: () => sha }), /lowercase 64-character/);
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

test('reference-only evidence hashes UTF-8 content and keeps local source refs stable', async () => {
  const { gene, capsule } = await processChunk('hé😀', 0, { name: 'manual', path: '/private/secret/manual.pdf', sha256: 'c'.repeat(64) });
  assert.equal(capsule.evidence_mode, 'reference_only');
  assert.equal(capsule.proof_of_work.artifact_hash.sha256, sha256Hex(Buffer.from('hé😀', 'utf8')));
  assert.equal(capsule.proof_of_work.artifact_hash.size, Buffer.byteLength('hé😀', 'utf8'));
  assert.equal(capsule.content.source_ref, 'file:manual.pdf');
  assert.doesNotThrow(() => { validateAsset(gene, 'gene'); validateAsset(capsule, 'capsule'); });
  assert.equal(stableSourceRef({ name: 'manual', path: '/private/secret/manual.pdf' }), 'file:manual.pdf');
  assert.equal(stableSourceRef({ name: 'manual', sourceRef: '/private/secret/manual.pdf' }), 'file:manual.pdf');
});

test('chunkText does not split surrogate pairs', () => {
  assert.deepEqual(chunkText('A😀B', 2), ['A😀', 'B']);
});

test('chunkText skips whitespace-only separators without altering retained chunks', () => {
  assert.deepEqual(chunkText('abcd        efgh', 4), ['abcd', 'efgh']);
  assert.deepEqual(chunkText('a   b   ', 4), ['a   ', 'b   ']);
  assert.deepEqual(chunkText(' \n\t  ', 2), []);
  assert.deepEqual(chunkText('', 4), []);
});

test('generated hashes survive JSON serialization when optional source digest is absent', async () => {
  const { verifyAssetId } = await loadSdk();
  const pair = await processChunk('Optional digest', 0, { name: 'manual' });
  const persisted = JSON.parse(JSON.stringify(pair));
  assert.equal(verifyAssetId(persisted.gene), true);
  assert.equal(verifyAssetId(persisted.capsule), true);
  assert.equal(Object.hasOwn(persisted.capsule.content, 'source_sha256'), false);
});

test('blank chunks are rejected as reference-only evidence', async () => {
  for (const value of ['', ' \n\t']) await assert.rejects(processChunk(value, 0, { name: 'manual' }), /OCR is required/);
});

test('stableSourceRef preserves local basenames without exposing directories', () => {
  assert.equal(stableSourceRef({ path: '/private/secret/manual.pdf' }), 'file:manual.pdf');
  assert.equal(stableSourceRef({ path: './private/manual.pdf' }), 'file:manual.pdf');
  assert.equal(stableSourceRef({ path: '/private/secret/manual.pdf', sourceRef: 'manual-v1' }), 'manual-v1');
  assert.equal(stableSourceRef({ sourceRef: 'file:///private/secret/manual.pdf' }), 'file:manual.pdf');
  assert.equal(stableSourceRef({ sourceRef: 'file://server/share/my%20manual.pdf' }), 'file:my manual.pdf');
  assert.equal(stableSourceRef({ name: 'manual' }), 'file:manual');
  assert.equal(stableSourceRef({}), 'file:pdf');
});

test('URL provenance removes credentials and queries but preserves document identity', async () => {
  const input = 'https://reader:secret@example.com/manual.pdf?token=private#fragment';
  const pair = await processChunk('Reference', 0, { url: input, name: '/private/library/manual.pdf' });
  assert.equal(pair.capsule.content.source_ref, 'https://example.com/manual.pdf');
  assert.equal(stableSourceRef({ sourceRef: input }), 'https://example.com/manual.pdf');
  assert.match(pair.capsule.summary, /from manual /);
  assert.doesNotMatch(JSON.stringify(pair), /secret|token=|fragment|\/private\/library/);
});

test('Windows path provenance is portable on non-Windows hosts', () => {
  for (const value of ['C:\\private\\manual.pdf', '\\\\server\\private\\manual.pdf']) {
    assert.equal(stableSourceRef({ path: value }), 'file:manual.pdf');
    assert.equal(stableSourceRef({ sourceRef: value }), 'file:manual.pdf');
    assert.equal(stableSourceRef({ name: value }), 'file:manual');
  }
});

test('path-only library descriptors retain useful non-sensitive names', () => {
  const source = { path: '/private/secret/manual.pdf', sha256: 'a'.repeat(64) };
  const gene = createGene(source, 0, 'b'.repeat(64), '1.14.0');
  const capsule = createReferenceCapsule(gene, 'payload', 0, source, 'b'.repeat(64), '1.14.0');
  assert.match(gene.id, /^gene_pdf2gep_manual_chunk0_/);
  assert.match(capsule.summary, /from manual \(reference material\)/);
  assert.equal(capsule.content.source_ref, 'file:manual.pdf');
  assert.ok(!JSON.stringify({ gene, capsule }).includes('/private/secret'));
});

test('describeSource retains local input paths for stable provenance', () => {
  assert.deepEqual(describeSource('./private/manual.pdf', 'a'.repeat(64)), {
    name: 'manual',
    url: null,
    path: './private/manual.pdf',
    sha256: 'a'.repeat(64),
  });
  assert.deepEqual(describeSource('https://example.com/docs/manual.pdf', 'b'.repeat(64)), {
    name: 'manual',
    url: 'https://example.com/docs/manual.pdf',
    path: null,
    sha256: 'b'.repeat(64),
  });
});

test('parseCliArgs rejects malformed or incomplete option values', () => {
  const parsed = parseCliArgs(['manual.pdf', '--chunk-size', '200', '--output-dir', './out', '--source-ref', 'manual-v1']);
  assert.equal(parsed.source, 'manual.pdf');
  assert.equal(parsed.chunkSize, 200);
  assert.equal(parsed.outputDir, './out');
  assert.equal(parsed.sourceRefOverride, 'manual-v1');
  for (const value of ['0', '-1', '1.5', 'abc']) {
    assert.throws(() => parseCliArgs(['manual.pdf', '--chunk-size', value]), /positive integer/);
  }
  assert.throws(() => parseCliArgs(['manual.pdf', '--chunk-size']), /requires a value/);
  assert.throws(() => parseCliArgs(['manual.pdf', '--output-dir', '--source-ref', 'manual-v1']), /requires a value/);
});

test('fetchPdfBuffer sends an identifiable browser-compatible user agent', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let options;
  global.fetch = async (_url, receivedOptions) => {
    options = receivedOptions;
    return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  };

  assert.deepEqual(await fetchPdfBuffer('https://example.com/manual.pdf'), Buffer.from([1, 2, 3]));
  assert.match(options.headers['User-Agent'], /^Mozilla\/5\.0/);
  assert.match(options.headers['User-Agent'], /pdf2gep\/2\.0/);
});

test('validateAsset enforces SDK maximum and maxLength constraints', async () => {
  const { capsule } = await processChunk('payload', 0, { name: 'manual', sha256: 'a'.repeat(64) });
  capsule.confidence = 2;
  assert.throws(() => validateAsset(capsule, 'capsule'), /maximum/);
  capsule.confidence = 1;
  capsule.trigger_context = { prompt: 'x'.repeat(2001) };
  assert.throws(() => validateAsset(capsule, 'capsule'), /maxLength/);
});

test('writeOutputs publishes complete isolated run directories atomically', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2gep-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { path: '/private/secret/manual.pdf', sha256: 'a'.repeat(64) };
  const first = writeOutputs([{ gene: { asset_id: `sha256:${'b'.repeat(64)}` }, capsule: { asset_id: `sha256:${'c'.repeat(64)}` } }], root, source);
  const second = writeOutputs([{ gene: { asset_id: `sha256:${'d'.repeat(64)}` }, capsule: { asset_id: `sha256:${'e'.repeat(64)}` } }], root, source);

  assert.notEqual(first.runDir, second.runDir);
  for (const run of [first, second]) {
    assert.ok(fs.statSync(run.runDir).isDirectory());
    assert.ok(fs.statSync(run.batchFile).isFile());
    assert.ok(fs.statSync(run.manifestFile).isFile());
    const manifest = JSON.parse(fs.readFileSync(run.manifestFile, 'utf8'));
    assert.equal(manifest.source.name, 'manual');
    assert.equal(manifest.source.source_ref, 'file:manual.pdf');
    assert.ok(!JSON.stringify(manifest).includes('/private/secret'));
    assert.equal(fs.readdirSync(run.runDir).length, 4);
  }
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);
});

test('writeOutputs removes a partially written staging directory on failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2gep-output-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { name: 'manual', path: './manual.pdf', sha256: 'a'.repeat(64) };
  const assets = [
    { gene: { asset_id: `sha256:${'b'.repeat(64)}` }, capsule: { asset_id: `sha256:${'c'.repeat(64)}` } },
    { gene: {}, capsule: { asset_id: `sha256:${'d'.repeat(64)}` } },
  ];

  assert.throws(() => writeOutputs(assets, root, source));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('processChunk passes the SDK reference-only classifier', async () => {
  const { classifyCapsuleEvidence } = await loadSdk();
  const { capsule } = await processChunk('hé😀', 0, { name: 'manual', path: '/private/secret/manual.pdf', sha256: 'c'.repeat(64) });
  assert.deepEqual(classifyCapsuleEvidence(capsule), { valid: true, mode: 'reference_only', reason: null, reasons: [] });
});
