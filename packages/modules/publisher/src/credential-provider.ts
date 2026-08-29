import type { PublisherCredential } from '../../../contracts/src/index.js';

export interface CredentialProvider { resolve(credentialRef: string): Promise<PublisherCredential>; }

export class EnvironmentCredentialProvider implements CredentialProvider {
  constructor(private readonly environment: Record<string, string | undefined> = process.env) {}

  async resolve(credentialRef: string): Promise<PublisherCredential> {
    if (!credentialRef.startsWith('env://')) throw new Error('Unsupported publisher credential reference');
    const key = credentialRef.slice('env://'.length);
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error('Publisher credential reference is invalid');
    const raw = this.environment[key];
    if (!raw) throw new Error(`Publisher credential ${key} is not configured`);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`Publisher credential ${key} is not valid JSON`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Publisher credential ${key} must be an object`);
    const record = parsed as Record<string, unknown>;
    const credential: PublisherCredential = {};
    for (const field of ['accessToken', 'refreshToken', 'clientKey', 'clientSecret', 'openId'] as const) {
      const value = record[field];
      if (value !== undefined && typeof value !== 'string') throw new Error(`Publisher credential ${field} has invalid ${field} value`);
      if (value !== undefined) credential[field] = value;
    }
    return credential;
  }
}
