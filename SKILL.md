---
name: pdf2gep
description: Converts a PDF (local path or URL) into schema-valid GEP (Genome Evolution Protocol) assets for EvoMap. Emits a retrieval-oriented Gene (category=explore) plus a reference Capsule (source_type=reference) with a real asset_id. Does NOT produce execution Capsules; use skill2gep for that.
---

# pdf2gep

Convert a PDF into GEP bundles that can be uploaded to [EvoMap](https://evomap.ai) as retrieval / reference knowledge.

## Scope (read first)

`pdf2gep` is a protocol adapter for *reference* knowledge, not *procedural* knowledge.

pdf2gep 2.0.0 depends on the published SDK 1.14.0 contract ([SDK PR #21](https://github.com/EvoMap/gep-sdk-js/pull/21)). Clean registry-backed dependency installation and Node 18/22 CLI verification pass without a development SDK link. Version 1.x does not include this reference-only contract or the isolated output layout. Do not claim that generated files have been accepted by Hub/Evolver. See the README migration notes before upgrading or publishing assets.

- The emitted Capsule has `source_type = "reference"`, an empty `execution_trace`, and a zero `blast_radius`. `outcome.status = "success"` means only "the chunk was extracted" — it is NOT evidence that the associated Gene has been validated in practice.
- For procedural knowledge (a `SKILL.md` describing a workflow plus real executions), use [`skill2gep`](https://github.com/EvoMap/skill2gep) instead.
- The GEP paper (Wang, Ren, Zhang, arXiv:2604.15097) validates Gene-as-control-interface on 45 code-science tasks. That result does not carry over to retrieval Genes; treat pdf2gep output as retrieval material.

## Usage

```bash
node index.js <pdf_url_or_path>
```

Output: an atomically published `run_<timestamp>_<id>/` directory under `temp/evomap_assets/`, containing `batch.json`, `manifest.json`, and one gene/capsule JSON file per pair. Handled write failures attempt to remove staging without touching earlier completed runs; cleanup failures are reported. Concurrent runs do not overwrite one another. Consumers must ignore hidden `.run_*.tmp` directories left by forced termination, and must migrate root-level batch globs to `run_*/batch.json`. No power-loss durability is promised.

## Workflow

1. **Fetch/Read** -- Download the PDF from URL (browser User-Agent) or read the local file. Record the PDF's sha256.
2. **Extract** -- Use `pdf-parse-fork` to pull out raw text.
3. **Chunk** -- Fixed-width split of ~4000 Unicode code points per chunk (not semantic; see README scope note). Skip whitespace-only layout separators and record each retained chunk's sha256.
4. **Wrap** -- Build an `explore` Gene + `reference_only` Capsule per chunk, validate against the pinned SDK JSON Schema and reference-only classifier, and stamp each with `asset_id` (`computeAssetId`) and the SDK's `schema_version`.
5. **Save** -- Stage batch, manifest, and per-asset files in a private run directory, then atomically rename it into place. Local provenance uses a stable basename reference; HTTP(S) provenance omits credentials, query parameters, and fragments. Document text is not redacted.

Extraction that is empty or whitespace-only fails with an OCR-required error. Chunking is Unicode-safe. The Gene validation command is a self-contained Node.js SHA-256 verifier, so consuming machines do not need a global `pdf2gep` executable.

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
