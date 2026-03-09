const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse-fork');

// Configuration

// Configuration
const OUTPUT_DIR = path.join(process.cwd(), 'temp', 'evomap_assets');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function extractText(pdfSource) {
    if (pdfSource.startsWith('http')) {
        const response = await fetch(pdfSource, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        const buffer = await response.arrayBuffer();
        const data = await pdf(Buffer.from(buffer));
        return data.text;
    } else {
        const dataBuffer = fs.readFileSync(pdfSource);
        const data = await pdf(dataBuffer);
        return data.text;
    }
}

function chunkText(text, size = 4000) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.substring(i, i + size));
    }
    return chunks;
}

// GEP Asset Wrappers
function createGene(name, description, tags) {
    return {
        type: 'Gene',
        id: `gene_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        category: 'knowledge', // or 'skill'
        summary: description,
        signals_match: tags || ['pdf-extracted'],
        schema_version: '1.5.0',
        metadata: {
            source: 'pdf2gep',
            name: name
        }
    };
}

function createCapsule(geneId, payload, name) {
    return {
        type: 'Capsule',
        id: `capsule_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        gene: geneId,
        summary: `Implementation of ${name}`,
        trigger: ['manual'],
        confidence: 0.8, // Automated extraction confidence
        blast_radius: { files: 1, lines: 100 },
        outcome: { status: 'success', score: 1.0 },
        env_fingerprint: { platform: 'linux', arch: 'x64' },
        payload: payload, // The actual content (SKILL.md content or code)
        schema_version: '1.5.0'
    };
}

async function processChunk(chunk, index) {
    // Simulated LLM extraction for MVP.
    // In production, use `execSync('node skills/feishu-evolver-wrapper/llm.js ...')` or similar.
    
    const name = `knowledge-chunk-${Date.now()}-${index}`;
    const description = `Extracted knowledge from PDF chunk ${index}`;
    const content = `## Extracted Knowledge\n\n${chunk.substring(0, 200)}...\n\n(Full content would be here)`;

    const gene = createGene(name, description, ['pdf', 'knowledge']);
    const capsule = createCapsule(gene.id, { 
        type: 'Knowledge', 
        content: content, 
        format: 'markdown' 
    }, name);

    return { gene, capsule };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node skills/pdf2gep/index.js <pdf_url_or_path>');
        process.exit(1);
    }

    const pdfSource = args[0];
    console.log(`Processing PDF: ${pdfSource}...`);

    try {
        const text = await extractText(pdfSource);
        console.log(`Extracted ${text.length} chars.`);
        
        const chunks = chunkText(text);
        console.log(`Split into ${chunks.length} chunks.`);

        const assets = [];
        for (let i = 0; i < chunks.length; i++) {
            const asset = await processChunk(chunks[i], i);
            assets.push(asset);
        }

        // Save Batch
        const batchFile = path.join(OUTPUT_DIR, `batch_${Date.now()}.json`);
        fs.writeFileSync(batchFile, JSON.stringify(assets, null, 2));

        console.log(`Generated ${assets.length} GEP pairs (Gene+Capsule).`);
        console.log(`Saved to ${batchFile}`);

        // Try Upload
        // We'll assume `skills/evomap/upload.js` exists or we append to it.
        // For now, just log instructions.
        console.log(`To upload, run: node skills/evomap/upload.js ${batchFile}`);

    } catch (err) {
        console.error('Error:', err);
    }
}

main();
