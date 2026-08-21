const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function safeSegment(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '_');
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest('hex');
}

async function walkFiles(directory) {
  if (!(await exists(directory))) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(target));
    else files.push(target);
  }
  return files;
}

class AssetPromotionStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.stagingDir = path.join(rootDir, 'staging');
    this.objectsDir = path.join(rootDir, 'objects');
    this.metadataDir = path.join(rootDir, 'metadata');
  }

  async initialize() {
    await Promise.all([
      fs.mkdir(this.stagingDir, { recursive: true }),
      fs.mkdir(this.objectsDir, { recursive: true }),
      fs.mkdir(this.metadataDir, { recursive: true }),
    ]);
  }

  objectPath(checksum) {
    return path.join(this.objectsDir, checksum.slice(0, 2), checksum);
  }

  metadataPath(checksum) {
    return path.join(this.metadataDir, `${checksum}.json`);
  }

  async stage({ sourcePath, assetId, originalName }) {
    const checksum = await sha256File(sourcePath);
    const stageName = `${safeSegment(assetId)}-${crypto.randomUUID()}.part`;
    const tempPath = path.join(this.stagingDir, `${stageName}.copy`);
    const stagedPath = path.join(this.stagingDir, stageName);
    await fs.copyFile(sourcePath, tempPath);
    await fs.rename(tempPath, stagedPath);
    return { status: 'STAGED', assetId, originalName, checksum, stagedPath };
  }

  async promote({ stagedPath, checksum, assetId, originalName, simulateCrashAfterCopy = false }) {
    if (!(await exists(stagedPath))) return { status: 'FAILED', error: { code: 'STAGED_FILE_MISSING' } };
    const actualChecksum = await sha256File(stagedPath);
    if (actualChecksum !== checksum) {
      return { status: 'FAILED', error: { code: 'CHECKSUM_MISMATCH', expected: checksum, actual: actualChecksum } };
    }
    const destination = this.objectPath(checksum);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (await exists(destination)) {
      await fs.rm(stagedPath, { force: true });
      return { status: 'DEDUPED', checksum, destination };
    }
    const tempDestination = `${destination}.part-${crypto.randomUUID()}`;
    await fs.copyFile(stagedPath, tempDestination);
    if (simulateCrashAfterCopy) {
      return { status: 'CRASHED_BEFORE_RENAME', checksum, tempDestination };
    }
    await fs.rename(tempDestination, destination);
    const metadata = { assetId, originalName, checksum, promotedAt: new Date().toISOString(), path: destination };
    const metadataTemp = `${this.metadataPath(checksum)}.part-${crypto.randomUUID()}`;
    await fs.writeFile(metadataTemp, JSON.stringify(metadata, null, 2), 'utf8');
    await fs.rename(metadataTemp, this.metadataPath(checksum));
    await fs.rm(stagedPath, { force: true });
    return { status: 'PROMOTED', checksum, destination, metadataPath: this.metadataPath(checksum) };
  }

  async cleanup({ olderThanMs = 60_000, now = Date.now() } = {}) {
    const candidates = [
      ...(await walkFiles(this.stagingDir)),
      ...(await walkFiles(this.objectsDir)),
      ...(await walkFiles(this.metadataDir)),
    ].filter((filePath) => path.basename(filePath).includes('.part'));
    const removed = [];
    for (const filePath of candidates) {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs >= olderThanMs) {
        await fs.rm(filePath, { force: true });
        removed.push(filePath);
      }
    }
    return { removed };
  }
}

module.exports = { AssetPromotionStore, sha256File };
