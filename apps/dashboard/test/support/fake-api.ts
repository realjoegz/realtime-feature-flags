import { createServer, type Server } from 'node:http';

// An HTTP server on 127.0.0.1 that stands in for the API: it records every request
// and answers each one with what the test's handler returns.

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  /** The Authorization header, or null when the request had none. */
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface FakeApi {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

export type Handler = (request: RecordedRequest) => { status: number; body?: unknown };

export async function startFakeApi(handler: Handler): Promise<FakeApi> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization ?? null,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      };
      requests.push(recorded);
      const reply = handler(recorded);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
