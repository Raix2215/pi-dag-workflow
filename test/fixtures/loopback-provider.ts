/**
 * A local OpenAI-compatible endpoint for tests that must observe what the SDK really serializes.
 *
 * The point is the request *body*: an extension hook such as the scripted provider's `onPayload` only sees a
 * summary it was handed, so "the delivery wrapper is in the context" cannot be proven from it. Here the bytes
 * the native adapter put on the wire are recorded verbatim, which is the same surface a real provider sees.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackRequest { readonly body: string; readonly authorization?: string }
export interface LoopbackProvider {
  readonly requests: LoopbackRequest[];
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Streams one text answer as `chat.completion.chunk`s, exactly like an OpenAI-compatible server would. */
export async function startLoopbackProvider(reply = 'loopback reply'): Promise<LoopbackProvider> {
  const requests: LoopbackRequest[] = [];
  const server: Server = createServer((request, response) => {
    const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), ...(authorization === undefined ? {} : { authorization }) });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: 'loopback-74', object: 'chat.completion.chunk', created: 1, model: 'scripted-loopback' };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The `models.json` a provider registered on disk needs, so a real host process uses the native adapter. */
export function loopbackModelsJson(baseUrl: string, apiKey = 'loopback-test-key'): string {
  return JSON.stringify({
    providers: {
      loopback74: {
        name: 'Loopback 74',
        baseUrl,
        api: 'openai-completions',
        apiKey,
        authHeader: true,
        models: [{ id: 'scripted-loopback', name: 'Loopback scripted', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }],
      },
    },
  });
}

export interface CodexLoopbackRequest {
  readonly path: string;
  /** The body after decoding `content-encoding`, which is the only honest view of what the adapter sent. */
  readonly body: string;
  readonly raw: Buffer;
  readonly encoding?: string;
  readonly authorization?: string;
  readonly accountId?: string;
  readonly remoteAddress?: string;
}
export interface CodexLoopback {
  readonly requests: CodexLoopbackRequest[];
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * A structurally valid, entirely fake Codex token: three segments, a base64 payload carrying the account claim
 * the adapter extracts. Nothing here is a credential and no real token is read.
 */
export function fakeCodexJwt(accountId = 'acct-loopback-74'): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
  return [segment({ alg: 'none', typ: 'JWT' }), segment({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }), 'signature-not-checked'].join('.');
}

/** Decodes per header, or fails loudly: comparing compressed bytes as text would be a fixture error, not a red. */
async function decodeBody(raw: Buffer, encoding: string | undefined): Promise<string> {
  if (encoding !== 'zstd') return raw.toString('utf8');
  const zlib = await import('node:zlib') as { zstdDecompressSync?: (input: Buffer) => Buffer };
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('the adapter sent a zstd request but this Node has no zstd decoder: the fixture refuses to compare raw bytes');
  }
  return zlib.zstdDecompressSync(raw).toString('utf8');
}

/**
 * The Codex path: `POST /codex/responses` with `Authorization: Bearer <token>` and `chatgpt-account-id`, answered
 * with the Responses SSE event stream. Only a loopback peer is served, so a stray fetch cannot reach it.
 */
export async function startCodexLoopback(reply = 'codex loopback reply'): Promise<CodexLoopback> {
  const requests: CodexLoopbackRequest[] = [];
  const server: Server = createServer((request, response) => {
    const remoteAddress = request.socket.remoteAddress ?? '';
    const loopbackPeer = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const header = (name: string) => { const value = request.headers[name]; return typeof value === 'string' ? value : undefined; };
      const encoding = header('content-encoding');
      if (!loopbackPeer) { response.writeHead(403); response.end('non-loopback peer'); return; }
      const authorization = header('authorization'), accountId = header('chatgpt-account-id');
      void decodeBody(raw, encoding).then(body => {
        requests.push({
          path: request.url ?? '',
          body,
          raw,
          ...(encoding === undefined ? {} : { encoding }),
          ...(authorization === undefined ? {} : { authorization }),
          ...(accountId === undefined ? {} : { accountId }),
          remoteAddress,
        });
        const send = (event: { type: string }) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        const item = { type: 'message', id: 'msg-74', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        send({ type: 'response.created', response: { id: 'resp-74', status: 'in_progress' } } as never);
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } } as never);
        send({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg-74', content_index: 0, delta: reply } as never);
        send({ type: 'response.output_item.done', output_index: 0, item } as never);
        send({ type: 'response.completed', response: { id: 'resp-74', status: 'completed', output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } } as never);
        response.end();
      }).catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { requests, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The provider entry a real host reads: the Codex api on a loopback base URL, with a fake token as the key. */
export function codexModelsJson(baseUrl: string, apiKey: string): string {
  return JSON.stringify({
    providers: {
      codex74: {
        name: 'Codex loopback 74',
        baseUrl,
        api: 'openai-codex-responses',
        apiKey,
        models: [{ id: 'codex-loopback', name: 'Codex loopback', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }],
      },
    },
  });
}
