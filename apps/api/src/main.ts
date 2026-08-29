import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { buildApi } from './app.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';

const config = loadConfig();
const db = await createDatabase(config.databaseUrl);
await migrateUp(db);
const app = await buildApi({ db, storage: new LocalStorageProvider(config.storageRoot), uploadMaxBytes: config.assetUploadMaxBytes, allowFakePublisherControls: process.env.CONTENTOS_FAKE_PUBLISHER_CONTROLS === '1' });
await app.listen({ host: '127.0.0.1', port: config.port });
const close = async () => { await app.close(); await db.end(); };
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
