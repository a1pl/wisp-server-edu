import { createServer } from "node:http";
import { createConnection } from "node:net";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { createMrrowisp } from "mrrowisp";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const WISP_PORT = 6001;

const wispServer = await createMrrowisp()
    .port(WISP_PORT)
    .v2(true)
    .udp(false)
    .dns(["1.1.1.3", "1.0.0.3"])
    .blacklist(["example.com"])
    .onReady(() => console.log(`[mrrowisp] running on port ${WISP_PORT}`))
    .onError((err) => console.error("[mrrowisp]", err))
    .onExit((code, signal) => console.log(`[mrrowisp] exited (code: ${code}, signal: ${signal})`))
    .start();

const fastify = Fastify({
    serverFactory: (handler) => {
        return createServer()
            .on("request", (req, res) => {
                handler(req, res);
            })
            .on("upgrade", (req, socket, head) => {
                if (req.url.startsWith("/wisp")) {
                    // rebuild upgrade request
                    const rawRequest = [
                        `GET / HTTP/1.1`,
                        ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`),
                        "",
                        "",
                    ].join("\r\n");

                    const wispConnection = createConnection(WISP_PORT, "127.0.0.1");
                    wispConnection.on("connect", () => {
                        wispConnection.write(rawRequest);
                        if (head?.length) wispConnection.write(head);
                        wispConnection.pipe(socket);
                        wispConnection.pipe(wispConnection);
                    });
                    wispConnection.on("error", (err) => {
                        console.error("[wisp server]", err);
                        socket.destroy();
                    });
                    socket.on("error", () => wispConnection.destroy());
                } else {
                    fastify.server.emit("upgrade", req, socket, head);
                }
            });
    },
});

fastify.get("/health", async () => ({ status: "ok" }));

fastify.register(fastifyStatic, {
    root: publicPath,
    decorateReply: true,
});

fastify.server.on("listening", () => {
    const address = fastify.server.address();
    console.log("Listening on:");
    console.log(`\thttp://localhost:${address.port}`);
    console.log(`\thttp://${hostname()}:${address.port}`);
    console.log(
        `\thttp://${
            address.family === "IPv6" ? `[${address.address}]` : address.address
        }:${address.port}`
    );
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
    console.log("SIGTERM signal received: closing HTTP server");
    await wispServer.stop();
    await fastify.close();
    process.exit(0);
}

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 2321;

fastify.listen({ port, host: "0.0.0.0" });