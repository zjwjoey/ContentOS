export type AssetImportState = 'STAGED' | 'QUEUED' | 'PROCESSING' | 'READY' | 'DEDUPED' | 'FAILED' | 'CANCELLED';
export type AssetImportKind = 'VIDEO' | 'AUDIO';

export interface AssetImportV0 {
  schemaVersion: 'ASSET_IMPORT_V0';
  id: string;
  projectId: string;
  originalName: string;
  kind: AssetImportKind;
  byteSize: number;
  state: AssetImportState;
  outputAssetId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetSummaryV0 {
  id: string;
  kind: AssetImportKind | 'VIDEO_RENDER';
  lifecycle: 'READY' | 'DEDUPED' | 'FAILED' | 'CANCELLED';
  byteSize: number;
  checksum: string;
  originalName: string;
  metadata: { durationMs?: number; width?: number; height?: number; format?: string };
}

const importStates: AssetImportState[] = ['STAGED', 'QUEUED', 'PROCESSING', 'READY', 'DEDUPED', 'FAILED', 'CANCELLED'];
const importKinds: AssetImportKind[] = ['VIDEO', 'AUDIO'];
const safeName = (value: string): boolean => Boolean(value.trim()) && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..' && !value.includes('..');
const identifier = (value: string): boolean => Boolean(value.trim()) && value.length <= 200 && !value.includes('/') && !value.includes('\\');

export function validateAssetImportV0(value: AssetImportV0): void {
  if (value.schemaVersion !== 'ASSET_IMPORT_V0') throw new Error('Unsupported Asset Import schema');
  if (!identifier(value.id) || !identifier(value.projectId)) throw new Error('Asset import identifiers are invalid');
  if (!safeName(value.originalName) || value.originalName.length > 255) throw new Error('Asset import originalName is invalid');
  if (!importKinds.includes(value.kind) || !importStates.includes(value.state)) throw new Error('Asset import kind or state is invalid');
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize <= 0 || value.byteSize > 10 * 1024 * 1024 * 1024) throw new Error('Asset import byteSize is invalid');
  if (value.outputAssetId !== undefined && !identifier(value.outputAssetId)) throw new Error('Asset import outputAssetId is invalid');
  if (value.errorCode !== undefined && (!identifier(value.errorCode) || value.errorCode.length > 80)) throw new Error('Asset import errorCode is invalid');
  if (value.errorMessage !== undefined && value.errorMessage.length > 500) throw new Error('Asset import errorMessage is invalid');
}

export function validateAssetSummaryV0(value: AssetSummaryV0): void {
  if (!identifier(value.id) || !importKinds.concat('VIDEO_RENDER' as never).includes(value.kind as never)) throw new Error('Asset summary identifiers are invalid');
  if (!['READY', 'DEDUPED', 'FAILED', 'CANCELLED'].includes(value.lifecycle)) throw new Error('Asset summary lifecycle is invalid');
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 0 || !/^sha256:[a-f0-9]{64}$/.test(value.checksum)) throw new Error('Asset summary media fields are invalid');
  if (!safeName(value.originalName)) throw new Error('Asset summary originalName is invalid');
}
