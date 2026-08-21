const { spawnSync } = require('node:child_process');

const result = spawnSync(process.execPath, ['--test', 'test/*.test.js'], {
  cwd: require('node:path').resolve(__dirname, '..'),
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
