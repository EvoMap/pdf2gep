'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { writeOutputs, processChunk, loadSdk } = require('../index');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2gep-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

async function assertComplete(dir) {
  const { verifyAssetId, classifyCapsuleEvidence } = await loadSdk();
  const batch = JSON.parse(fs.readFileSync(path.join(dir, 'batch.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(batch.length > 0);
  assert.deepEqual(manifest.assets, batch.map(({ gene, capsule }) => ({ gene: gene.asset_id, capsule: capsule.asset_id })));
  for (const pair of batch) {
    for (const name of ['gene', 'capsule']) {
      const asset = pair[name];
      assert.equal(verifyAssetId(asset), true);
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, `${name}_${asset.asset_id.slice(7)}.json`), 'utf8'));
      assert.deepEqual(persisted, asset);
    }
    assert.equal(classifyCapsuleEvidence(pair.capsule).valid, true);
  }
}

function worker(t, root, mode = 'normal') {
  const child = fork(path.join(__dirname, 'helpers', 'output-worker.cjs'), [root, mode], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let output;
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output, stderr }));
  });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error(`Worker exited before ready: ${stderr}`)));
    child.on('message', msg => {
      if (msg.ready) resolve();
      if (msg.output) output = msg.output;
      if (msg.error) stderr += msg.error;
    });
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  return { child, ready, done };
}

test('each write failure leaves no incomplete public run and preserves previous output', async t => {
  const root = temporaryRoot(t);
  const source = { name: 'manual' };
  const assets = [await processChunk('Transaction test', 0, source)];
  const previous = writeOutputs(assets, root, source);
  const before = snapshot(previous.runDir);

  for (let failAfter = 1; failAfter <= 4; failAfter++) {
    await t.test(`ENOSPC after write ${failAfter}`, () => {
      const injected = Object.assign(new Error('Injected ENOSPC'), { code: 'ENOSPC' });
      const original = fs.writeFileSync;
      let writes = 0;
      fs.writeFileSync = function (...args) {
        original.apply(this, args);
        if (++writes === failAfter) throw injected;
      };
      try {
        assert.throws(() => writeOutputs(assets, root, source), err => err === injected);
        assert.equal(writes, failAfter);
      } finally { fs.writeFileSync = original; }
      assert.deepEqual(fs.readdirSync(root), [path.basename(previous.runDir)]);
      assert.deepEqual(snapshot(previous.runDir), before);
    });
  }
  await assertComplete(previous.runDir);
});

test('rename failure cleans staging and leaves a successful run unchanged', async t => {
  const root = temporaryRoot(t);
  const source = { name: 'manual' };
  const assets = [await processChunk('Rename test', 0, source)];
  const previous = writeOutputs(assets, root, source);
  const before = snapshot(previous.runDir);
  const original = fs.renameSync;
  const injected = Object.assign(new Error('Injected rename denial'), { code: 'EACCES' });
  fs.renameSync = () => { throw injected; };
  try { assert.throws(() => writeOutputs(assets, root, source), err => err === injected); }
  finally { fs.renameSync = original; }
  assert.deepEqual(fs.readdirSync(root), [path.basename(previous.runDir)]);
  assert.deepEqual(snapshot(previous.runDir), before);
});

test('cleanup failure reports both errors without deleting a completed run', async t => {
  const root = temporaryRoot(t);
  const source = { name: 'manual' };
  const assets = [await processChunk('Cleanup test', 0, source)];
  const previous = writeOutputs(assets, root, source);
  const before = snapshot(previous.runDir);
  const originalWrite = fs.writeFileSync;
  const originalRemove = fs.rmSync;
  const writeError = new Error('Injected write failure');
  const cleanupError = new Error('Injected cleanup failure');
  fs.writeFileSync = () => { throw writeError; };
  fs.rmSync = () => { throw cleanupError; };
  try {
    assert.throws(() => writeOutputs(assets, root, source), err => {
      assert.ok(err instanceof AggregateError);
      assert.deepEqual(err.errors, [writeError, cleanupError]);
      assert.match(err.message, /staging cleanup failed/);
      return true;
    });
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync = originalRemove;
  }
  assert.deepEqual(snapshot(previous.runDir), before);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.tmp')).length, 1);
});

test('four concurrent processes with the same clock and assets publish separate complete runs', { timeout: 20000 }, async t => {
  const root = temporaryRoot(t);
  const workers = Array.from({ length: 4 }, () => worker(t, root));
  await Promise.all(workers.map(item => item.ready));
  for (const item of workers) item.child.send('start');
  const results = await Promise.all(workers.map(item => item.done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(new Set(results.map(result => result.output.runDir)).size, 4);
  const names = fs.readdirSync(root);
  assert.equal(names.length, 4);
  for (const name of names) {
    assert.match(name, /^run_1700000000000_[a-f0-9]+$/);
    await assertComplete(path.join(root, name));
  }
});

test('SIGKILL leaves only hidden staging, and retry never consumes it', { timeout: 20000 }, async t => {
  const root = temporaryRoot(t);
  const previous = writeOutputs([await processChunk('Existing output', 0, { name: 'before' })], root, { name: 'before' });
  const before = snapshot(previous.runDir);
  const crashing = worker(t, root, 'crash');
  await crashing.ready;
  crashing.child.send('start');
  const result = await crashing.done;
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  const leftovers = fs.readdirSync(root).filter(name => name.startsWith('.'));
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0], /^\.run_1700000000000_[a-f0-9]+\.tmp$/);
  assert.deepEqual(snapshot(previous.runDir), before);
  const retry = worker(t, root);
  await retry.ready;
  retry.child.send('start');
  const retried = await retry.done;
  assert.equal(retried.code, 0, retried.stderr);
  await assertComplete(retried.output.runDir);
  assert.deepEqual(snapshot(previous.runDir), before);
  assert.ok(fs.existsSync(path.join(root, leftovers[0])), 'retry must not delete another run\'s staging');
});
