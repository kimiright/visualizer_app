export default function handler(request) {
  // 检查请求是否为 WebSocket 升级请求
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Please use a WebSocket client.", { status: 400 });
  }

  // 升级连接到 WebSocket
  const { socket, response } = Deno.upgradeWebSocket(request);

  // 连接建立时的日志
  socket.onopen = () => {
    console.log("[ECHO SERVER] WebSocket connection established.");
    socket.send("Echo server connected. Send a message!");
  };

  // 收到消息时的处理逻辑
  socket.onmessage = (event) => {
    const message = event.data;
    console.log("[ECHO SERVER] Received message:", message);
    
    // 将收到的消息原样返回
    socket.send(`Echo: ${message}`);
  };

  // 连接关闭时的日志
  socket.onclose = () => {
    console.log("[ECHO SERVER] WebSocket connection closed.");
  };

  // 发生错误时的日志
  socket.onerror = (error) => {
    console.error("[ECHO SERVER] WebSocket error:", error);
  };

  // 返回响应以完成 WebSocket 握手
  return response;
}