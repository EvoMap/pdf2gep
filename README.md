# pdf2gep

Convert a PDF document into **GEP (Genome Evolution Protocol)** assets suitable for retrieval inside the [EvoMap](https://evomap.ai) network.

`pdf2gep` fetches a PDF (local path or URL), splits the text into chunks, and writes one GEP bundle per chunk:

- An **explore Gene** -- a compact retrieval pointer (`category: "explore"`).
- A **reference Capsule** (`source_type: "reference"`) -- the chunk text itself, carried as reference material.

Both assets are **fully schema-valid GEP** (validated against [`@evomap/gep-sdk`](https://github.com/EvoMap/gep-sdk-js)) and carry a real, Hub-recomputable `asset_id`. Earlier versions used sentinel values (`category: "knowledge_reference"`, `outcome.status: "knowledge_reference"`, a `_source` side-channel) that did not validate against the strict protocol schema — see the v2 note below.

## Honest scope note (please read before using)

`pdf2gep` is a *retrieval-oriented* protocol adapter. It does **not** produce the kind of Capsule that proves a Gene works.

- A standard GEP **Capsule** is an auditable record of one *real execution* of a Gene (`execution_trace` with exit codes, non-zero `blast_radius`, etc.). PDFs contain knowledge, not executions, so `pdf2gep` marks its capsules with the protocol's own reference marker: `source_type = "reference"`, an **empty `execution_trace`**, and a **zero `blast_radius`**. `outcome.status = "success"` here means only "the reference chunk was extracted", not that any task passed. Treating these as proof-of-validation is a misuse.
- The paper that motivates GEP -- *Wang, Ren, Zhang, "From Procedural Skills to Strategy Genes: Towards Experience-Driven Test-Time Evolution"* ([arXiv:2604.15097](https://arxiv.org/abs/2604.15097)) -- validates **Gene-as-control-interface** on 45 scientific code-solving tasks with Gemini 3.1 Pro and Flash Lite. That result does not carry over automatically to retrieval-style knowledge Genes. The Gene emitted by this tool is explicitly a retrieval pointer, not a control interface.
- Chunk quality is naive: fixed-width ~4000-code-point slices, without splitting surrogate pairs. Whitespace-only slices are skipped as layout separators; retained slices are unchanged. This is fine for retrieval-by-topic, but it is not a structured extraction. Do not expect the output to replace a proper RAG ingestion pipeline.

Downstream consumers (EvoMap hub, local agents) should filter on `source_type === "reference"` and treat these Capsules as reference material only.

## Install

> **v2 release contract:** `@evomap/pdf2gep@2.0.0` pins the published `@evomap/gep-sdk@1.14.0` contract from [SDK PR #21](https://github.com/EvoMap/gep-sdk-js/pull/21). Clean registry-backed dependency installation, Node 18/22 regression tests, and installed CLI verification have passed. pdf2gep 1.x does not include this reference-only contract or the isolated output layout; read the migration notes before upgrading. Hub/Evolver acceptance still requires their coordinated reference-only support; generating files does not publish them.

### From npm

```bash
npm install -g @evomap/pdf2gep
```

This installs the `pdf2gep` CLI globally. Requires Node.js 18+ (for built-in `fetch`).

For one-off use, `npx` works without a global install:

```bash
npx @evomap/pdf2gep "https://arxiv.org/pdf/2604.15097.pdf"
```

### Alternative: from source

```bash
git clone https://github.com/EvoMap/pdf2gep.git
cd pdf2gep
npm install
```

## Usage

After `npm install -g @evomap/pdf2gep`:

```bash
# From a URL (arXiv, etc.)
pdf2gep "https://arxiv.org/pdf/2604.15097.pdf"

# From a local file
pdf2gep "./manual.pdf"
```

When working from a source checkout, the equivalent is `node index.js "<url-or-path>"`.

Each conversion is staged and atomically published as an isolated `run_<timestamp>_<id>/` directory under `temp/evomap_assets/` (or the directory passed to `--output-dir`). A completed run contains `batch.json`, `manifest.json`, and one `gene_<asset-id>.json` plus one `capsule_<asset-id>.json` file per pair. Runs do not share mutable files. This intentionally replaces the earlier flat output layout; consumers that globbed the output root must discover `run_*/batch.json` instead. The CLI prints the completed batch and manifest paths.

- **Failure and retry:** handled write/rename failures remove the private staging directory and preserve earlier runs. If cleanup itself fails, both errors are reported. `SIGKILL` or a host crash can leave a hidden `.run_*.tmp` directory; consumers must ignore it. A retry creates a separate run and never deletes another run's staging. Remove an orphan only after confirming that its writer is no longer running. Atomic rename guarantees visibility of complete runs, not power-loss durability (`fsync` is not performed).
- **Provenance:** local paths and `file:` URIs become basename-only references. HTTP(S) references omit credentials, query parameters, and fragments. If a query identifies a distinct document, set a non-secret opaque `--source-ref`, such as `manual-v1`. This sanitizes provenance metadata, not the document's text; review content before publishing.
- **Options:** `--chunk-size` must be a positive integer. Missing option values and unknown options fail before reading the PDF.

```bash
pdf2gep ./manual.pdf --chunk-size 4000 --output-dir ./out --source-ref manual-v1
```

### Library API

`pdf2gep` also exposes its building blocks for programmatic use:

```js
const {
  chunkText,
  createGene,
  createReferenceCapsule, // alias: createKnowledgeCapsule (kept for back-compat)
  processChunk,           // async — computes the asset_id via @evomap/gep-sdk
} = require('@evomap/pdf2gep');
```

`createGene` / `createReferenceCapsule` are pure, synchronous builders (they take a `schemaVersion` argument and do **not** set `asset_id`). `processChunk` is async: it loads `@evomap/gep-sdk`, stamps each asset's `schema_version` from the SDK's `SCHEMA_VERSION`, and computes a Hub-valid `asset_id` via `computeAssetId`. The exported helpers are documented inline in `index.js`.

## Output schema

Assets validate against the pinned `@evomap/gep-sdk@1.14.0` Gene/Capsule schemas; `schema_version` comes from the SDK at runtime. Schemas are loaded once. The local validator implements the keywords used by this pinned contract and rejects unknown keywords rather than silently ignoring future constraints; it is not a general-purpose JSON Schema engine. `processChunk` additionally invokes the SDK reference-only classifier to verify UTF-8 hash/byte-size evidence.

### Gene (`category: "explore"`)

```json
{
  "type": "Gene",
  "schema_version": "<from @evomap/gep-sdk SCHEMA_VERSION>",
  "id": "gene_pdf2gep_<slug>_chunk<N>_<sha8>",
  "category": "explore",
  "signals_match": ["knowledge_lookup", "pdf_reference", "<slug>"],
  "preconditions": ["Agent needs to consult the source document to answer or plan."],
  "strategy": [
    "Retrieve the backing reference Capsule (source_type=reference) to read the chunk verbatim.",
    "Treat the chunk as reference material only -- it is NOT a validated procedure."
  ],
  "constraints": { "max_files": 1, "forbidden_paths": [".git", "node_modules"] },
  "validation": ["node -e \"<self-contained SHA-256 verifier>\" <chunk_sha256>"],
  "summary": "Reference pointer for <slug> chunk #<N> (sha256:<sha12>) extracted from <source>.",
  "asset_id": "sha256:<64 hex>"
}
```

`validation` is a self-contained Node.js reference-integrity check (pipe the chunk in, confirm its sha256 matches); it does not require `pdf2gep` to be installed on the consuming machine. The helper validates the interpolated digest before generating the command, so caller-controlled shell text cannot enter it. This proves the reference is intact, not that a task ran.

### Reference Capsule (`source_type: "reference"`)

```json
{
  "type": "Capsule",
  "schema_version": "<from @evomap/gep-sdk SCHEMA_VERSION>",
  "id": "cap_pdf2gep_<chunk_sha12>_<idkey>",
  "gene": "<gene.id>",
  "trigger": ["knowledge_lookup", "pdf_reference", "<slug>"],
  "summary": "PDF chunk #<N> from <name> (reference material).",
  "confidence": 1,
  "blast_radius": { "files": 0, "lines": 0 },
  "outcome": { "status": "success", "score": 1 },
  "success_reason": "Reference chunk extracted verbatim and attested by content hash.",
  "env_fingerprint": { "platform": "...", "node": "..." },
  "source_type": "reference",
  "strategy": ["...copied from the Gene..."],
  "content": {
    "text": "<chunk text verbatim>",
    "mime": "text/plain",
    "source_ref": "file:manual.pdf",
    "source_sha256": "<sha256 of the whole pdf>",
    "chunk_index": 0,
    "chunk_sha256": "<sha256 of this chunk>",
    "claims_outside_scope": "knowledge_extraction"
  },
  "evidence_mode": "reference_only",
  "proof_of_work": { "kind": "artifact_hash", "artifact_hash": { "sha256": "<sha256 of UTF-8 content.text>", "mime": "text/plain", "size": 123 } },
  "execution_trace": [],
  "asset_id": "sha256:<64 hex>"
}
```

Key invariants validators can rely on:

- `source_type === "reference"` — the canonical marker for extracted/cited knowledge.
- `execution_trace` is empty and `blast_radius` is `{ files: 0, lines: 0 }` — no Gene was executed.
- `outcome.status === "success"` means "reference extracted", **not** "task validated"; always read it together with `source_type`.
- The chunk text and provenance live inside the `content` object (a real object, not a bare string).
- `asset_id` recomputes correctly under `@evomap/gep-sdk`'s `verifyAssetId`.

## Publishing to EvoMap

Use the EvoMap publisher with the generated batch file as its input. The exact publisher command is version-specific; this package does not ship or invoke the publisher.

## v2 migration note

`@evomap/pdf2gep` v2 changes the output format to be **strictly schema-valid GEP**. If you have a consumer built against v1:

| v1 (sentinel, non-conforming) | v2 (schema-valid) |
|---|---|
| `gene.category: "knowledge_reference"` | `gene.category: "explore"` |
| `gene._source.{...}` | provenance moved into `capsule.content.{...}` |
| `gene.validation: []`, `max_files: 0` | a real integrity check; `max_files: 1` |
| `capsule.outcome.status: "knowledge_reference"` | `capsule.outcome.status: "success"` + `source_type: "reference"` |
| `capsule.content: "<string>"` | `capsule.content: { text, ... }` (object) |
| `capsule.source_type: "pdf_knowledge"` | `capsule.source_type: "reference"` |
| `capsule.blast_radius.chunk_chars` | dropped (use `content.text.length`) |
| no `asset_id` | real `asset_id` via `@evomap/gep-sdk` |
| flat `batch_<timestamp>.json` plus shared `manifest.json` | isolated `run_<timestamp>_<id>/batch.json` plus per-run manifest |

Filter on `source_type === "reference"` instead of `"pdf_knowledge"`.

See also:
- Protocol reference: <https://evomap.ai/wiki/16-gep-protocol>
- Skill store (where the Gene shows up): <https://evomap.ai/wiki/31-skill-store>

## Relationship to other tools

- [`skill2gep`](https://github.com/EvoMap/skill2gep) -- protocol adapter that converts `SKILL.md` into Gene+ExecutionCapsule bundles. That tool is for *procedural* knowledge where the Capsule's `execution_trace` comes from real runs. `pdf2gep` is complementary: it covers *reference* knowledge and deliberately does not fabricate execution evidence.
- [kitchen-engineer42/pdf2skills](https://github.com/kitchen-engineer42/pdf2skills) -- prior art that inspired this tool. `pdf2skills` targets Claude Code's `SKILL.md` format; `pdf2gep` targets the GEP protocol and is explicit about being retrieval-only.

## License

MIT. See [LICENSE](./LICENSE).
