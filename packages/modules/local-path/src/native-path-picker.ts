import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NativePathPicker, LocalPathPurpose } from './index.js';

const execFileAsync = promisify(execFile);

function escapedPowerShell(value: string): string { return value.replaceAll('`', '``').replaceAll("'", "''"); }
function fileFilter(filters: Array<{ name: string; extensions: string[] }> | undefined): string {
  return (filters?.length ? filters : [{ name: '媒体文件', extensions: ['*'] }]).map((filter) => `${filter.name}|${filter.extensions.map((extension) => `*.${extension.replace(/^\./u, '')}`).join(';')}`).join('|');
}

/** Windows Shell-backed picker. It intentionally runs only in local desktop mode. */
export class WindowsNativePathPicker implements NativePathPicker {
  async pickFolder(_options?: { purpose?: LocalPathPurpose }): Promise<{ cancelled: true } | { cancelled: false; path: string }> {
    if (process.platform !== 'win32') return { cancelled: true };
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='选择 ContentOS 文件夹'; $dialog.ShowNewFolderButton=$true; if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write($dialog.SelectedPath) }";
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: '' }));
    const path = String(result.stdout || '').trim();
    return path ? { cancelled: false, path } : { cancelled: true };
  }

  async pickFile(options?: { purpose?: LocalPathPurpose; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ cancelled: true } | { cancelled: false; path: string }> {
    if (process.platform !== 'win32') return { cancelled: true };
    const filter = escapedPowerShell(fileFilter(options?.filters));
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title='选择 ContentOS 文件'; $dialog.Filter='${filter}'; $dialog.Multiselect=$false; if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write($dialog.FileName) }`;
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: '' }));
    const path = String(result.stdout || '').trim();
    return path ? { cancelled: false, path } : { cancelled: true };
  }
}

