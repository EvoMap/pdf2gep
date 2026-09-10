---
name: pdf2gep
description: Converts a PDF (local path or URL) into schema-valid GEP (Genome Evolution Protocol) assets for EvoMap. Emits a retrieval-oriented Gene (category=explore) plus a reference Capsule (source_type=reference) with a real asset_id. Does NOT produce execution Capsules; use skill2gep for that.
---

# pdf2gep

Convert a PDF into GEP bundles that can be uploaded to [EvoMap](https://evomap.ai) as retrieval / reference knowledge.

## Scope (read first)

`pdf2gep` is a protocol adapter for *reference* knowledge, not *procedural* knowledge.

- The emitted Capsule has `source_type = "reference"`, an empty `execution_trace`, and a zero `blast_radius`. `outcome.status = "success"` means only "the chunk was extracted" — it is NOT evidence that the associated Gene has been validated in practice.
- For procedural knowledge (a `SKILL.md` describing a workflow plus real executions), use [`skill2gep`](https://github.com/EvoMap/skill2gep) instead.
- The GEP paper (Wang, Ren, Zhang, arXiv:2604.15097) validates Gene-as-control-interface on 45 code-science tasks. That result does not carry over to retrieval Genes; treat pdf2gep output as retrieval material.

## Usage

```bash
node index.js <pdf_url_or_path>
```

Output: `temp/evomap_assets/` with a backward-compatible `batch_<timestamp>.json`, `manifest.json`, and one publishable gene/capsule JSON file per asset.

## Workflow

1. **Fetch/Read** -- Download the PDF from URL (browser User-Agent) or read the local file. Record the PDF's sha256.
2. **Extract** -- Use `pdf-parse-fork` to pull out raw text.
3. **Chunk** -- Fixed-width split of ~4000 chars per chunk (not semantic; see README scope note). Record each chunk's sha256.
4. **Wrap** -- Build an `explore` Gene + `reference_only` Capsule per chunk, validate each fully against the SDK JSON Schema, and stamp each with `asset_id` (`computeAssetId`) and the SDK's `schema_version`.
5. **Save** -- Write batch, manifest, and per-asset publish files. Local provenance uses a stable basename reference, never an absolute path.

Extraction that is empty or whitespace-only fails with an OCR-required error. Chunking is Unicode-safe. The Gene validation command is the packaged `pdf2gep verify <sha256>` subcommand (not `node -e`).

## Publishing

Use the EvoMap publisher with the generated batch file as its input. This package does not ship or invoke the publisher.

## Dependencies

- `@evomap/gep-sdk` (schema_version + asset_id computation)
- `pdf-parse-fork`
- Node.js 18+ (built-in `fetch`)

## Invariants for consumers

- `source_type === "reference"` on the Capsule
- `execution_trace` is always empty
- `blast_radius.files === 0 && blast_radius.lines === 0`
- `outcome.status === "success"` means "reference extracted", not "task validated" — always read it with `source_type`
- the chunk text + provenance live in the `content` object; `asset_id` verifies under `@evomap/gep-sdk`

Validators that expect execution Capsules MUST filter these out (or treat them explicitly as reference material).
