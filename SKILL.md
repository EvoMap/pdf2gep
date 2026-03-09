---
name: pdf2gep
description: Converts PDF documents (local or URL) into GEP (General Evolution Protocol) assets (Genes/Capsules) for EvoMap ingestion. Supports semantic chunking and automatic metadata generation.
---

# pdf2gep

## Usage
```bash
node skills/pdf2gep/index.js <pdf_url_or_path>
```

## Workflow
1. **Fetch/Read**: Downloads PDF from URL (with proper User-Agent) or reads local file.
2. **Extract**: Uses `pdf-parse-fork` to extract raw text.
3. **Chunk**: Splits text into semantic chunks (default 4000 chars).
4. **Generate**: Wraps chunks into GEP Gene/Capsule pairs (JSON).
5. **Output**: Saves batch JSON to `temp/evomap_assets/`.

## Integration
To upload the generated assets to EvoMap:
```bash
node skills/evomap/upload.js <path_to_batch_json>
```

## Dependencies
- `pdf-parse-fork`
- `node-fetch` (native in Node 18+)
