const fs = require('node:fs/promises');
const path = require('node:path');

class FakePlatform {
  constructor({ domVersion = 'v1', profiles = {} } = {}) {
    this.domVersion = domVersion;
    this.profiles = profiles;
    this.published = [];
  }

  createBrowser({ profileId, crashAt = null }) {
    const platform = this;
    let step = 0;
    const profile = platform.profiles[profileId] || { token: null, requiresVerification: false, cookies: {} };
    platform.profiles[profileId] = profile;
    return {
      async close() { this.closed = true; },
      async newPage() {
        return {
          async goto(url) { step += 1; if (crashAt === step) throw new Error('BROWSER_CRASH'); this.url = url; },
          async locator(selector) {
            step += 1; if (crashAt === step) throw new Error('BROWSER_CRASH');
            if (platform.domVersion !== 'v1') throw new Error(`DOM_CHANGED:${selector}`);
            return { async fill(value) { this.value = value; }, async click() { this.clicked = true; } };
          },
          async publish(content) {
            step += 1; if (crashAt === step) throw new Error('BROWSER_CRASH');
            platform.published.push({ profileId, content });
          },
          profile,
        };
      },
    };
  }
}

class RedactingLogger {
  constructor() { this.events = []; }
  log(event, details = {}) {
    const serialized = JSON.stringify(details).replace(/(token|password|secret|cookie)"\s*:\s*"[^"]*"/gi, '$1":"[REDACTED]"');
    this.events.push({ event, details: JSON.parse(serialized) });
  }
}

class PublisherJobStore {
  constructor(filePath) { this.filePath = filePath; this.jobs = new Map(); }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.jobs = new Map(Object.entries(data));
    } catch { /* first run */ }
  }
  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(Object.fromEntries(this.jobs), null, 2), 'utf8');
  }
  async set(jobId, state) { this.jobs.set(jobId, state); await this.save(); }
  get(jobId) { return this.jobs.get(jobId); }
}

class PublisherWorker {
  constructor({ platform, profileRoot, logger = new RedactingLogger(), jobStore = null, expectedDomVersion = 'v1' }) {
    this.platform = platform;
    this.profileRoot = profileRoot;
    this.logger = logger;
    this.jobStore = jobStore;
    this.expectedDomVersion = expectedDomVersion;
  }

  async publish({ jobId, profileId, token, content, crashAt = null, simulateWorkerCrash = false }) {
    if (this.jobStore) await this.jobStore.set(jobId, { status: 'RUNNING', profileId, attempts: (this.jobStore.get(jobId)?.attempts || 0) + 1 });
    this.logger.log('PUBLISH_STARTED', { jobId, profileId, token });
    if (simulateWorkerCrash) return { status: 'WORKER_CRASHED', error: { code: 'WORKER_CRASHED' } };
    if (this.platform.domVersion !== this.expectedDomVersion) {
      await this.markFailed(jobId, 'DOM_CHANGED');
      return { status: 'FAILED', error: { code: 'DOM_CHANGED' } };
    }
    const profileDir = path.join(this.profileRoot, profileId);
    await fs.mkdir(profileDir, { recursive: true });
    const browser = this.platform.createBrowser({ profileId, crashAt });
    try {
      const page = await browser.newPage();
      await page.goto('fake://platform/publish');
      if (!token || page.profile.token !== token) {
        await this.markFailed(jobId, 'AUTH_REQUIRED');
        return { status: 'FAILED', error: { code: 'AUTH_REQUIRED' } };
      }
      if (page.profile.requiresVerification) {
        await this.markFailed(jobId, 'VERIFICATION_REQUIRED');
        return { status: 'FAILED', error: { code: 'VERIFICATION_REQUIRED' } };
      }
      const title = await page.locator('[data-testid="title"]');
      await title.fill(content.title);
      await title.click();
      await page.publish(content);
      await this.markSucceeded(jobId, profileId);
      this.logger.log('PUBLISH_SUCCEEDED', { jobId, profileId });
      return { status: 'SUCCEEDED', jobId, profileId };
    } catch (error) {
      const code = error.message.startsWith('DOM_CHANGED') ? 'DOM_CHANGED' : error.message === 'BROWSER_CRASH' ? 'BROWSER_CRASH' : 'PUBLISHER_FAILED';
      await this.markFailed(jobId, code);
      this.logger.log('PUBLISH_FAILED', { jobId, profileId, token, error: code });
      return { status: 'FAILED', error: { code } };
    } finally {
      await browser.close();
    }
  }

  async markFailed(jobId, code) {
    if (this.jobStore) await this.jobStore.set(jobId, { ...(this.jobStore.get(jobId) || {}), status: 'FAILED', error: code });
  }

  async markSucceeded(jobId, profileId) {
    if (this.jobStore) await this.jobStore.set(jobId, { ...(this.jobStore.get(jobId) || {}), status: 'SUCCEEDED', profileId });
  }
}

module.exports = { FakePlatform, PublisherWorker, PublisherJobStore, RedactingLogger };
