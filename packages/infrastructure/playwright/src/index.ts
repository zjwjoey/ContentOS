import { chromium, type BrowserContext, type Page } from 'playwright';
import type { BrowserPage, BrowserSession, BrowserSessionFactory } from '../../../modules/publisher/src/browser-session.js';

export interface PlaywrightBrowserOptions { executablePath?: string; timeoutMs?: number; }

class PlaywrightPage implements BrowserPage {
  constructor(private readonly page: Page, private readonly timeoutMs: number) {}
  async goto(url: string): Promise<void> { await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs }); }
  isVisible(selector: string): Promise<boolean> { return this.page.locator(selector).isVisible({ timeout: this.timeoutMs }).catch(() => false); }
  async setInputFiles(selector: string, filePath: string): Promise<void> { await this.page.locator(selector).setInputFiles(filePath, { timeout: this.timeoutMs }); }
  async fill(selector: string, value: string): Promise<void> { await this.page.locator(selector).fill(value, { timeout: this.timeoutMs }); }
  async click(selector: string): Promise<void> { await this.page.locator(selector).click({ timeout: this.timeoutMs }); }
  async waitFor(selector: string, timeoutMs = this.timeoutMs): Promise<void> { await this.page.locator(selector).waitFor({ state: 'visible', timeout: timeoutMs }); }
  textContent(selector: string): Promise<string | null> { return this.page.locator(selector).textContent({ timeout: this.timeoutMs }); }
  getAttribute(selector: string, name: string): Promise<string | null> { return this.page.locator(selector).getAttribute(name, { timeout: this.timeoutMs }); }
  async screenshot(path: string): Promise<void> { await this.page.screenshot({ path, fullPage: true }); }
}

class PlaywrightBrowserSession implements BrowserSession {
  private activePage: PlaywrightPage | null = null;
  constructor(readonly profileDir: string, private readonly context: BrowserContext, private readonly timeoutMs: number) {}
  async page(): Promise<BrowserPage> { this.activePage = new PlaywrightPage(await this.context.newPage(), this.timeoutMs); return this.activePage; }
  async close(): Promise<void> { await this.context.close(); }
}

export class PlaywrightBrowserSessionFactory implements BrowserSessionFactory {
  constructor(private readonly options: PlaywrightBrowserOptions = {}) {}
  async open(input: { profileDir: string; headed: boolean }): Promise<BrowserSession> {
    const timeoutMs = this.options.timeoutMs || 15_000;
    const context = await chromium.launchPersistentContext(input.profileDir, { headless: !input.headed, ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}) });
    return new PlaywrightBrowserSession(input.profileDir, context, timeoutMs);
  }
}
