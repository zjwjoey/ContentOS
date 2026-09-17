const apiOrigin = () => process.env.CONTENTOS_API_URL || "http://127.0.0.1:3000";

async function forward(response: Response): Promise<Response> {
  return new Response(await response.arrayBuffer(), { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json" } });
}

export async function GET(): Promise<Response> {
  return forward(await fetch(`${apiOrigin()}/api/v1/video/preset-assets`, { cache: "no-store" }));
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.formData();
  return forward(await fetch(`${apiOrigin()}/api/v1/video/preset-assets`, { method: "POST", body }));
}
