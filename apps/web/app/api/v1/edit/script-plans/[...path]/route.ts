const apiOrigin = () => process.env.CONTENTOS_API_URL || 'http://127.0.0.1:3000';
async function forward(request: Request, suffix: string): Promise<Response> {
  const target = `${apiOrigin()}/api/v1/edit/script-plans${suffix}${new URL(request.url).search}`;
  const headers = new Headers(request.headers); headers.delete('host');
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, { method: request.method, headers, ...(body ? { body } : {}), cache: 'no-store' });
  const responseHeaders = new Headers(upstream.headers); responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
function suffix(context: { params: { path: string[] } }): string { return `/${context.params.path.map(encodeURIComponent).join('/')}`; }
export async function GET(request: Request, context: { params: { path: string[] } }): Promise<Response> { return forward(request, suffix(context)); }
export async function POST(request: Request, context: { params: { path: string[] } }): Promise<Response> { return forward(request, suffix(context)); }
export async function PATCH(request: Request, context: { params: { path: string[] } }): Promise<Response> { return forward(request, suffix(context)); }
