import { handleDiagnostics } from '../server/diagnostics.js';
import { ROAD_DATA_VERSION } from '../dist/version.js';

export default {
  async fetch(request, env, ctx) {
    const diagnosticEnv = { ...env, ROAD_DATA_VERSION };
    try {
      const response = await handleDiagnostics(request, diagnosticEnv, ctx);
      if (response) return response;
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/') || path === '/mcp')
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      if (!env.ASSETS) return new Response('Assets unavailable', { status: 503 });
      const responseAsset = await env.ASSETS.fetch(request);
      const headers = new Headers(responseAsset.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      if (['/', '/index.html', '/sw.js', '/version.js', '/version.json'].includes(path))
        headers.set('Cache-Control', 'no-cache');
      return new Response(responseAsset.body, { status: responseAsset.status, headers });
    } catch {
      // Diagnostic payloads and credentials must never reach runtime logs.
      return Response.json({ error: 'Request could not be completed' }, {
        status: 503, headers: { 'cache-control': 'no-store' }
      });
    }
  }
};
