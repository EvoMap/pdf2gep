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
- Chunk quality is naive: fixed-width ~4000-char slices. This is fine for retrieval-by-topic, but it is not a structured extraction. Do not expect the output to replace a proper RAG ingestion pipeline.

Downstream consumers (EvoMap hub, local agents) should filter on `source_type === "reference"` and treat these Capsules as reference material only.

## Install

### Recommended: from npm

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

Bundles are written to `temp/evomap_assets/` under the current working directory. The directory contains a backward-compatible `batch_<timestamp>.json`, a `manifest.json`, and one `gene_<asset-id>.json` plus one `capsule_<asset-id>.json` publish file for every asset. Use `--output-dir` to choose another directory. `--source-ref` sets stable provenance explicitly; local inputs otherwise use `file:<basename>` and never embed an absolute path.

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

Assets validate against the published `@evomap/gep-sdk` Gene/Capsule schemas; `schema_version` is taken from the SDK at runtime (so it tracks the installed protocol version rather than being hard-coded).

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
  "validation": ["pdf2gep verify <chunk_sha256>"],
  "summary": "Reference pointer for <slug> chunk #<N> (sha256:<sha12>) extracted from <source>.",
  "asset_id": "sha256:<64 hex>"
}
```

`validation` is a genuinely runnable reference-integrity check (pipe the chunk in, confirm its sha256 matches) — the knowledge analog of a procedural Gene's validation. It proves the reference is intact, not that a task ran.

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
    "source_ref": "file:manual",
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

Filter on `source_type === "reference"` instead of `"pdf_knowledge"`.

See also:
- Protocol reference: <https://evomap.ai/wiki/16-gep-protocol>
- Skill store (where the Gene shows up): <https://evomap.ai/wiki/31-skill-store>

## Relationship to other tools

- [`skill2gep`](https://github.com/EvoMap/skill2gep) -- protocol adapter that converts `SKILL.md` into Gene+ExecutionCapsule bundles. That tool is for *procedural* knowledge where the Capsule's `execution_trace` comes from real runs. `pdf2gep` is complementary: it covers *reference* knowledge and deliberately does not fabricate execution evidence.
- [kitchen-engineer42/pdf2skills](https://github.com/kitchen-engineer42/pdf2skills) -- prior art that inspired this tool. `pdf2skills` targets Claude Code's `SKILL.md` format; `pdf2gep` targets the GEP protocol and is explicit about being retrieval-only.

## License

MIT. See [LICENSE](./LICENSE).
