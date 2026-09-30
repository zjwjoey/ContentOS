import { createDatabase, migrateUp } from '../../../packages/database/src/index.js';
import { buildApi } from './app.js';
import { loadConfig } from '../../../packages/config/src/index.js';
import { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import { MediaIntelligenceService, createIntelligenceProviders } from '../../../packages/modules/intelligence/src/index.js';

const config = loadConfig();
const db = await createDatabase(config.databaseUrl);
await migrateUp(db);
const storage = new LocalStorageProvider(config.storageRoot);
const intelligence = new MediaIntelligenceService(db, createIntelligenceProviders({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, realProvidersEnabled: config.intelligenceRealProvidersEnabled, asrProvider: config.intelligenceAsrProvider, visionProvider: config.intelligenceVisionProvider, embeddingProvider: config.intelligenceEmbeddingProvider }), { storage, ffmpegPath: config.ffmpegPath, keyframeRoot: config.intelligenceKeyframeRoot });
const app = await buildApi({ db, storage, intelligence, uploadMaxBytes: config.assetUploadMaxBytes, allowFakePublisherControls: process.env.CONTENTOS_FAKE_PUBLISHER_CONTROLS === '1' });
await app.listen({ host: '127.0.0.1', port: config.port });
const close = async () => { await app.close(); await db.end(); };
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
