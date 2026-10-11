import test from 'node:test';
import assert from 'node:assert/strict';
import { NtExecutable, NtExecutableResource } from 'pe-library';
import { postgresUtf8ManifestBinary } from '../../apps/desktop/src/postgres-utf8-manifest.js';

test('PostgreSQL UTF-8 preparation preserves existing privilege and unrelated resource declarations', () => {
  const executable = NtExecutable.createEmpty(false, false);
  const resources = NtExecutableResource.from(executable);
  const manifest = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo><requestedExecutionLevel level="asInvoker" uiAccess="false"/></trustInfo><dependency>vendor dependency</dependency></assembly>';
  resources.replaceResourceEntryFromString(24, 1, 1033, manifest);
  resources.replaceResourceEntryFromString(10, 7, 1033, 'unrelated vendor metadata');
  resources.outputResource(executable);
  const binary = postgresUtf8ManifestBinary(new Uint8Array(executable.generate()));
  const changed = NtExecutableResource.from(NtExecutable.from(binary));
  const result = changed.getResourceEntriesAsString(24, 1)[0]![1];
  assert.ok(result.includes('<requestedExecutionLevel level="asInvoker" uiAccess="false"/>'));
  assert.ok(result.includes('<dependency>vendor dependency</dependency>'));
  assert.match(result, /activeCodePage[^>]*>UTF-8</u);
  assert.deepEqual(changed.getResourceEntriesAsString(10, 7), [[1033, 'unrelated vendor metadata']]);
});

test('PostgreSQL UTF-8 resource preparation is idempotent', () => {
  const executable = NtExecutable.createEmpty(false, false);
  const first = postgresUtf8ManifestBinary(new Uint8Array(executable.generate()));
  const second = postgresUtf8ManifestBinary(first);
  assert.deepEqual(second, first);
});

test('PostgreSQL UTF-8 preparation refuses a binary declaring Authenticode certificate data', () => {
  const binary = Buffer.from(NtExecutable.createEmpty(false, false).generate());
  const executable = NtExecutable.from(binary);
  executable.newHeader.optionalHeaderDataDirectory.set(4, { virtualAddress: binary.byteLength, size: 8 });
  const headers = Buffer.from(executable.getRawHeader());
  const certificateDeclared = Buffer.concat([headers, binary.subarray(headers.byteLength), Buffer.alloc(8)]);
  assert.throws(() => postgresUtf8ManifestBinary(certificateDeclared), /signed|certificate/iu);
});
