import { createServer, type RequestListener, type Server } from 'node:http';

/**
 * Handing supertest an app makes it `listen(0)` on the IPv6 wildcard and then
 * dial 127.0.0.1. On macOS the kernel will give that wildcard socket a port
 * another process already holds on 127.0.0.1 — an IDE's built-in web server, a
 * VPN client, a database tool — and the request lands in that process instead:
 * a 404 from someone else's server, "Parse Error: Expected HTTP/", or a hang to
 * the test timeout, in whichever test happened to draw the port. Measured at
 * about one `listen(0)` in 1,500 on the machine where this was found, so one
 * run in a handful failed in a different, unrelated test each time. Binding
 * 127.0.0.1 explicitly makes the kernel refuse a port that is taken there.
 */
export const listenOnLoopback = (app: RequestListener): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer(app);
    // Node's client agent drops an idle keep-alive socket after 5s, which is
    // also the server's default. Equal timeouts race: a request can be written
    // into a socket the server is closing. The server never times out here, so
    // the client always gives up first.
    server.keepAliveTimeout = 0;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
