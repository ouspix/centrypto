const WebSocket = require('ws');
const http = require('http');

const PORT = 9222;

function getWebSocketDebuggerUrl() {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.length > 0 && json[0].webSocketDebuggerUrl) {
                        resolve(json[0].webSocketDebuggerUrl);
                    } else {
                        reject(new Error('No debuggable pages found'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function start() {
    try {
        console.log('Fetching WebSocket URL...');
        const wsUrl = await getWebSocketDebuggerUrl();
        console.log(`Connecting to ${wsUrl}`);

        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log('Connected to Chrome!');
            // Enable Runtime domain to get console logs
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
            // Enable Log domain for other logs
            ws.send(JSON.stringify({ id: 2, method: 'Log.enable' }));
            // Enable Page domain and Reload to catch startup logs
            ws.send(JSON.stringify({ id: 3, method: 'Page.enable' }));
            ws.send(JSON.stringify({ id: 4, method: 'Page.reload' }));
            console.log('Reloading page to capture startup logs...');
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data);

            if (msg.method === 'Runtime.consoleAPICalled') {
                const type = msg.params.type.toUpperCase();
                const args = msg.params.args.map(arg => arg.value || arg.description).join(' ');
                console.log(`[CONSOLE ${type}] ${args}`);
            } else if (msg.method === 'Runtime.exceptionThrown') {
                console.error(`[EXCEPTION] ${msg.params.exceptionDetails.text}`);
                if (msg.params.exceptionDetails.exception) {
                    console.error(msg.params.exceptionDetails.exception.description);
                }
            }
        });

        ws.on('error', (err) => {
            console.error('WebSocket Error:', err);
        });

    } catch (err) {
        console.error('Failed to connect:', err.message);
        console.log('Make sure Chrome is running with --remote-debugging-port=9222');
    }
}

start();
