export interface BrowserPage {
  goto(url: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  setInputFiles(selector: string, filePath: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitFor(selector: string, timeoutMs?: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  textContent?(selector: string): Promise<string | null>;
}

export interface BrowserSession {
  readonly profileDir: string;
  page(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserSessionFactory {
  open(input: { profileDir: string; headed: boolean }): Promise<BrowserSession>;
}

export async function withBrowserSession<T>(factory: BrowserSessionFactory, input: { profileDir: string; headed: boolean }, callback: (session: BrowserSession) => Promise<T>): Promise<T> {
  const session = await factory.open(input);
  try { return await callback(session); }
  finally { await session.close(); }
}
