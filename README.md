# pdf2gep

Convert PDF documents into **GEP (General Evolution Protocol)** assets for AI Agents.

This tool extracts knowledge from PDFs (technical papers, books, manuals), semantically chunks them, and packages them into **Gene** (Metadata/Strategy) + **Capsule** (Implementation/Knowledge) bundles ready for ingestion by the **EvoMap** network.

## 🌟 Inspiration & Acknowledgements

This project is heavily inspired by [pdf2skills](https://github.com/kitchen-engineer42/pdf2skills) by **kitchen-engineer42**.
We adapted the core concept of "Book-to-Skill" conversion for the OpenClaw GEP ecosystem, shifting from Python/MinerU to a lightweight Node.js architecture for agent-native execution.

**Key differences:**
- **Target**: OpenClaw GEP (EvoMap) instead of Claude Code.
- **Stack**: Pure Node.js (vs Python/MinerU).
- **Protocol**: Outputs GEP v1.5.0 JSON bundles.

## ✨ Features

- **Universal Extraction**: Supports local PDFs and remote URLs (ArXiv, etc.) via `pdf-parse-fork`.
- **Semantic Chunking**: Context-aware splitting to preserve logical continuity (default 4k chars).
- **GEP Compliance**: Automatically generates:
  - `Gene`: High-level summary and signal matching tags.
  - `Capsule`: Detailed content, confidence scores, and blast radius metrics.
  - `SHA256`: Deterministic content-addressable IDs for EvoMap verification.
- **Batch Processing**: Outputs ready-to-upload JSON batches.

## 🚀 Usage

### 1. Installation

```bash
git clone https://github.com/autogame-17/pdf2gep.git
cd pdf2gep
npm install
```

### 2. Convert a PDF

```bash
# From URL (e.g., ArXiv paper)
node index.js "https://arxiv.org/pdf/2603.05500.pdf"

# From Local File
node index.js "./manual.pdf"
```

### 3. Upload to EvoMap

Generated batches are saved to `temp/evomap_assets/`. Use the `evomap` skill to publish:

```bash
node ../evomap/upload.js temp/evomap_assets/batch_1772887751750.json
```

## 🛠️ Architecture

1.  **Fetcher**: Handles HTTP/HTTPS streams with browser-like headers to bypass basic blocks.
2.  **Extractor**: Uses `pdf-parse-fork` for robust text extraction.
3.  **Chunker**: Splits text into manageably sized blocks for LLM consumption.
4.  **Generator**: Wraps chunks in the GEP v1.5.0 envelope structure.

## 📜 License

MIT
