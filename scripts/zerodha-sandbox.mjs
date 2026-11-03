import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = 'https://sandbox.kite.trade';
const key = 'sandboxdemo';
const [command = 'login', argument, price, quantityArg = '1', requestTag] = process.argv.slice(2);
const recoveryDir = new URL('../data/kite-sandbox/', import.meta.url);
const intentFile = tag => new URL(`${tag}.json`, recoveryDir);

async function request(path, form, token, method = form ? 'POST' : 'GET') {
    const headers = { 'X-Kite-Version': '3' };
    if (token) headers.Authorization = `token ${key}:${token}`;
    const response = await fetch(`${root}/oms${path}`, {
        method, headers,
        body: form ? new URLSearchParams(form) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Kite sandbox returned HTTP ${response.status}`);
    const result = await response.json();
    if (result.status !== 'success') throw new Error('Kite sandbox did not confirm success');
    return result.data;
}

async function main() {
    if (command === 'login') {
        console.log(`${root}/connect/login?api_key=${key}`);
        return;
    }
    if (command === 'exchange') {
        const requestToken = process.env.KITE_SANDBOX_REQUEST_TOKEN?.trim();
        if (!requestToken) throw new Error('Set KITE_SANDBOX_REQUEST_TOKEN from the sandbox redirect.');
        const checksum = createHash('sha256').update(`${key}${requestToken}sandboxdemo-secret`).digest('hex');
        const session = await request('/session/token', { api_key: key, request_token: requestToken, checksum });
        if (!session?.access_token) throw new Error('Sandbox returned no access token.');
        console.log(session.access_token);
        return;
    }

    const token = process.env.KITE_SANDBOX_ACCESS_TOKEN?.trim();
    if (!token) throw new Error('Set KITE_SANDBOX_ACCESS_TOKEN before querying or submitting sandbox orders.');
    if (command === 'positions') {
        const data = await request('/portfolio/positions', undefined, token);
        if (!Array.isArray(data?.net)) throw new Error('Sandbox returned no net positions list.');
        console.log(JSON.stringify(data.net.filter(position => position.quantity !== 0).map(position => ({
            symbol: position.tradingsymbol, exchange: position.exchange, product: position.product, quantity: position.quantity,
        })), null, 2));
        return;
    }
    if (command === 'submit' || command === 'submit-cancel' || command === 'close-long') {
        if (!/^[A-Z0-9&-]+$/.test(argument ?? '') || !Number.isFinite(Number(price)) || Number(price) <= 0) {
            throw new Error('Provide SYMBOL LIMIT_PRICE.');
        }
        let quantity = Number(quantityArg);
        const side = command === 'close-long' ? 'SELL' : 'BUY';
        if (side === 'SELL') {
            const data = await request('/portfolio/positions', undefined, token);
            const positions = data?.net?.filter(position => position.exchange === 'NSE' && position.product === 'MIS' && position.tradingsymbol === argument && position.quantity > 0);
            if (positions?.length !== 1) throw new Error('No unique open NSE MIS long position for that symbol.');
            const orders = await request('/orders', undefined, token);
            if (orders.some(order => order.exchange === 'NSE' && order.product === 'MIS' && order.tradingsymbol === argument &&
                !['COMPLETE', 'CANCELLED', 'REJECTED'].includes(order.status))) throw new Error('Resolve working sandbox orders for this symbol before closing.');
            quantity = positions[0].quantity;
        }
        if (!/^\d+$/.test(quantityArg) || quantity < 1 || quantity > 10) throw new Error('Sandbox quantity must be a whole number from 1 to 10.');
        const tag = requestTag ?? `dd${randomBytes(8).toString('hex')}`;
        if (!/^dd[a-f0-9]{16}$/.test(tag)) throw new Error('Invalid sandbox submission tag.');
        mkdirSync(recoveryDir, { recursive: true });
        writeFileSync(intentFile(tag), JSON.stringify({ symbol: argument, quantity, side }), { flag: 'wx', flush: true });
        console.error(`Sandbox submission tag: ${tag}`);
        try {
            const order = await request('/orders/regular', {
                exchange: 'NSE', tradingsymbol: argument, transaction_type: side, quantity: String(quantity),
                product: 'MIS', order_type: 'LIMIT', price, validity: 'DAY', tag,
            }, token);
            if (!order?.order_id) throw new Error('Sandbox returned no order ID.');
            console.log(JSON.stringify({ orderId: order.order_id, tag }));
            if (command === 'submit-cancel') {
                if (!/^\d+$/.test(order.order_id)) throw new Error('Sandbox returned an invalid order ID.');
                try {
                    await request(`/orders/regular/${order.order_id}`, undefined, token, 'DELETE');
                    console.log('Sandbox cancellation requested.');
                } catch (error) {
                    console.error(`Cancellation was not confirmed: ${error.message}`);
                    process.exitCode = 1;
                }
                console.log(`Check the outcome with pnpm zerodha:sandbox status ${order.order_id}`);
            }
        } catch (error) {
            throw new Error(`${error.message}. Run pnpm zerodha:sandbox recover ${tag} before considering another submission.`);
        }
        return;
    }
    if (command === 'recover' && /^dd[a-f0-9]{16}$/.test(argument ?? '')) {
        const intent = JSON.parse(readFileSync(intentFile(argument), 'utf8'));
        const orders = await request('/orders', undefined, token);
        const matches = orders.filter(order => order.tag === argument);
        if (matches.length !== 1) {
            throw new Error(`Found ${matches.length} orders for ${argument}. Outcome unresolved. Check the sandbox order book before resubmitting.`);
        }
        const order = matches[0];
        if (!/^\d+$/.test(order.order_id) || order.tradingsymbol !== intent.symbol || order.quantity !== intent.quantity ||
            order.exchange !== 'NSE' || order.product !== 'MIS' || order.transaction_type !== (intent.side ?? 'BUY')) {
            throw new Error('Sandbox order does not match the saved intent. Outcome unresolved.');
        }
        const trades = await request(`/orders/${order.order_id}/trades`, undefined, token);
        const fills = new Map();
        for (const trade of trades) {
            if (trade.order_id !== order.order_id || !trade.trade_id || !Number.isSafeInteger(trade.quantity) || trade.quantity <= 0 ||
                !Number.isFinite(trade.average_price) || trade.average_price <= 0) throw new Error('Invalid sandbox trade. Outcome unresolved.');
            const existing = fills.get(trade.trade_id);
            if (existing && (existing.quantity !== trade.quantity || existing.average_price !== trade.average_price)) {
                throw new Error('Conflicting records for one sandbox trade. Outcome unresolved.');
            }
            fills.set(trade.trade_id, trade);
        }
        const filledQuantity = [...fills.values()].reduce((sum, trade) => sum + trade.quantity, 0);
        if (filledQuantity !== order.filled_quantity || filledQuantity > intent.quantity ||
            (order.status === 'COMPLETE' && filledQuantity !== intent.quantity)) {
            throw new Error('Sandbox order and trade quantities disagree. Run recover again to recheck.');
        }
        console.log(JSON.stringify({ tag: argument, orderId: order.order_id, status: order.status, filledQuantity,
            remainingQuantity: intent.quantity - filledQuantity, uniqueFills: fills.size }, null, 2));
        return;
    }
    if (command === 'lookup' && /^[a-z0-9]{1,20}$/i.test(argument ?? '')) {
        const orders = await request('/orders', undefined, token);
        console.log(JSON.stringify(orders.filter(order => order.tag === argument).map(order => ({
            orderId: order.order_id, status: order.status, filledQuantity: order.filled_quantity,
        })), null, 2));
        return;
    }
    if (command === 'status' && /^\d+$/.test(argument ?? '')) {
        const history = await request(`/orders/${argument}`, undefined, token);
        const trades = await request(`/orders/${argument}/trades`, undefined, token);
        const latest = history.at(-1);
        console.log(JSON.stringify({ statuses: history.map(order => order.status),
            statusMessage: latest?.status_message || latest?.status_message_raw || null, trades }, null, 2));
        return;
    }
    if (command === 'cancel' && /^\d+$/.test(argument ?? '')) {
        await request(`/orders/regular/${argument}`, undefined, token, 'DELETE');
        console.log(`Sandbox cancellation requested. Check status ${argument} for the final result.`);
        return;
    }
    throw new Error('Use login, exchange, positions, close-long SYMBOL LIMIT_PRICE, submit or submit-cancel SYMBOL LIMIT_PRICE [QUANTITY], recover TAG, lookup TAG, status ORDER_ID, or cancel ORDER_ID.');
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
