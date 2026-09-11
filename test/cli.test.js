'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, execSync } = require('node:child_process');
const { extractText, sha256Hex, loadSdk } = require('../index');
const textPdf = require('./helpers/text-pdf.cjs');
const entry = path.join(__dirname, '..', 'index.js');
const pdfFixture = fs.readFileSync(require.resolve('pdf-parse-fork/test/data/02-valid.pdf'));

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2gep-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function cli(args, cwd, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', timeout: 15000 }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function checkRun(root, source, expectedText) {
  const { verifyAssetId, classifyCapsuleEvidence } = await loadSdk();
  const names = fs.readdirSync(root);
  assert.equal(names.length, 1);
  assert.match(names[0], /^run_/);
  const dir = path.join(root, names[0]);
  const batch = JSON.parse(fs.readFileSync(path.join(dir, 'batch.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(batch.length > 0);
  assert.equal(manifest.source.source_ref, source);
  assert.equal(batch.map(pair => pair.capsule.content.text).join(''), expectedText);
  assert.deepEqual(manifest.assets, batch.map(({ gene, capsule }) => ({ gene: gene.asset_id, capsule: capsule.asset_id })));
  for (const { gene, capsule } of batch) {
    assert.equal(verifyAssetId(gene), true);
    assert.equal(verifyAssetId(capsule), true);
    assert.equal(classifyCapsuleEvidence(capsule).valid, true);
    assert.equal(capsule.content.source_ref, source);
    execSync(gene.validation[0], { cwd: root, input: capsule.content.text, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const asset of [gene, capsule]) {
      const file = path.join(dir, `${asset.type.toLowerCase()}_${asset.asset_id.slice(7)}.json`);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), asset);
    }
  }
  return { manifest, batch };
}

test('small PDFs in sliced Buffers parse without changing the original bytes', async t => {
  const root = temporaryRoot(t);
  const text = 'Small PDF with a sliced Buffer.';
  const pdf = textPdf(text);
  const padded = Buffer.alloc(pdf.length + 37);
  pdf.copy(padded, 37);
  const sliced = padded.subarray(37);
  assert.ok(sliced.byteOffset > 0);
  const before = Buffer.from(sliced);
  const extracted = await extractText(sliced);
  assert.match(extracted, /Small PDF with a sliced Buffer/);
  assert.deepEqual(sliced, before);
  fs.writeFileSync(path.join(root, 'small.pdf'), sliced);
  await cli(['small.pdf', '--output-dir', 'out'], root);
  await checkRun(path.join(root, 'out'), 'file:small.pdf', extracted);
});

test('CLI parses a real PDF and publishes verified files under a non-repository cwd', async t => {
  const root = temporaryRoot(t);
  const pdf = pdfFixture;
  fs.writeFileSync(path.join(root, 'manual test.pdf'), pdf);
  const extracted = await extractText(pdf);
  assert.ok(extracted.trim());
  const result = await cli(['manual test.pdf', '--chunk-size', '4000'], root);
  assert.match(result.stdout, /Generated \d+ GEP pairs/);
  const { manifest } = await checkRun(path.join(root, 'temp', 'evomap_assets'), 'file:manual test.pdf', extracted);
  assert.equal(manifest.source.sha256, sha256Hex(pdf));
  assert.ok(!JSON.stringify(manifest).includes(root));
});

test('CLI downloads through a redirect without copying signed query parameters into output', async t => {
  const root = temporaryRoot(t);
  const pdf = pdfFixture;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/redirect?token=test-only') {
      res.writeHead(302, { Location: '/manual.pdf?token=test-only' });
      res.end();
    } else if (req.url === '/manual.pdf?token=test-only') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(pdf);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/redirect`;
  await cli([`${url}?token=test-only`, '--output-dir', 'out'], root);
  assert.deepEqual(requests, ['/redirect?token=test-only', '/manual.pdf?token=test-only']);
  const { manifest, batch } = await checkRun(path.join(root, 'out'), url, await extractText(pdf));
  assert.doesNotMatch(JSON.stringify({ manifest, batch }), /token=|test-only/);
  await assert.rejects(cli([url.replace('/redirect', '/missing'), '--output-dir', 'failed'], root), err => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Fetch failed: 404/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'failed')), false);
});

test('CLI rejects empty, invalid, and missing PDFs without publishing output', async t => {
  const root = temporaryRoot(t);
  // Independent blank fixture: pypdf.PdfWriter().add_blank_page(612, 792).
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'blank.pdf'), path.join(root, 'blank.pdf'));
  fs.writeFileSync(path.join(root, 'invalid.pdf'), 'This is not a PDF');
  for (const [file, expected] of [['blank.pdf', /OCR is required/], ['invalid.pdf', /Error:/], ['missing.pdf', /ENOENT/]]) {
    await assert.rejects(cli([file, '--output-dir', 'out'], root), err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, expected);
      return true;
    });
    assert.equal(fs.existsSync(path.join(root, 'out')), false);
  }
});

test('CLI validates options before reading input and keeps the verify subcommand runnable', async t => {
  const root = temporaryRoot(t);
  for (const args of [['--chunk-size', 'bad'], ['--chunk-size'], ['--source-ref'], ['--output-dir'], ['--unknown']]) {
    await assert.rejects(cli(['missing.pdf', ...args], root), err => {
      assert.equal(err.code, 1);
      assert.doesNotMatch(err.stderr, /ENOENT/);
      assert.match(err.stderr, /requires a value|positive integer|Unknown option/);
      return true;
    });
  }
  await assert.rejects(cli([], root), /Usage: pdf2gep/);
  const text = '引用 hé😀';
  const digest = sha256Hex(text);
  await cli(['verify', digest], root, text);
  await assert.rejects(cli(['verify', digest], root, 'tampered'), /sha256 mismatch/);
  await assert.rejects(cli(['verify', `${digest}\n`], root), /64-character sha256/);
});
