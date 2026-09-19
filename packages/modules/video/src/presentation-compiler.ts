import { normalizePresentationSettings, type PresentationSettingsV1 } from '../../../contracts/src/index.js';
import type { EditManifestV0 } from '../../../contracts/src/index.js';

/** Apply one shared Script/MIX presentation contract to a legacy-compatible manifest. */
export function applyPresentationSettings(manifest: EditManifestV0, settings?: Partial<PresentationSettingsV1>): EditManifestV0 {
  const presentation = normalizePresentationSettings(settings);
  return { ...manifest, canvas: presentation.canvas, metadata: { ...(manifest.metadata || {}), presentationSettings: presentation } };
}
