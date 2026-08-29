export interface DouyinHttpRequest { method: string; url: string; headers?: Record<string, string>; body?: BodyInit; }
export interface DouyinHttpTransport { request(input: DouyinHttpRequest): Promise<Response>; }

export class FetchDouyinHttpTransport implements DouyinHttpTransport {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  request(input: DouyinHttpRequest): Promise<Response> { return this.fetcher(input.url, { method: input.method, ...(input.headers ? { headers: input.headers } : {}), ...(input.body ? { body: input.body } : {}) }); }
}

