'use strict';

const fs = require('node:fs');
const { processChunk, writeOutputs } = require('../../index');

(async () => {
  const [root, mode] = process.argv.slice(2);
  const source = { name: 'shared', path: '/private/input/shared.pdf' };
  const assets = [await processChunk('Shared concurrent output', 0, source)];
  process.once('message', () => {
    Date.now = () => 1700000000000;
    if (mode === 'crash') {
      const write = fs.writeFileSync;
      fs.writeFileSync = function (...args) {
        write.apply(this, args);
        process.kill(process.pid, 'SIGKILL');
      };
    }
    try {
      const output = writeOutputs(assets, root, source);
      process.send({ output }, () => process.disconnect());
    } catch (err) {
      process.send({ error: err.message }, () => {
        process.exitCode = 1;
        process.disconnect();
      });
    }
  });
  process.send({ ready: true });
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
