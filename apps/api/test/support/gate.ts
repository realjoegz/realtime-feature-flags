import { createConnection, createServer, type Server, type Socket } from 'node:net';

// A TCP relay between one app and Redis that a test can close and open again, so
// that one app loses Redis while the other keeps it. Closing destroys every relayed
// connection and stops listening, so the app's reconnect attempts are refused;
// opening listens again on the same port.

export class Gate {
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;

  private constructor(
    private readonly target: { host: string; port: number },
    readonly port: number,
  ) {}

  /** A gate on 127.0.0.1 to the host and port of url, open. */
  static async open(url: string): Promise<Gate> {
    const { hostname, port } = new URL(url);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port: free } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const gate = new Gate({ host: hostname, port: Number(port || 6379) }, free);
    await gate.reopen();
    return gate;
  }

  /** The URL the app connects to instead of Redis. */
  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  async reopen(): Promise<void> {
    const server = createServer((inbound) => {
      const outbound = createConnection(this.target);
      for (const socket of [inbound, outbound]) {
        this.#sockets.add(socket);
        socket.on('close', () => this.#sockets.delete(socket));
        socket.on('error', () => {});
      }
      inbound.pipe(outbound).pipe(inbound);
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const socket of this.#sockets) socket.destroy();
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
