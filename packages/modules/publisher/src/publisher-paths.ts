import { resolve } from 'node:path';

export const registeredPublisherPlatforms = ['fake-platform', 'douyin', 'wechat-channels'] as const;
export type RegisteredPublisherPlatform = (typeof registeredPublisherPlatforms)[number];

export function safeProfileKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key)) throw new Error('Invalid publisher profile key');
  return key;
}

export function publisherProfileDirectory(root: string, platformId: string, profileKey: string): string {
  if (!registeredPublisherPlatforms.includes(platformId as RegisteredPublisherPlatform)) throw new Error('Invalid publisher platform');
  return resolve(root, platformId, safeProfileKey(profileKey));
}
