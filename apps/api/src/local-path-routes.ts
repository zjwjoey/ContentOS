import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LocalPathAccessService, type LocalPathPurpose, type NativePathPicker } from '../../../packages/modules/local-path/src/index.js';

const purposeSchema = z.enum(['MEDIA_ROOT', 'OUTPUT_ROOT', 'MUSIC_ROOT', 'VOICE_FILE', 'MUSIC_FILE', 'PRIORITY_ASSET', 'JIANYING_DRAFT']);
const folderPurpose = z.enum(['MEDIA_ROOT', 'OUTPUT_ROOT', 'MUSIC_ROOT', 'JIANYING_DRAFT']);
const filePurpose = z.enum(['VOICE_FILE', 'MUSIC_FILE', 'PRIORITY_ASSET', 'JIANYING_DRAFT']);

function desktopOnly(service: LocalPathAccessService): boolean { return service.desktopMode && (process.env.CONTENTOS_LOCAL_DESKTOP_MODE !== '0'); }
function pickerError(error: unknown): { code: string; message: string } {
  const code = error instanceof Error ? error.message : 'LOCAL_PATH_PICK_FAILED';
  const message = code === 'LOCAL_PATH_NOT_READABLE' ? 'Windows 当前用户没有读取该路径的权限。' : code === 'LOCAL_PATH_NOT_WRITABLE' ? 'Windows 当前用户无法写入该文件夹。' : code === 'LOCAL_PATH_NOT_FOUND' ? '选择的路径不存在或已不可用。' : code === 'LOCAL_PATH_DIRECTORY_REQUIRED' ? '请选择文件夹。' : code === 'LOCAL_PATH_FILE_REQUIRED' ? '请选择文件。' : '无法使用所选本地路径。';
  return { code, message };
}

export interface LocalPathRouteDependencies { access: LocalPathAccessService; picker: NativePathPicker; }

export function registerLocalPathRoutes(app: FastifyInstance, dependencies: LocalPathRouteDependencies): void {
  app.get('/api/v1/local-paths/grants', async (_request, reply) => {
    if (!desktopOnly(dependencies.access)) return reply.code(403).send({ error: { code: 'LOCAL_DESKTOP_MODE_REQUIRED', message: '本地路径选择仅在桌面模式可用。' } });
    return { items: await dependencies.access.list() };
  });
  app.post('/api/v1/local-paths/pick-folder', async (request, reply) => {
    const parsed = z.object({ purpose: folderPurpose }).safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'LOCAL_PATH_PURPOSE_INVALID', message: '文件夹用途不正确。', details: parsed.error.issues } });
    if (!desktopOnly(dependencies.access)) return reply.code(403).send({ error: { code: 'LOCAL_DESKTOP_MODE_REQUIRED', message: '本地路径选择仅在桌面模式可用。' } });
    const selected = await dependencies.picker.pickFolder({ purpose: parsed.data.purpose });
    if (selected.cancelled) return { cancelled: true };
    try {
      const grant = await dependencies.access.grantPath({ path: selected.path, purpose: parsed.data.purpose as LocalPathPurpose, source: 'NATIVE_PICKER' });
      const inspected = await dependencies.access.inspect(grant.canonicalPath);
      return { cancelled: false, path: grant.canonicalPath, grantId: grant.id, readable: inspected.readable, writable: inspected.writable, kind: grant.kind };
    } catch (error) {
      const mapped = pickerError(error); return reply.code(mapped.code === 'LOCAL_PATH_NOT_WRITABLE' || mapped.code === 'LOCAL_PATH_NOT_READABLE' ? 403 : 422).send({ error: mapped });
    }
  });
  app.post('/api/v1/local-paths/pick-file', async (request, reply) => {
    const parsed = z.object({ purpose: filePurpose }).safeParse(request.body || {});
    if (!parsed.success) return reply.code(422).send({ error: { code: 'LOCAL_PATH_PURPOSE_INVALID', message: '文件用途不正确。', details: parsed.error.issues } });
    if (!desktopOnly(dependencies.access)) return reply.code(403).send({ error: { code: 'LOCAL_DESKTOP_MODE_REQUIRED', message: '本地路径选择仅在桌面模式可用。' } });
    const filters = parsed.data.purpose === 'VOICE_FILE' ? [{ name: '配音文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }] : parsed.data.purpose === 'MUSIC_FILE' ? [{ name: '音乐文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }] : parsed.data.purpose === 'JIANYING_DRAFT' ? [{ name: '剪映草稿或配置', extensions: ['json', 'draft', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }] : [{ name: '视频文件', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }];
    const selected = await dependencies.picker.pickFile({ purpose: parsed.data.purpose, filters });
    if (selected.cancelled) return { cancelled: true };
    try {
      const grant = await dependencies.access.grantPath({ path: selected.path, purpose: parsed.data.purpose as LocalPathPurpose, source: 'NATIVE_PICKER' });
      const inspected = await dependencies.access.inspect(grant.canonicalPath);
      return { cancelled: false, path: grant.canonicalPath, grantId: grant.id, readable: inspected.readable, writable: inspected.writable, kind: grant.kind };
    } catch (error) {
      const mapped = pickerError(error); return reply.code(mapped.code === 'LOCAL_PATH_NOT_WRITABLE' || mapped.code === 'LOCAL_PATH_NOT_READABLE' ? 403 : 422).send({ error: mapped });
    }
  });
}
