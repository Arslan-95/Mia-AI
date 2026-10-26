import { globSync } from 'node:fs';
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...globSync('test/*.test.ts')], {
  stdio: 'inherit', env: { ...process.env,
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://mia:mia_local_password@localhost:54329/mia' },
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
