#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const pdf = require('pdf-parse-fork');

const OUTPUT_DIR = path.join(process.cwd(), 'temp', 'evomap_assets');
const GENE_ID_PREFIX = 'gene_pdf2gep_';
const CAPSULE_ID_PREFIX = 'cap_pdf2gep_';
const DEFAULT_CHUNK_SIZE = 4000;
let _sdkPromise;
function loadSdk() {
  if (!_sdkPromise) _sdkPromise = import('@evomap/gep-sdk').catch((err) => {
    _sdkPromise = null;
    throw new Error(`pdf2gep requires @evomap/gep-sdk. Run npm install first. ${err.message}`);
  });
  return _sdkPromise;
}
function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shortHash(value) { return sha256Hex(Buffer.from(String(value), 'utf8')).slice(0, 12); }
function slugify(value) { return String(value || 'pdf').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'pdf'; }

// Emit a self-contained Node.js verifier so a remote runner only needs Node,
// not a global pdf2gep installation. The hash is validated before interpolation.
function chunkIntegrityCheck(chunkSha256) {
  if (typeof chunkSha256 !== 'string' || chunkSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(chunkSha256)) throw new Error('chunk sha256 must be a lowercase 64-character hex string');
  return "node -e \"const{createHash}=require('node:crypto');const d=require('node:fs').readFileSync(0);" +
    "process.exit(createHash('sha256').update(d).digest('hex')===process.argv[1]?0:1)\" " + chunkSha256;
}
function verifyStdin(expected) {
  if (typeof expected !== 'string' || expected.length !== 64 || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('verify requires a lowercase 64-character sha256');
  const actual = sha256Hex(fs.readFileSync(0));
  if (actual !== expected) { console.error(`sha256 mismatch: expected ${expected}, got ${actual}`); process.exitCode = 1; }
}

async function fetchPdfBuffer(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pdf2gep/2.0; +https://github.com/EvoMap/pdf2gep)' } });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFileSync(source);
}
async function extractText(pdfBuffer) {
  // PDF.js expects Uint8Array semantics; passing a Node Buffer directly can
  // corrupt parsing of small PDFs. Keep the original byte offset without a copy.
  const bytes = Buffer.isBuffer(pdfBuffer)
    ? new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength)
    : pdfBuffer;
  return (await pdf(bytes)).text || '';
}
function chunkText(text, size) {
  const chunkSize = Number.isInteger(size) && size > 0 ? size : DEFAULT_CHUNK_SIZE;
  const chunks = [];
  let current = [];
  for (const char of String(text)) {
    current.push(char);
    if (current.length === chunkSize) {
      const chunk = current.join('');
      if (chunk.trim()) chunks.push(chunk);
      current = [];
    }
  }
  if (current.length) {
    const chunk = current.join('');
    if (chunk.trim()) chunks.push(chunk);
  }
  return chunks;
}
function basenameFromPath(value) { return path.posix.basename(String(value).replace(/\\/g, '/')); }
function isAbsoluteLocalPath(value) { return path.isAbsolute(value) || path.win32.isAbsolute(value); }
function sourceName(sourceDesc) {
  if (sourceDesc.name) return basenameFromPath(sourceDesc.name).replace(/\.pdf$/i, '') || 'pdf';
  if (sourceDesc.path) return basenameFromPath(sourceDesc.path).replace(/\.pdf$/i, '') || 'pdf';
  if (sourceDesc.url) return basenameFromPath(decodeURIComponent(new URL(sourceDesc.url).pathname)).replace(/\.pdf$/i, '') || 'pdf';
  return 'pdf';
}
function sanitizedHttpRef(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}
function stableSourceRef(sourceDesc) {
  const requested = sourceDesc.sourceRef;
  if (requested && /^https?:\/\//i.test(requested)) return sanitizedHttpRef(requested);
  if (requested && /^file:/i.test(requested)) {
    const pathname = decodeURIComponent(new URL(requested).pathname);
    return `file:${basenameFromPath(pathname) || 'pdf'}`;
  }
  if (requested) return isAbsoluteLocalPath(requested) ? `file:${basenameFromPath(requested)}` : requested;
  if (sourceDesc.url) return sanitizedHttpRef(sourceDesc.url);
  if (sourceDesc.path) return `file:${basenameFromPath(sourceDesc.path)}`;
  return `file:${sourceName(sourceDesc)}`;
}
function describeSource(source, sha256) {
  const isUrl = /^https?:\/\//i.test(source);
  const sourcePath = isUrl ? new URL(source).pathname : source;
  return {
    name: path.basename(sourcePath).replace(/\.pdf$/i, '') || 'pdf',
    url: isUrl ? source : null,
    path: isUrl ? null : source,
    sha256,
  };
}
function createGene(sourceDesc, chunkIndex, chunkSha256, schemaVersion) {
  const slug = slugify(sourceName(sourceDesc));
  return {
    type: 'Gene', schema_version: schemaVersion,
    id: `${GENE_ID_PREFIX}${slug}_chunk${chunkIndex}_${chunkSha256.slice(0, 8)}`,
    category: 'explore', signals_match: ['knowledge_lookup', 'pdf_reference', slug],
    preconditions: ['Agent needs to consult the source document to answer or plan.'],
    strategy: ['Retrieve the backing reference Capsule (evidence_mode=reference_only) to read the chunk verbatim.', 'Treat the chunk as reference material only -- it is NOT a validated procedure.'],
    constraints: { max_files: 1, forbidden_paths: ['.git', 'node_modules'] },
    validation: [chunkIntegrityCheck(chunkSha256)],
    summary: `Reference pointer for ${slug} chunk #${chunkIndex} (sha256:${chunkSha256.slice(0, 12)}).`,
  };
}
function createReferenceCapsule(gene, chunk, chunkIndex, sourceDesc, chunkSha256, schemaVersion) {
  const sourceLabel = sourceName(sourceDesc);
  const bytes = Buffer.byteLength(chunk, 'utf8');
  return {
    type: 'Capsule', schema_version: schemaVersion,
    id: `${CAPSULE_ID_PREFIX}${shortHash(chunkSha256)}_${shortHash(gene.id + '|' + chunkIndex)}`,
    gene: gene.id, trigger: gene.signals_match.slice(0, 3),
    summary: `PDF chunk #${chunkIndex} from ${sourceLabel} (reference material).`,
    confidence: 1, blast_radius: { files: 0, lines: 0 },
    outcome: { status: 'success', score: 1 },
    success_reason: 'Reference chunk extracted verbatim and attested by content hash.',
    env_fingerprint: { platform: process.platform, node: process.version },
    source_type: 'reference', evidence_mode: 'reference_only',
    strategy: gene.strategy.slice(),
    content: { text: chunk, mime: 'text/plain', source_ref: stableSourceRef(sourceDesc), ...(sourceDesc.sha256 === undefined ? {} : { source_sha256: sourceDesc.sha256 }), chunk_index: chunkIndex, chunk_sha256: chunkSha256, claims_outside_scope: 'knowledge_extraction' },
    proof_of_work: { kind: 'artifact_hash', artifact_hash: { sha256: chunkSha256, mime: 'text/plain', size: bytes } },
    execution_trace: [], diff: null,
  };
}
const createKnowledgeCapsule = createReferenceCapsule;

function schemaPath(name) { return require.resolve(`@evomap/gep-sdk/schemas/${name}`); }
const schemaCache = new Map();
const supportedSchemaKeywords = new Set([
  '$id', '$schema', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);
function assertSupportedSchema(schema, at = '$') {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) {
    if (!supportedSchemaKeywords.has(key)) throw new Error(`Unsupported JSON Schema keyword ${key} at ${at}`);
  }
  for (const [key, child] of Object.entries(schema.properties || {})) assertSupportedSchema(child, `${at}.properties.${key}`);
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${at}.items`);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') assertSupportedSchema(schema.additionalProperties, `${at}.additionalProperties`);
  for (const key of ['allOf', 'anyOf', 'oneOf']) (schema[key] || []).forEach((child, index) => assertSupportedSchema(child, `${at}.${key}[${index}]`));
  for (const key of ['not', 'if', 'then', 'else']) if (schema[key] !== undefined) assertSupportedSchema(schema[key], `${at}.${key}`);
}
function loadSchema(name) {
  if (!schemaCache.has(name)) {
    const schema = JSON.parse(fs.readFileSync(schemaPath(name), 'utf8'));
    assertSupportedSchema(schema);
    schemaCache.set(name, schema);
  }
  return schemaCache.get(name);
}
function matchesType(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}
function validateSchema(value, schema, at = '$') {
  if (schema === true) return [];
  if (schema === false) return [`${at}: false schema`];
  const errors = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length && !types.some(type => matchesType(value, type))) errors.push(`${at}: type`);
  if (schema.const !== undefined && value !== schema.const && !isDeepStrictEqual(value, schema.const)) errors.push(`${at}: const`);
  if (schema.enum && !schema.enum.some(item => item === value || isDeepStrictEqual(item, value))) errors.push(`${at}: enum`);
  if (schema.anyOf && !schema.anyOf.some(option => validateSchema(value, option, at).length === 0)) errors.push(`${at}: anyOf`);
  if (schema.oneOf && schema.oneOf.filter(option => validateSchema(value, option, at).length === 0).length !== 1) errors.push(`${at}: oneOf`);
  if (schema.not && validateSchema(value, schema.not, at).length === 0) errors.push(`${at}: not`);
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${at}: minLength`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${at}: maxLength`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${at}: pattern`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}: exclusiveMinimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${at}: exclusiveMaximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: maxItems`);
    if (schema.items !== undefined) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${at}[${index}]`)));
  }
  if (matchesType(value, 'object')) {
    for (const required of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, required)) errors.push(`${at}: missing ${required}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key)) errors.push(...validateSchema(item, schema.properties[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: additional`);
      else if (matchesType(schema.additionalProperties, 'object')) errors.push(...validateSchema(item, schema.additionalProperties, `${at}.${key}`));
    }
  }
  for (const rule of schema.allOf || []) errors.push(...validateSchema(value, rule, at));
  if (schema.if !== undefined) {
    const branch = validateSchema(value, schema.if, at).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validateSchema(value, branch, at));
  }
  return errors;
}
function validateAsset(asset, name) {
  const schema = loadSchema(name === 'gene' ? 'gene.schema.json' : 'capsule.schema.json');
  const errors = validateSchema(asset, schema);
  if (errors.length) throw new Error(`${name} JSON Schema validation failed: ${errors.join(', ')}`);
}
async function processChunk(chunk, index, sourceDesc) {
  if (!String(chunk).trim()) throw new Error('PDF extraction produced an empty or whitespace-only chunk; OCR is required.');
  const { SCHEMA_VERSION, computeAssetId, classifyCapsuleEvidence } = await loadSdk();
  const chunkSha256 = sha256Hex(Buffer.from(chunk, 'utf8'));
  const gene = createGene(sourceDesc, index, chunkSha256, SCHEMA_VERSION);
  gene.asset_id = computeAssetId(gene);
  const capsule = createReferenceCapsule(gene, chunk, index, sourceDesc, chunkSha256, SCHEMA_VERSION);
  capsule.asset_id = computeAssetId(capsule);
  validateAsset(gene, 'gene'); validateAsset(capsule, 'capsule');
  const evidence = classifyCapsuleEvidence(capsule);
  if (!evidence.valid || evidence.mode !== 'reference_only') throw new Error(`Capsule reference-only evidence validation failed: ${evidence.reason?.code || 'invalid_evidence'}`);
  return { gene, capsule };
}
function safeFileName(id) { return id.replace(/^sha256:/, '').replace(/[^a-zA-Z0-9_.-]/g, '_'); }
function writeJson(filePath, value) { fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n'); }
function writeOutputs(assets, outputDir, sourceDesc) {
  fs.mkdirSync(outputDir, { recursive: true });
  const runId = `run_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const stagingDir = path.join(outputDir, `.${runId}.tmp`);
  const runDir = path.join(outputDir, runId);
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  try {
    for (const { gene, capsule } of assets) {
      writeJson(path.join(stagingDir, `gene_${safeFileName(gene.asset_id)}.json`), gene);
      writeJson(path.join(stagingDir, `capsule_${safeFileName(capsule.asset_id)}.json`), capsule);
    }
    const source = { name: sourceName(sourceDesc), source_ref: stableSourceRef(sourceDesc), sha256: sourceDesc.sha256 };
    const manifest = { format: 'pdf2gep-manifest-v1', source, assets: assets.map(({ gene, capsule }) => ({ gene: gene.asset_id, capsule: capsule.asset_id })) };
    const manifestFile = path.join(stagingDir, 'manifest.json');
    const batchFile = path.join(stagingDir, 'batch.json');
    writeJson(batchFile, assets);
    writeJson(manifestFile, manifest);
    fs.renameSync(stagingDir, runDir);
    return { runDir, batchFile: path.join(runDir, 'batch.json'), manifestFile: path.join(runDir, 'manifest.json') };
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); }
    catch (cleanupError) {
      throw new AggregateError([err, cleanupError], `${err.message}; staging cleanup failed: ${cleanupError.message}`);
    }
    throw err;
  }
}
function readOptionValue(args, index) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${args[index]} requires a value`);
  return value;
}
function parseCliArgs(args) {
  const parsed = { source: args[0], chunkSize: DEFAULT_CHUNK_SIZE, outputDir: OUTPUT_DIR, sourceRefOverride: undefined };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--chunk-size') {
      const value = readOptionValue(args, i++);
      parsed.chunkSize = Number(value);
      if (!Number.isInteger(parsed.chunkSize) || parsed.chunkSize <= 0) throw new Error('--chunk-size must be a positive integer');
    } else if (args[i] === '--output-dir') parsed.outputDir = readOptionValue(args, i++);
    else if (args[i] === '--source-ref') parsed.sourceRefOverride = readOptionValue(args, i++);
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return parsed;
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'verify') { try { verifyStdin(args[1]); } catch (err) { console.error(err.message); process.exitCode = 1; } return; }
  if (!args[0]) { console.error('Usage: pdf2gep <pdf_url_or_path> [--chunk-size N] [--output-dir DIR] [--source-ref REF]'); process.exitCode = 1; return; }
  try {
    const { source, chunkSize, outputDir, sourceRefOverride } = parseCliArgs(args);
    const buffer = await fetchPdfBuffer(source); const pdfSha256 = sha256Hex(buffer);
    const sourceDesc = describeSource(source, pdfSha256);
    if (sourceRefOverride) sourceDesc.sourceRef = sourceRefOverride;
    const text = await extractText(buffer);
    if (!text.trim()) throw new Error('PDF extraction produced empty or whitespace-only text; OCR is required.');
    const chunks = chunkText(text, chunkSize); const assets = [];
    for (let i = 0; i < chunks.length; i++) assets.push(await processChunk(chunks[i], i, sourceDesc));
    const out = writeOutputs(assets, outputDir, sourceDesc);
    console.log(`Generated ${assets.length} GEP pairs.\nSaved batch to ${out.batchFile}\nSaved manifest to ${out.manifestFile}`);
  } catch (err) { console.error('Error:', err.message || err); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { extractText, fetchPdfBuffer, chunkText, createGene, createReferenceCapsule, createKnowledgeCapsule, processChunk, chunkIntegrityCheck, verifyStdin, validateAsset, writeOutputs, describeSource, parseCliArgs, sha256Hex, loadSdk, GENE_ID_PREFIX, CAPSULE_ID_PREFIX, stableSourceRef };
