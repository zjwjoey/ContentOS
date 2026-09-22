import { RuntimeHost } from './host.js';

const safeMode = process.argv.includes('--safe');
const host = new RuntimeHost({ safeMode });
await host.start();
console.log(JSON.stringify(host.status()));
const stop = (signal: string) => { void host.stop(signal).finally(() => process.exit(0)); };
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
