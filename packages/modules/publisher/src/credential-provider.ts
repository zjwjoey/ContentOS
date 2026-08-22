import type { PublisherCredential } from '../../../contracts/src/index.js';

export interface CredentialProvider { resolve(credentialRef: string): Promise<PublisherCredential>; }

export class EnvironmentCredentialProvider implements CredentialProvider {
  constructor(private readonly environment: Record<string, string | undefined> = process.env) {}

  async resolve(credentialRef: string): Promise<PublisherCredential> {
    if (!credentialRef.startsWith('env://')) throw new Error('Unsupported publisher credential reference');
    const key = credentialRef.slice('env://'.length);
    const raw = this.environment[key];
    if (!raw) throw new Error(`Publisher credential ${key} is not configured`);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`Publisher credential ${key} is not valid JSON`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Publisher credential ${key} must be an object`);
    const record = parsed as Record<string, unknown>;
    const credential: PublisherCredential = {};
    for (const key of ['accessToken', 'refreshToken', 'clientKey', 'clientSecret', 'openId'] as const) {
      const value = record[key];
      if (value !== undefined && typeof value !== 'string') throw new Error(`Publisher credential ${key} has invalid ${key} value`);
      if (value !== undefined) credential[key] = value;
    }
    return credential;
  }
}
