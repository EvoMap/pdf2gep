#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

// This is a packaged verifier command, not an inline node -e snippet. Evolver can
// invoke `pdf2gep verify <sha256>` and pipe the reference bytes to stdin.
function chunkIntegrityCheck(chunkSha256) { return `pdf2gep verify ${chunkSha256}`; }
function verifyStdin(expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('verify requires a lowercase 64-character sha256');
  const actual = sha256Hex(fs.readFileSync(0));
  if (actual !== expected) { console.error(`sha256 mismatch: expected ${expected}, got ${actual}`); process.exitCode = 1; }
}

async function fetchPdfBuffer(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { 'User-Agent': 'pdf2gep/2' } });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFileSync(source);
}
async function extractText(pdfBuffer) { return (await pdf(pdfBuffer)).text || ''; }
function chunkText(text, size) {
  const chunkSize = Number.isInteger(size) && size > 0 ? size : DEFAULT_CHUNK_SIZE;
  const chars = Array.from(String(text));
  const chunks = [];
  for (let i = 0; i < chars.length; i += chunkSize) chunks.push(chars.slice(i, i + chunkSize).join(''));
  return chunks;
}
function stableSourceRef(sourceDesc) {
  const requested = sourceDesc.sourceRef;
  if (requested && /^https?:\/\//i.test(requested)) return requested;
  if (requested) return path.isAbsolute(requested) ? `file:${path.basename(requested)}` : requested;
  return sourceDesc.url || `file:${sourceDesc.name}`;
}
function createGene(sourceDesc, chunkIndex, chunkSha256, schemaVersion) {
  const slug = slugify(sourceDesc.name || sourceDesc.url || 'pdf');
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
  const sourceName = sourceDesc.name || 'unknown';
  const bytes = Buffer.byteLength(chunk, 'utf8');
  return {
    type: 'Capsule', schema_version: schemaVersion,
    id: `${CAPSULE_ID_PREFIX}${shortHash(chunkSha256)}_${shortHash(gene.id + '|' + chunkIndex)}`,
    gene: gene.id, trigger: gene.signals_match.slice(0, 3),
    summary: `PDF chunk #${chunkIndex} from ${sourceName} (reference material).`,
    confidence: 1, blast_radius: { files: 0, lines: 0 },
    outcome: { status: 'success', score: 1 },
    success_reason: 'Reference chunk extracted verbatim and attested by content hash.',
    env_fingerprint: { platform: process.platform, node: process.version },
    source_type: 'reference', evidence_mode: 'reference_only',
    strategy: gene.strategy.slice(),
    content: { text: chunk, mime: 'text/plain', source_ref: stableSourceRef(sourceDesc), source_sha256: sourceDesc.sha256, chunk_index: chunkIndex, chunk_sha256: chunkSha256, claims_outside_scope: 'knowledge_extraction' },
    proof_of_work: { kind: 'artifact_hash', artifact_hash: { sha256: chunkSha256, mime: 'text/plain', size: bytes } },
    execution_trace: [], diff: null,
  };
}
const createKnowledgeCapsule = createReferenceCapsule;

function schemaPath(name) { return require.resolve(`@evomap/gep-sdk/schemas/${name}`); }
function validateSchema(value, schema, at = '$') {
  const errors = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length && !types.some(t => t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : t === 'array' ? Array.isArray(value) : t === 'null' ? value === null : t === 'integer' ? Number.isInteger(value) : typeof value === t)) errors.push(`${at}: type`);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: const`);
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) errors.push(`${at}: enum`);
  if (typeof value === 'string') { if (schema.minLength && value.length < schema.minLength) errors.push(`${at}: minLength`); if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${at}: pattern`); }
  if (typeof value === 'number') { if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: minimum`); }
  if (Array.isArray(value)) { if (schema.minItems && value.length < schema.minItems) errors.push(`${at}: minItems`); if (schema.maxItems && value.length > schema.maxItems) errors.push(`${at}: maxItems`); if (schema.items) value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${at}[${i}]`))); }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) { if (schema.additionalProperties === false && !schema.properties?.[k]) errors.push(`${at}.${k}: additional`); else if (schema.properties?.[k]) errors.push(...validateSchema(v, schema.properties[k], `${at}.${k}`)); }
  }
  for (const rule of schema.allOf || []) {
    const hit = rule.if?.required?.every(k => value && Object.prototype.hasOwnProperty.call(value, k)) && (!rule.if.properties || Object.entries(rule.if.properties).every(([k, s]) => s.const === undefined || value[k] === s.const));
    if (hit) errors.push(...validateSchema(value, rule.then, at));
  }
  return errors;
}
function validateAsset(asset, name) {
  const schema = JSON.parse(fs.readFileSync(schemaPath(name === 'gene' ? 'gene.schema.json' : 'capsule.schema.json'), 'utf8'));
  const errors = validateSchema(asset, schema);
  if (errors.length) throw new Error(`${name} JSON Schema validation failed: ${errors.join(', ')}`);
}
async function processChunk(chunk, index, sourceDesc) {
  if (!String(chunk).trim()) throw new Error('PDF extraction produced an empty or whitespace-only chunk; OCR is required.');
  const { SCHEMA_VERSION, computeAssetId } = await loadSdk();
  const chunkSha256 = sha256Hex(Buffer.from(chunk, 'utf8'));
  const gene = createGene(sourceDesc, index, chunkSha256, SCHEMA_VERSION);
  gene.asset_id = computeAssetId(gene);
  const capsule = createReferenceCapsule(gene, chunk, index, sourceDesc, chunkSha256, SCHEMA_VERSION);
  capsule.asset_id = computeAssetId(capsule);
  validateAsset(gene, 'gene'); validateAsset(capsule, 'capsule');
  if (!capsule.asset_id || capsule.asset_id !== computeAssetId(capsule)) throw new Error('Capsule asset_id verification failed');
  return { gene, capsule };
}
function safeFileName(id) { return id.replace(/^sha256:/, '').replace(/[^a-zA-Z0-9_.-]/g, '_'); }
function writeOutputs(assets, outputDir, sourceDesc) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const { gene, capsule } of assets) {
    fs.writeFileSync(path.join(outputDir, `gene_${safeFileName(gene.asset_id)}.json`), JSON.stringify(gene, null, 2) + '\n');
    fs.writeFileSync(path.join(outputDir, `capsule_${safeFileName(capsule.asset_id)}.json`), JSON.stringify(capsule, null, 2) + '\n');
  }
  const manifest = { format: 'pdf2gep-manifest-v1', source: sourceDesc, assets: assets.map(({ gene, capsule }) => ({ gene: gene.asset_id, capsule: capsule.asset_id })) };
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const batchFile = path.join(outputDir, `batch_${Date.now()}.json`);
  fs.writeFileSync(batchFile, JSON.stringify(assets, null, 2) + '\n');
  return { batchFile, manifestFile: path.join(outputDir, 'manifest.json') };
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'verify') { try { verifyStdin(args[1]); } catch (err) { console.error(err.message); process.exitCode = 1; } return; }
  if (!args[0]) { console.error('Usage: pdf2gep <pdf_url_or_path> [--chunk-size N] [--output-dir DIR] [--source-ref REF]'); process.exitCode = 1; return; }
  const source = args[0]; let chunkSize = DEFAULT_CHUNK_SIZE; let outputDir = OUTPUT_DIR; let sourceRefOverride;
  for (let i = 1; i < args.length; i++) { if (args[i] === '--chunk-size') chunkSize = Number(args[++i]); else if (args[i] === '--output-dir') outputDir = args[++i]; else if (args[i] === '--source-ref') sourceRefOverride = args[++i]; else throw new Error(`Unknown option: ${args[i]}`); }
  try {
    const buffer = await fetchPdfBuffer(source); const pdfSha256 = sha256Hex(buffer); const isUrl = /^https?:\/\//i.test(source);
    const sourceDesc = { name: path.basename(isUrl ? new URL(source).pathname : source).replace(/\.pdf$/i, '') || 'pdf', url: isUrl ? source : null, sha256: pdfSha256 };
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
module.exports = { extractText, chunkText, createGene, createReferenceCapsule, createKnowledgeCapsule, processChunk, chunkIntegrityCheck, verifyStdin, validateAsset, sha256Hex, loadSdk, GENE_ID_PREFIX, CAPSULE_ID_PREFIX, stableSourceRef };
