const $ = id => document.getElementById(id);
const status = $('sandbox-status');
const tagInput = $('tag');
const cancel = $('cancel-order');
let pending = localStorage.getItem('dipdaemon-sandbox-pending');
let enabled = false;
let busy = false;
let order;
tagInput.value = pending ?? '';

function controls() {
    $('ticket-fields').disabled = !enabled || busy || Boolean(pending);
    $('recover-order').querySelector('button').disabled = !enabled || busy;
    cancel.disabled = !enabled || busy || order?.status !== 'OPEN' || order.tag !== tagInput.value;
}

async function call(action, input) {
    const response = await fetch(`/api/sandbox/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
}

async function perform(action) {
    if (busy || !enabled) return;
    busy = true;
    controls();
    try { await action(); }
    catch (error) { status.textContent = error.message; }
    finally { busy = false; controls(); }
}

async function recover() {
    order = undefined;
    order = await call('recover', { tag: tagInput.value });
    if (pending === order.tag && ['COMPLETE', 'CANCELLED', 'REJECTED'].includes(order.status)) {
        localStorage.removeItem('dipdaemon-sandbox-pending');
        pending = null;
    }
    status.textContent = `Order ${order.orderId} · ${order.status} · ${order.filledQuantity} filled · ${order.remainingQuantity} unfilled`;
}

$('sandbox-order').addEventListener('submit', event => {
    event.preventDefault();
    if (pending) return;
    void perform(async () => {
        pending = 'dd' + Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('dipdaemon-sandbox-pending', pending);
        tagInput.value = pending;
        const result = await call('submit', { tag: pending, symbol: $('symbol').value.trim().toUpperCase(), price: $('price').valueAsNumber, quantity: $('quantity').valueAsNumber });
        status.textContent = `Order ${result.orderId} acknowledged. Check status and fills.`;
    });
});
$('recover-order').addEventListener('submit', event => { event.preventDefault(); void perform(recover); });
tagInput.addEventListener('input', controls);
cancel.addEventListener('click', () => void perform(async () => {
    await call('cancel', { orderId: order.orderId });
    order = undefined;
    status.textContent = 'Cancellation requested. Check status and fills for the final outcome.';
}));

try {
    const response = await fetch('/api/sandbox');
    if (!response.ok) throw new Error('Could not check sandbox configuration.');
    ({ enabled } = await response.json());
    status.textContent = enabled ? pending ? 'Check the saved submission before placing a new order.' : 'Sandbox ready.' : 'Set KITE_SANDBOX_ACCESS_TOKEN and restart DipDaemon.';
} catch (error) { status.textContent = error.message; }
controls();

const liveMode = new URLSearchParams(location.search).get('mode') === 'live';
if (liveMode) {
    document.title = 'Kite live bot · DipDaemon';
    document.querySelector('h1').textContent = 'Kite live bot';
    document.querySelector('main > p').textContent = 'Arming allows the bot to place real-money orders.';
    document.querySelectorAll('main > section:not(#sandbox-bot)').forEach(section => { section.hidden = true; });
    $('sandbox-bot').querySelector('h2').textContent = 'Production bot';
    $('sandbox-bot').querySelector('.panel-body > p').textContent = 'Pausing blocks new entries. Existing positions remain managed.';
    $('arm-bot').textContent = 'Arm live bot';
}

async function refreshBot() {
    const response = await fetch(liveMode ? '/api/live/bot' : '/api/sandbox/bot');
    if (!response.ok) throw new Error('Could not check sandbox bot.');
    const bot = await response.json();
    $('sandbox-bot').hidden = !liveMode && !bot.available;
    $('bot-status').textContent = bot.reason ?? (!bot.ready ? 'Waiting for startup reconciliation.' : bot.armed ? 'Armed' : 'Disarmed');
    $('arm-bot').disabled = !bot.ready || bot.armed;
    $('pause-bot').disabled = !bot.armed;
}
for (const [id, action] of [['arm-bot', 'arm'], ['pause-bot', 'pause']]) {
    $(id).addEventListener('click', async () => {
        $(id).disabled = true;
        try {
            if (liveMode) {
                const response = await fetch('/api/live/bot/' + action, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
                if (!response.ok) throw new Error((await response.json()).error ?? 'Live bot request failed.');
            } else {
                await call('bot/' + action, {});
            }
            await refreshBot();
        }
        catch (error) { $('bot-status').textContent = error.message; $(id).disabled = false; }
    });
}
function pollBot() { void refreshBot().catch(error => { $('bot-status').textContent = error.message; }); }
pollBot();
setInterval(pollBot, 3000);
