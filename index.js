#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdf = require('pdf-parse-fork');

// pdf2gep -- convert a PDF into GEP (Genome Evolution Protocol) assets.
//
// IMPORTANT SCOPE NOTE (read before reading the code)
// ---------------------------------------------------
// pdf2gep does *not* produce "execution Capsules". A Capsule in GEP is, by
// default, an auditable record of one real execution of a Gene
// (execution_trace + non-zero blast_radius + verified exit codes). PDFs do
// not contain executions; they contain knowledge.
//
// To stay inside the GEP protocol without forging execution evidence, this
// tool emits:
//
//   Gene: category = "knowledge_reference"
//     A compact pointer into a body of knowledge (chapter/section/chunk).
//     `signals_match` tags let an agent retrieve it by topic, and
//     `_source.claims_outside_scope = "knowledge_extraction"` makes the
//     retrieval-only nature explicit to downstream consumers.
//
//   KnowledgeCapsule: source_type = "pdf_knowledge"
//     The knowledge payload itself (a PDF chunk). It deliberately does NOT
//     claim outcome.status = "success", does NOT carry a forged
//     execution_trace, and is marked so EvoMap hub / local validators can
//     route it differently from execution Capsules.
//
// Consumers that expect execution Capsules MUST filter on
// `source_type === "skill2gep_hook"` or an equivalent execution origin;
// they MUST NOT treat a pdf_knowledge Capsule as proof that a Gene has
// been validated in practice.

// Configuration
const OUTPUT_DIR = path.join(process.cwd(), 'temp', 'evomap_assets');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const SCHEMA_VERSION = '1.6.0';
const GENE_ID_PREFIX = 'gene_pdf2gep_';
const CAPSULE_ID_PREFIX = 'cap_pdf2gep_';
const DEFAULT_CHUNK_SIZE = 4000;

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
// Gene builder
//
// We do NOT invent a strategy from PDF chunks -- that would be fabricating
// control knowledge. Instead the Gene declares itself as a retrieval
// pointer. Agents that retrieve it get a handle they can use to look up
// the backing KnowledgeCapsule; they do not get a runnable recipe.
// ---------------------------------------------------------------------------
function createGene(sourceDesc, chunkIndex, chunkSha256) {
  const slug = slugify(sourceDesc.name || sourceDesc.url || sourceDesc.path || 'pdf');
  return {
    type: 'Gene',
    id: GENE_ID_PREFIX + slug + '_chunk' + chunkIndex + '_' + chunkSha256.slice(0, 8),
    category: 'knowledge_reference',
    summary: 'Retrieval pointer for ' + slug + ' chunk #' + chunkIndex,
    signals_match: [
      'knowledge_lookup',
      'pdf_reference',
      slug,
    ],
    preconditions: [
      'Agent needs to consult the source document to answer or plan.',
    ],
    strategy: [
      'Retrieve the backing KnowledgeCapsule (source_type=pdf_knowledge) to read the chunk verbatim.',
      'Do NOT treat the chunk as a validated procedure. It is reference material only.',
    ],
    constraints: {
      max_files: 0,
      forbidden_paths: ['.git', 'node_modules'],
    },
    validation: [],
    schema_version: SCHEMA_VERSION,
    _source: {
      kind: 'pdf2gep',
      source_type: 'pdf_knowledge',
      source_ref: sourceDesc.url || sourceDesc.path || null,
      source_sha256: sourceDesc.sha256 || null,
      chunk_index: chunkIndex,
      chunk_sha256: chunkSha256,
      claims_outside_scope: 'knowledge_extraction',
      paper_scope_note: 'Gene-as-control-interface was validated by arXiv:2604.15097 on code-science tasks. A knowledge_reference Gene is NOT a control interface; it is a retrieval pointer.',
    },
  };
}

// ---------------------------------------------------------------------------
// KnowledgeCapsule builder
//
// The Capsule's ONLY purpose is to carry the chunk payload for retrieval.
// We deliberately set outcome.status = "knowledge_reference" (a sentinel
// that is NOT "success" or "failed") so downstream consumers cannot
// mistake it for an execution record. blast_radius reflects the chunk's
// size in characters so validators can reason about it, but it is not
// evidence that anything was edited or run.
// ---------------------------------------------------------------------------
function createKnowledgeCapsule(gene, chunk, chunkIndex, sourceDesc, chunkSha256) {
  const idKey = shortHash(gene.id + '|' + chunkIndex);
  return {
    type: 'Capsule',
    id: CAPSULE_ID_PREFIX + shortHash(chunkSha256) + '_' + idKey,
    gene: gene.id,
    trigger: gene.signals_match ? gene.signals_match.slice(0, 3) : ['knowledge_lookup'],
    summary: 'PDF chunk #' + chunkIndex + ' from ' + (sourceDesc.name || sourceDesc.url || sourceDesc.path || 'unknown'),
    confidence: null,
    blast_radius: { files: 0, lines: 0, chunk_chars: chunk.length },
    outcome: {
      status: 'knowledge_reference',
      score: null,
    },
    success_reason: null,
    env_fingerprint: {
      platform: process.platform,
      node: process.version,
    },
    source_type: 'pdf_knowledge',
    strategy: gene.strategy ? gene.strategy.slice() : [],
    content: chunk,
    execution_trace: [],
    schema_version: SCHEMA_VERSION,
    _source: {
      source_ref: sourceDesc.url || sourceDesc.path || null,
      source_sha256: sourceDesc.sha256 || null,
      chunk_index: chunkIndex,
      chunk_sha256: chunkSha256,
      claims_outside_scope: 'knowledge_extraction',
    },
  };
}

async function processChunk(chunk, index, sourceDesc) {
  const chunkSha256 = sha256Hex(Buffer.from(chunk, 'utf8'));
  const gene = createGene(sourceDesc, index, chunkSha256);
  const capsule = createKnowledgeCapsule(gene, chunk, index, sourceDesc, chunkSha256);
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

    console.log('Generated ' + assets.length + ' GEP pairs (Gene + KnowledgeCapsule).');
    console.log('Saved to ' + batchFile);
    console.log('');
    console.log('NOTE: These are pdf_knowledge assets, NOT execution Capsules.');
    console.log('      They are valid for retrieval/citation, not as proof that a');
    console.log('      Gene has been validated on a real task. See README.');
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
  createKnowledgeCapsule,
  processChunk,
  sha256Hex,
  SCHEMA_VERSION,
  GENE_ID_PREFIX,
  CAPSULE_ID_PREFIX,
};
