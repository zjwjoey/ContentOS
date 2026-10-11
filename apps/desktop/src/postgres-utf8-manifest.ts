import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NtExecutable, NtExecutableResource } from 'pe-library';

const utf8Setting = '<activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>';
const application = `<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>${utf8Setting}</windowsSettings></application>`;
const defaultManifest = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity name="ContentOS.BundledPostgreSQL" version="1.0.0.0" type="win32" processorArchitecture="amd64"/></assembly>';

export function postgresUtf8ManifestBinary(binary: Uint8Array): Buffer {
  // Keep the library's default refusal to rewrite Authenticode-signed binaries.
  const executable = NtExecutable.from(binary);
  const resources = NtExecutableResource.from(executable);
  const manifests = resources.getResourceEntriesAsString(24, 1);
  if (manifests.length && manifests.every(([, manifest]) => /<(?:[\w.-]+:)?activeCodePage\b[^>]*>UTF-8<\/(?:[\w.-]+:)?activeCodePage>/u.test(manifest))) return Buffer.from(binary);
  for (const [language, original] of manifests.length ? manifests : [[1033, defaultManifest] as const]) {
    let manifest = original;
    if (/<(?:[\w.-]+:)?activeCodePage\b/u.test(manifest)) {
      manifest = manifest.replace(/(<(?:[\w.-]+:)?activeCodePage\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?activeCodePage>)/u, '$1UTF-8$2');
    } else if (/<(?:[\w.-]+:)?windowsSettings\b/u.test(manifest)) {
      manifest = manifest.replace(/(<(?:[\w.-]+:)?windowsSettings\b[^>]*>)/u, `$1${utf8Setting}`);
    } else {
      if (!/<\/(?:[\w.-]+:)?assembly>/u.test(manifest)) throw new Error('POSTGRES_WINDOWS_MANIFEST_INVALID');
      manifest = manifest.replace(/(<\/(?:[\w.-]+:)?assembly>)/u, `${application}$1`);
    }
    if (!/<(?:[\w.-]+:)?activeCodePage\b[^>]*>UTF-8<\/(?:[\w.-]+:)?activeCodePage>/u.test(manifest)) throw new Error('POSTGRES_WINDOWS_MANIFEST_INVALID');
    resources.replaceResourceEntryFromString(24, 1, language, manifest);
  }
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}

/** Call only on staged copies; the upstream package and user data stay untouched. */
export async function preparePostgresUtf8Manifests(stagedRoot: string): Promise<void> {
  for (const name of ['postgres', 'pg_ctl', 'initdb']) {
    const file = join(stagedRoot, 'bin', `${name}.exe`);
    await writeFile(file, postgresUtf8ManifestBinary(await readFile(file)));
  }
}
