// api/proxy.js

// --- 部分 1: 从 request_handler.js 移植的回退逻辑 ---
const FALLBACK_DATA_SOURCES = [
    'bilibili.com', 'weibo.com', 'douyin.com', 'huya.com',
    'cloudflare.com', 'v2ex.com'
];

// --- 部分 2: 从 stream_handler.js 完整复制的核心代理逻辑 ---
// --- Configuration Loader ---
const getConfig = () => {
    const datasetId = Deno.env.get("datasetId");
    const apiKey = Deno.env.get("apiKey");
    if (!datasetId || !apiKey) {
        console.error("Environment variables datasetId and apiKey are required.");
        // In a serverless environment, throwing an error is better than Deno.exit()
        throw new Error("Missing required environment variables.");
    }
    return { datasetId, apiKey };
};

// --- API Virtualization ---
const API_MAP = {
    connect: Deno.connect,
    digest: crypto.subtle.digest.bind(crypto.subtle),
};

// --- Helper Functions ---
function generateUUID(data) {
    const toHex = byte => byte.toString(16).padStart(2, '0');
    let uuid = '';
    for (let i = 0; i < 16; i++) {
        uuid += toHex(data[i]);
        if (i === 3 || i === 5 || i === 7 || i === 9) uuid += '-';
    }
    return uuid;
}

async function parseVlessData(data, config) {
    if (data.length < 18 || generateUUID(data.slice(1, 17)).toLowerCase() !== config.datasetId.toLowerCase()) {
        throw new Error(`Invalid VLESS datasetId. Expected: ${config.datasetId}`);
    }
    let offset = 17;
    const addonsLength = data[offset];
    offset += 1;
    if (data.length < offset + addonsLength) {
        throw new Error(`Incomplete VLESS packet: addon data is missing.`);
    }
    offset += addonsLength;
    if (data.length < offset + 4 || data[offset++] !== 1) throw new Error("Invalid VLESS command/structure after addons");
    const port = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    const addrType = data[offset++];
    let address;
    switch (addrType) {
        case 1: address = Array.from(data.slice(offset, offset + 4)).join('.'); offset += 4; break;
        case 2: const len = data[offset++]; address = new TextDecoder().decode(data.slice(offset, offset + len)); offset += len; break;
        case 3: const ipv6Bytes = []; for (let i = 0; i < 8; i++) ipv6Bytes.push(data.slice(offset + i * 2, offset + (i + 1) * 2).map(b => b.toString(16).padStart(2, '0')).join('')); address = ipv6Bytes.join(':'); offset += 16; break;
        default: throw new Error(`Unsupported VLESS address type: ${addrType}`);
    }
    return { address, port, payload: data.slice(offset), protocol: 'VLESS' };
}

async function parseTrojanData(data, config) {
    if (data.length < 56 + 2 + 1 + 1 + 2) throw new Error(`Invalid Trojan data length: ${data.length}`);
    const passwordHash = Array.from(new Uint8Array(data.slice(0, 56))).map(b => b.toString(16).padStart(2, '0')).join('');
    const passwordData = new TextEncoder().encode(config.apiKey);
    const expectedHashBuffer = await API_MAP.digest('SHA-224', passwordData);
    const expectedHash = Array.from(new Uint8Array(expectedHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (passwordHash !== expectedHash.slice(0, 56)) throw new Error("Invalid Trojan apiKey (password)");
    if (data[56] !== 13 || data[57] !== 10) throw new Error("Invalid Trojan CRLF");
    let offset = 58;
    const addrType = data[offset++];
    let address;
    switch (addrType) {
        case 1: address = Array.from(data.slice(offset, offset + 4)).join('.'); offset += 4; break;
        case 3: const len = data[offset++]; address = new TextDecoder().decode(data.slice(offset, offset + len)); offset += len; break;
        case 4: const ipv6Bytes = []; for (let i = 0; i < 8; i++) ipv6Bytes.push(data.slice(offset + i * 2, offset + (i + 1) * 2).map(b => b.toString(16).padStart(2, '0')).join('')); address = ipv6Bytes.join(':'); offset += 16; break;
        default: throw new Error(`Unsupported Trojan address type: ${addrType}`);
    }
    const port = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    if (data[offset] !== 13 || data[offset + 1] !== 10) throw new Error("Invalid Trojan Port CRLF");
    offset += 2;
    return { address, port, payload: data.slice(offset), protocol: 'Trojan' };
}

async function parseDataPacket(data, config) {
    try {
        return await parseVlessData(data, config);
    } catch (vlessError) {
        // Ignore and try next format
    }
    try {
        return await parseTrojanData(data, config);
    } catch (trojanError) {
        // Ignore and throw generic error
    }
    throw new Error("Unknown data packet format. Both VLESS and Trojan parsing failed.");
}

// --- Main Connection Handler ---
async function handleChartConnection(socket) {
    const config = getConfig();
    let upstreamConnection = null;
    let isProxyStarted = false;

    const cleanUp = () => {
        if (upstreamConnection) {
            try {
                upstreamConnection.close();
            } catch (e) {
                if (!e.message.includes("Bad resource ID")) {
                    console.error("Error closing upstream connection:", e.message);
                }
            }
            upstreamConnection = null;
        }
    };

    const startProxyPipeline = async (parsedRequest) => {
        const { address, port, payload, protocol } = parsedRequest;
        try {
            upstreamConnection = await API_MAP.connect({ hostname: address, port });
        } catch (err) {
            console.error(`Upstream connection to ${address}:${port} failed:`, err);
            if (socket.readyState === WebSocket.OPEN) {
                socket.close(1011, "Upstream connection failed");
            }
            return;
        }

        if (protocol === 'VLESS' && socket.readyState === WebSocket.OPEN) {
            socket.send(new Uint8Array([0, 0]));
        }

        isProxyStarted = true;

        const wsReadable = new ReadableStream({
            start(controller) {
                if (payload && payload.length > 0) {
                    controller.enqueue(payload);
                }
                socket.onmessage = (msgEvent) => controller.enqueue(new Uint8Array(msgEvent.data));
                socket.onclose = () => { try { controller.close(); } catch (e) { /* ignore */ } };
                socket.onerror = (err) => controller.error(err);
            },
            cancel() {
                cleanUp();
            }
        });

        const wsWritable = new WritableStream({
            write(chunk) {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(chunk);
                }
            },
            close() { }
        });

        try {
            await Promise.all([
                wsReadable.pipeTo(upstreamConnection.writable, { preventClose: true }),
                upstreamConnection.readable.pipeTo(wsWritable, { preventClose: true })
            ]);
        } catch (error) {
            // console.log("Pipe closed.", error.message);
        } finally {
            cleanUp();
            if (socket.readyState === WebSocket.OPEN) {
                socket.close();
            }
        }
    };

    socket.onmessage = async (event) => {
        if (isProxyStarted) return;
        const data = new Uint8Array(event.data);
        try {
            const parsedRequest = await parseDataPacket(data, config);
            await startProxyPipeline(parsedRequest);
        } catch (error) {
            console.error("Failed to parse initial data packet:", error.message);
            socket.close(1002, "Invalid data format");
        }
    };

    socket.onclose = cleanUp;
    socket.onerror = (e) => {
        console.error("WebSocket error:", e.message);
        cleanUp();
    };
}


// --- 部分 3: Vercel Serverless Function 主入口 ---
export default async function handler(request) {
    console.log(`[LOG] Incoming request: ${request.method} ${request.url}`);
    console.log('[LOG] Request headers:', JSON.stringify(Object.fromEntries(request.headers.entries()), null, 2));
    const upgradeHeader = request.headers.get('Upgrade');

    // 路由 1: 处理 WebSocket 代理请求
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        try {
            const { socket, response } = Deno.upgradeWebSocket(request);
            handleChartConnection(socket);
            return response;
        } catch (error) {
            console.error('[ERROR] An error occurred in the handler:', error);
            console.error("WebSocket upgrade failed:", error);
            return new Response("WebSocket upgrade failed", { status: 400 });
        }
    }

    // 路由 2: 处理所有其他 HTTP 请求 (反检测回退)
    const url = new URL(request.url);
    const randomIndex = Math.floor(Math.random() * FALLBACK_DATA_SOURCES.length);
    const targetDomain = FALLBACK_DATA_SOURCES[randomIndex];
    const proxyUrl = `https://${targetDomain}${url.pathname}${url.search}`;
    
    return Response.redirect(proxyUrl, 302);
}