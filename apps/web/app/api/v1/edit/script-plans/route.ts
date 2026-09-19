const apiOrigin = () => process.env.CONTENTOS_API_URL || 'http://127.0.0.1:3000';
async function forward(request: Request): Promise<Response> {
  const target = `${apiOrigin()}/api/v1/edit/script-plans${new URL(request.url).search}`;
  const headers = new Headers(request.headers); headers.delete('host');
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, { method: request.method, headers, ...(body ? { body } : {}), cache: 'no-store' });
  const responseHeaders = new Headers(upstream.headers); responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
export async function GET(request: Request): Promise<Response> { return forward(request); }
export async function POST(request: Request): Promise<Response> { return forward(request); }
