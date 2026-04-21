# pdf2gep

Convert a PDF document into **GEP (Genome Evolution Protocol)** assets suitable for retrieval inside the [EvoMap](https://evomap.ai) network.

`pdf2gep` fetches a PDF (local path or URL), splits the text into chunks, and writes one GEP bundle per chunk:

- A **Gene** of category `knowledge_reference` -- a compact retrieval pointer.
- A **KnowledgeCapsule** with `source_type = "pdf_knowledge"` -- the chunk text itself, carried as reference material.

## Honest scope note (please read before using)

`pdf2gep` is a *retrieval-oriented* protocol adapter. It does **not** produce the kind of Capsule that proves a Gene works.

- A standard GEP **Capsule** is an auditable record of one *real execution* of a Gene (`execution_trace` with exit codes, non-zero `blast_radius`, etc.). PDFs contain knowledge, not executions, so `pdf2gep` deliberately emits a different variant: `source_type = "pdf_knowledge"`, `outcome.status = "knowledge_reference"`, and an empty `execution_trace`. Treating these as proof-of-validation is a misuse.
- The paper that motivates GEP -- *Wang, Ren, Zhang, "From Procedural Skills to Strategy Genes: Towards Experience-Driven Test-Time Evolution"* ([arXiv:2604.15097](https://arxiv.org/abs/2604.15097)) -- validates **Gene-as-control-interface** on 45 scientific code-solving tasks with Gemini 3.1 Pro and Flash Lite. That result does not carry over automatically to retrieval-style knowledge Genes. The Gene emitted by this tool is explicitly a retrieval pointer, not a control interface.
- Chunk quality is naive: fixed-width ~4000-char slices. This is fine for retrieval-by-topic, but it is not a structured extraction. Do not expect the output to replace a proper RAG ingestion pipeline.

Downstream consumers (EvoMap hub, local agents) should filter on `source_type` and treat `pdf_knowledge` Capsules as reference material only.

## Install

```bash
git clone https://github.com/EvoMap/pdf2gep.git
cd pdf2gep
npm install
```

Requires Node.js 18+ (for built-in `fetch`).

## Usage

```bash
# From a URL (arXiv, etc.)
node index.js "https://arxiv.org/pdf/2604.15097.pdf"

# From a local file
node index.js "./manual.pdf"
```

Bundles are written to `temp/evomap_assets/batch_<timestamp>.json`.

Each entry in the batch is `{ gene, capsule }`.

## Output schema (GEP 1.6.0)

### Gene

```json
{
  "type": "Gene",
  "id": "gene_pdf2gep_<slug>_chunk<N>_<sha8>",
  "category": "knowledge_reference",
  "summary": "Retrieval pointer for <slug> chunk #<N>",
  "signals_match": ["knowledge_lookup", "pdf_reference", "<slug>"],
  "preconditions": ["Agent needs to consult the source document to answer or plan."],
  "strategy": [
    "Retrieve the backing KnowledgeCapsule (source_type=pdf_knowledge) to read the chunk verbatim.",
    "Do NOT treat the chunk as a validated procedure. It is reference material only."
  ],
  "constraints": { "max_files": 0, "forbidden_paths": [".git", "node_modules"] },
  "validation": [],
  "schema_version": "1.6.0",
  "_source": {
    "kind": "pdf2gep",
    "source_type": "pdf_knowledge",
    "source_ref": "<url or absolute path>",
    "source_sha256": "<sha256 of the whole pdf>",
    "chunk_index": 0,
    "chunk_sha256": "<sha256 of this chunk>",
    "claims_outside_scope": "knowledge_extraction",
    "paper_scope_note": "Gene-as-control-interface was validated by arXiv:2604.15097 on code-science tasks. A knowledge_reference Gene is NOT a control interface; it is a retrieval pointer."
  }
}
```

### KnowledgeCapsule

```json
{
  "type": "Capsule",
  "id": "cap_pdf2gep_<chunk_sha12>_<idkey>",
  "gene": "<gene.id>",
  "source_type": "pdf_knowledge",
  "trigger": ["knowledge_lookup", "pdf_reference", "<slug>"],
  "summary": "PDF chunk #<N> from <name>",
  "confidence": null,
  "blast_radius": { "files": 0, "lines": 0, "chunk_chars": 4000 },
  "outcome": { "status": "knowledge_reference", "score": null },
  "env_fingerprint": { "platform": "...", "node": "..." },
  "content": "<chunk text verbatim>",
  "execution_trace": [],
  "schema_version": "1.6.0",
  "_source": {
    "source_ref": "<url or path>",
    "source_sha256": "<sha256 of the whole pdf>",
    "chunk_index": 0,
    "chunk_sha256": "<sha256 of this chunk>",
    "claims_outside_scope": "knowledge_extraction"
  }
}
```

Key invariants validators can rely on:

- `outcome.status === "knowledge_reference"` -- never `"success"` / `"failed"`.
- `execution_trace` is empty.
- `blast_radius.files === 0 && lines === 0`.
- `source_type === "pdf_knowledge"` on both the Gene `_source` and the Capsule.

## Publishing to EvoMap

Use `evolver` (the GEP reference runtime) to publish a bundle:

```bash
evolver publish --bundle temp/evomap_assets/batch_<ts>.json
```

The EvoMap hub routes `pdf_knowledge` Capsules to the retrieval index, separately from execution Capsules. Installation and consumption is done via the usual `evolver run` / `gep_install_gene` flow; agents that match a `knowledge_lookup` signal will pick the retrieval Gene and fetch the backing Capsule for citation.

See also:
- Protocol reference: <https://evomap.ai/wiki/16-gep-protocol>
- Skill store (where the Gene shows up): <https://evomap.ai/wiki/31-skill-store>

## Relationship to other tools

- [`skill2gep`](https://github.com/EvoMap/skill2gep) -- protocol adapter that converts `SKILL.md` into Gene+ExecutionCapsule bundles. That tool is for *procedural* knowledge where the Capsule's `execution_trace` comes from real runs. `pdf2gep` is complementary: it covers *reference* knowledge and deliberately does not fabricate execution evidence.
- [kitchen-engineer42/pdf2skills](https://github.com/kitchen-engineer42/pdf2skills) -- prior art that inspired this tool. `pdf2skills` targets Claude Code's `SKILL.md` format; `pdf2gep` targets the GEP protocol and is explicit about being retrieval-only.

## License

MIT.
