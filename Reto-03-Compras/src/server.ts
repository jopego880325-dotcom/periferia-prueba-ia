import { createChatServer } from "./chat/server.ts";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT inválido");
const server = createChatServer();
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Reto 03 local disponible en http://127.0.0.1:${listeningPort}`);
});
