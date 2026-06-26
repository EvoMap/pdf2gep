#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdf = require('pdf-parse-fork');

// pdf2gep -- convert a PDF into GEP (Genome Evolution Protocol) assets.
//
// SCOPE & HONESTY MODEL (read before reading the code)
// ----------------------------------------------------
// A Capsule in GEP is, by default, an auditable record of one real execution
// of a Gene. PDFs do not contain executions; they contain knowledge. pdf2gep
// must therefore avoid forging execution evidence while still emitting assets
// that pass the strict GEP schema (@evomap/gep-sdk, additionalProperties:false).
//
// Earlier versions sidestepped the schema with sentinel values
// (category="knowledge_reference", outcome.status="knowledge_reference",
// a "_source" side-channel). Those do not validate against the protocol.
//
// This version emits fully schema-valid assets and encodes "this is reference
// material, not an execution" using the protocol's OWN honesty primitives:
//
//   Gene:    category = "explore" (the closest real category for retrieving
//            uncharted reference space). Its `validation` is a genuinely
//            runnable reference-integrity check — the knowledge analog of a
//            procedural Gene's validation, proving the chunk is intact rather
//            than that a task ran.
//
//   Capsule: source_type = "reference"   <- the canonical marker for reference
//            execution_trace = []            material (GEP_SOURCE_TYPES). This
//            blast_radius = {files:0,lines:0}  is the protocol's own mechanism
//            content.claims_outside_scope      for "this capsule did not run a
//                                              Gene"; `reference` exists in the
//            source_type enum precisely for extracted/cited knowledge.
//
// Consumers MUST distinguish reference capsules from execution capsules by
// `source_type === "reference"` (plus the empty execution_trace and zero
// blast_radius). They MUST NOT treat a reference Capsule as proof that a Gene
// was validated on a real task. `outcome.status === "success"` here means only
// "the reference chunk was successfully extracted", not that a task passed.
//
// NOTE: we deliberately stay within the fields the latest evolver emits and
// the currently-published @evomap/gep-sdk schema declares. The 1.11.0
// `proof_of_work` field would be an even stronger attestation, but it is not
// yet published to npm and the reference engine does not emit it, so using it
// would make pdf2gep output fail validation against the installed SDK.

// Configuration
const OUTPUT_DIR = path.join(process.cwd(), 'temp', 'evomap_assets');
const GENE_ID_PREFIX = 'gene_pdf2gep_';
const CAPSULE_ID_PREFIX = 'cap_pdf2gep_';
const DEFAULT_CHUNK_SIZE = 4000;

// @evomap/gep-sdk is the single source of truth for SCHEMA_VERSION and the
// content-addressing algorithm. It ships as ESM; load it once via dynamic
// import so this CommonJS entrypoint can compute Hub-valid asset_ids that the
// Hub will accept under its asset_id recomputation gate (spec §5).
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) {
    _sdkPromise = import('@evomap/gep-sdk').catch((err) => {
      _sdkPromise = null;
      throw new Error(
        'pdf2gep requires @evomap/gep-sdk for asset_id computation. ' +
        'Run `npm install` first. Underlying error: ' + (err && err.message ? err.message : err),
      );
    });
  }
  return _sdkPromise;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shortHash(s) {
  return sha256Hex(Buffer.from(String(s), 'utf8')).slice(0, 12);
}

function slugify(s) {
  return String(s || 'pdf')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'pdf';
}

// A genuinely runnable reference-integrity check: pipe the chunk in and
// confirm its sha256 matches the value the capsule claims. This is the
// knowledge analog of a procedural Gene's validation — it proves the
// retrieved reference is intact, NOT that any task was executed.
//   Usage:  cat chunk.txt | node -e '<cmd>' <chunk_sha256>
function chunkIntegrityCheck(chunkSha256) {
  return "node -e \"const{createHash}=require('crypto');const d=require('fs').readFileSync(0);" +
    "process.exit(createHash('sha256').update(d).digest('hex')===process.argv[1]?0:1)\" " +
    chunkSha256;
}

async function fetchPdfBuffer(pdfSource) {
  if (pdfSource.startsWith('http://') || pdfSource.startsWith('https://')) {
    const response = await fetch(pdfSource, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  }
  return fs.readFileSync(pdfSource);
}

async function extractText(pdfBuffer) {
  const data = await pdf(pdfBuffer);
  return data.text || '';
}

function chunkText(text, size) {
  const chunkSize = Number.isInteger(size) && size > 0 ? size : DEFAULT_CHUNK_SIZE;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Gene builder (pure, synchronous, no asset_id)
//
// We do NOT invent a strategy from PDF chunks -- that would be fabricating
// control knowledge. The Gene declares itself as a retrieval pointer of
// category "explore". asset_id is computed separately in processChunk() via
// the SDK so this builder stays pure and testable without a network install.
// ---------------------------------------------------------------------------
function createGene(sourceDesc, chunkIndex, chunkSha256, schemaVersion) {
  const slug = slugify(sourceDesc.name || sourceDesc.url || sourceDesc.path || 'pdf');
  const sourceRef = sourceDesc.url || sourceDesc.path || 'unknown source';
  return {
    type: 'Gene',
    schema_version: schemaVersion,
    id: GENE_ID_PREFIX + slug + '_chunk' + chunkIndex + '_' + chunkSha256.slice(0, 8),
    category: 'explore',
    signals_match: [
      'knowledge_lookup',
      'pdf_reference',
      slug,
    ],
    preconditions: [
      'Agent needs to consult the source document to answer or plan.',
    ],
    strategy: [
      'Retrieve the backing reference Capsule (source_type=reference) to read the chunk verbatim.',
      'Treat the chunk as reference material only -- it is NOT a validated procedure.',
    ],
    constraints: {
      // Schema requires max_files >= 1. A retrieval pointer edits nothing;
      // forbidden_paths still guards against accidental writes if a consumer
      // ever materializes the reference.
      max_files: 1,
      forbidden_paths: ['.git', 'node_modules'],
    },
    // Reference-integrity check (see chunkIntegrityCheck): proves the chunk is
    // intact, the knowledge analog of procedural validation.
    validation: [chunkIntegrityCheck(chunkSha256)],
    summary: 'Reference pointer for ' + slug + ' chunk #' + chunkIndex +
      ' (sha256:' + chunkSha256.slice(0, 12) + ') extracted from ' + sourceRef + '.',
  };
}

// ---------------------------------------------------------------------------
// Reference Capsule builder (pure, synchronous, no asset_id)
//
// Carries the chunk payload for retrieval. Schema-valid: outcome.status is a
// real value ("success" = "reference extracted"), source_type="reference",
// content is an object holding the chunk + provenance, execution_trace is
// empty and blast_radius is zero -- the protocol's own way of saying "no Gene
// was executed to produce this".
// ---------------------------------------------------------------------------
function createReferenceCapsule(gene, chunk, chunkIndex, sourceDesc, chunkSha256, schemaVersion) {
  const idKey = shortHash(gene.id + '|' + chunkIndex);
  const sourceName = sourceDesc.name || sourceDesc.url || sourceDesc.path || 'unknown';
  return {
    type: 'Capsule',
    schema_version: schemaVersion,
    id: CAPSULE_ID_PREFIX + shortHash(chunkSha256) + '_' + idKey,
    gene: gene.id,
    trigger: gene.signals_match.slice(0, 3),
    summary: 'PDF chunk #' + chunkIndex + ' from ' + sourceName + ' (reference material).',
    // The extraction is deterministic; we are fully confident the chunk is the
    // chunk. This is NOT a claim that a task succeeded.
    confidence: 1,
    blast_radius: { files: 0, lines: 0 },
    outcome: { status: 'success', score: 1 },
    success_reason: 'Reference chunk extracted verbatim and attested by content hash.',
    env_fingerprint: {
      platform: process.platform,
      node: process.version,
    },
    source_type: 'reference',
    strategy: gene.strategy.slice(),
    content: {
      text: chunk,
      mime: 'text/plain',
      source_ref: sourceDesc.url || sourceDesc.path || null,
      source_sha256: sourceDesc.sha256 || null,
      chunk_index: chunkIndex,
      chunk_sha256: chunkSha256,
      claims_outside_scope: 'knowledge_extraction',
    },
    execution_trace: [],
  };
}

// Backward-compatible alias for the pre-1.3.0 builder name.
const createKnowledgeCapsule = createReferenceCapsule;

async function processChunk(chunk, index, sourceDesc) {
  const { SCHEMA_VERSION, computeAssetId } = await loadSdk();
  const chunkSha256 = sha256Hex(Buffer.from(chunk, 'utf8'));
  const gene = createGene(sourceDesc, index, chunkSha256, SCHEMA_VERSION);
  gene.asset_id = computeAssetId(gene);
  const capsule = createReferenceCapsule(gene, chunk, index, sourceDesc, chunkSha256, SCHEMA_VERSION);
  capsule.asset_id = computeAssetId(capsule);
  return { gene, capsule };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node index.js <pdf_url_or_path>');
    process.exit(1);
  }

  const pdfSource = args[0];
  const isUrl = pdfSource.startsWith('http://') || pdfSource.startsWith('https://');
  console.log('Processing PDF: ' + pdfSource + '...');

  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const pdfBuffer = await fetchPdfBuffer(pdfSource);
    const pdfSha256 = sha256Hex(pdfBuffer);
    const sourceDesc = {
      name: path.basename(pdfSource).replace(/\.pdf$/i, ''),
      url: isUrl ? pdfSource : null,
      path: isUrl ? null : path.resolve(pdfSource),
      sha256: pdfSha256,
    };

    const text = await extractText(pdfBuffer);
    console.log('Extracted ' + text.length + ' chars. PDF sha256=' + pdfSha256.slice(0, 16) + '...');

    const chunks = chunkText(text, DEFAULT_CHUNK_SIZE);
    console.log('Split into ' + chunks.length + ' chunks.');

    const assets = [];
    for (let i = 0; i < chunks.length; i++) {
      const asset = await processChunk(chunks[i], i, sourceDesc);
      assets.push(asset);
    }

    const batchFile = path.join(OUTPUT_DIR, 'batch_' + Date.now() + '.json');
    fs.writeFileSync(batchFile, JSON.stringify(assets, null, 2));

    console.log('Generated ' + assets.length + ' GEP pairs (explore Gene + reference Capsule).');
    console.log('Saved to ' + batchFile);
    console.log('');
    console.log('NOTE: These are source_type="reference" capsules, NOT execution Capsules.');
    console.log('      They are valid for retrieval/citation, not as proof that a Gene has');
    console.log('      been validated on a real task (execution_trace is empty by design).');
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractText,
  chunkText,
  createGene,
  createReferenceCapsule,
  createKnowledgeCapsule,
  processChunk,
  chunkIntegrityCheck,
  sha256Hex,
  loadSdk,
  GENE_ID_PREFIX,
  CAPSULE_ID_PREFIX,
};
