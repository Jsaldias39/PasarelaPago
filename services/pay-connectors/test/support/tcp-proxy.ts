import { createServer, connect, type Server, type Socket } from 'node:net';

/**
 * Proxy TCP delante de un servidor REAL para provocar caídas sin tocar el servidor: `stop()` corta las conexiones y deja de escuchar (conexión
 * rechazada); `start()` vuelve a escuchar en el MISMO puerto; `hang` acepta conexiones y no responde nunca (un servidor colgado).
 */
export class TcpProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private boundPort = 0;
  hang = false;
  accepted = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    const server = createServer((client) => {
      this.accepted += 1;
      this.sockets.add(client);
      client.on('close', () => this.sockets.delete(client));
      client.on('error', () => client.destroy());
      if (this.hang) return;
      const upstream = connect(this.target.port, this.target.host);
      this.sockets.add(upstream);
      upstream.on('close', () => this.sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.boundPort, '127.0.0.1', () => resolve());
    });
    this.boundPort = (server.address() as { port: number }).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
