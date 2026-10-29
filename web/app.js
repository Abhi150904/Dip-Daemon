import { escapeHtml as e, money, number, time, tone, riskStatus } from './format.js';
const $ = id => document.getElementById(id);
const pages = { overview: ['Overview', 'Your account, risk and latest strategy decisions.'], scanner: ['Market Scanner', 'Nifty 50 prices, candidates and signal reasons.'], trading: ['Paper Trading', 'Place virtual orders and manage your positions.'], strategies: ['Strategies', 'Configure automation and review each decision.'], journal: ['Trade Journal', 'Closed trades, costs and the reasons behind them.'], backtesting: ['Backtesting', 'Strategy evaluation is planned for Phase 4.'], settings: ['Settings', 'Account limits, data configuration and system activity.'] };
let data, page, offline = true, fetching = false, busy = false, prefill;
const keys = new Map();
const badge = value => `<span class="badge ${e(value)}">${e(value)}</span>`;
const empty = copy => `<div class="empty">${e(copy)}</div>`;
const cash = (value, signed = false) => `<span class="num ${signed ? tone(value) : ''}">${money(value, signed)}</span>`;
const button = (action, id, label, extra = '') => `<button type="button" class="button secondary small-button" data-account data-action="${action}" data-id="${e(id)}" ${extra}>${e(label)}</button>`;
const panel = (title, content, note = '') => `<section class="panel"><div class="panel-head"><div><h2>${title}</h2>${note ? `<p>${note}</p>` : ''}</div></div>${content}</section>`;
const table = (heads, rows, copy = 'Nothing to show yet.') => rows.length ? `<div class="table-wrap"><table><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty(copy);
function slot(id, html) { const el = $(id); if (el && !el.contains(document.activeElement))
    el.innerHTML = html; }
function feedback(copy, error = false) { $('feedback').hidden = false; $('feedback').className = `feedback${error ? ' error' : ''}`; $('feedback').textContent = copy; }
class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}
async function request(path, body, accepted = []) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), cache: 'no-store', signal: AbortSignal.timeout(22000) });
    let result;
    try {
        result = JSON.parse(await response.text());
    }
    catch {
        throw new ApiError('Unexpected server response.', response.status);
    }
    if (!response.ok && !accepted.includes(response.status))
        throw new ApiError(result.error || result.reason || `Request failed (${response.status}).`, response.status);
    return result;
}
async function act(fn) { if (busy || offline)
    return; busy = true; controls(); try {
    await fn();
}
catch (error) {
    feedback(error.message, true);
}
finally {
    busy = false;
    await refresh();
} }
async function submitOrder(payload) {
    const signature = JSON.stringify(payload);
    if (!keys.has(signature))
        keys.set(signature, crypto.randomUUID());
    try {
        const result = await request('/api/paper/orders', { ...payload, idempotencyKey: keys.get(signature) });
        keys.delete(signature);
        return result;
    }
    catch (error) {
        if (error instanceof ApiError && error.status < 500)
            keys.delete(signature);
        else
            throw new Error('Order response was interrupted. Refresh and retry the same ticket; its request key is preserved to prevent duplication.');
        throw error;
    }
}
function confirmAction(title, copy) { $('confirm-title').textContent = title; $('confirm-copy').textContent = copy; const dialog = $('confirmation'); dialog.returnValue = ''; dialog.showModal(); return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true })); }
const field = (name, label, type = 'number', attrs = '') => `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" ${attrs}></div>`;
function ticket() {
    return panel('New paper order', `<form id="ticket" class="panel-body">
${field('symbol', 'Symbol', 'text', 'value="INFY" list="symbols" required pattern="[A-Za-z0-9&.\\-]+" maxlength="40"')}<datalist id="symbols"></datalist>
<div class="form-grid"><div class="field"><label for="side">Side</label><select id="side" name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></div>${field('qty', 'Shares', 'number', 'value="1" min="1" step="1" required')}</div>
<div class="field"><label for="type">Order type</label><select id="type" name="type"><option value="market">Market</option><option value="limit">Limit</option></select></div>
<div id="limit-field" hidden>${field('limitPrice', 'Limit price · INR', 'number', 'min="0.01" step="0.01" placeholder="100.00"')}</div>
<div id="stop-field">${field('stopLoss', 'Stop-loss · INR (optional)', 'number', 'min="0.01" step="0.01" placeholder="95.00"')}</div>
<p id="ticket-quote" class="ticket-note"></p><div class="ticket-summary"><span>Estimated order value</span><strong id="estimate">—</strong></div><div class="ticket-summary"><span>Available cash</span><strong id="ticket-cash">—</strong></div><button data-account class="button primary" id="place-order">Place paper buy</button><p class="ticket-note">Virtual funds only. Final fills include spread, slippage and estimated fees. Orders remain subject to backend risk checks.</p></form>`);
}
function policy() { return panel('Automation policy', `<form id="policy" data-policy class="panel-body"><p class="strategy-description">VWAP momentum uses deterministic price and volume rules. Jev uses the configured model and requires fresh market context.</p><div class="form-grid"><div class="field"><label for="strategy">Strategy</label><select name="strategy" id="strategy"><option value="vwap_momentum">VWAP momentum</option><option value="jev" id="jev-option">Jev model</option></select></div><div class="field"><label for="mode">Execution policy</label><select id="mode" name="mode"><option value="off">Off · observe signals</option><option value="approval">Approval required</option><option value="automatic">Automatic paper orders</option></select></div>${field('scanIntervalS', 'Scan interval · seconds', 'number', 'min="5" max="3600" required')}${field('cooldownS', 'Symbol cooldown · seconds', 'number', 'min="0" max="86400" required')}${field('signalTtlS', 'Signal lifetime · seconds', 'number', 'min="5" max="300" required')}${field('minScore', 'Minimum score', 'number', 'min="0" max="1" step="0.01" required')}</div><div class="form-actions">${button('pause', '', 'Pause automation')}<button data-account class="button primary">Save policy</button></div><p class="ticket-note">Configuration changes expire pending approvals. Automation manages positions it opened; manual holdings stay under your control.</p></form>`); }
function skeleton() {
    switch (page) {
        case 'overview': return `<div class="grid"><div>${panel('Closed-trade P&L', '<div id="curve"></div>', 'Cumulative net result; open positions are excluded.')}${panel('Open positions', '<div id="positions"></div>')}${panel('Latest decisions', '<div id="signals"></div>')}</div><div>${panel('Execution & risk', '<div class="panel-body" id="risk"></div>')}${panel('Recent activity', '<div id="activity"></div>')}</div></div>`;
        case 'trading': return `<div class="grid trading"><div>${panel('Positions', '<div id="positions"></div>')}${panel('Orders', '<div class="toolbar"><label for="order-filter">Status</label><select id="order-filter"><option value="all">All orders</option><option value="open">Open</option><option value="filled">Filled</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select></div><div id="orders"></div>')}</div><div class="ticket">${ticket()}</div></div>`;
        case 'scanner': return panel('Nifty 50 universe', '<div class="toolbar"><input id="search" type="search" aria-label="Search symbols" placeholder="Search symbols…"><label class="checkbox-label"><input id="quoted" type="checkbox">With quotes only</label><span id="quote-count" class="muted"></span></div><div id="scanner"></div>');
        case 'strategies': return `<div class="equal-grid">${policy()}${panel('How execution works', '<ul class="rule-list panel-body"><li><strong>Off</strong>Scans record research signals without placing orders.</li><li><strong>Approval required</strong>Review fresh signals and approve each virtual order.</li><li><strong>Automatic paper orders</strong>Eligible signals execute within account risk limits.</li><li><strong>Stop conditions</strong>Stale quotes, risk halts and emergency stop block new buys. Stops and time-based exits remain backend responsibilities.</li></ul>')}</div>${panel('Signal review', '<div id="signals"></div>')}${panel('Evaluation history', '<div id="runs"></div>')}`;
        case 'journal': return panel('Closed trades', '<div class="toolbar"><input id="search" type="search" aria-label="Search trade journal" placeholder="Search symbols or reasons…"><span class="muted" id="journal-total"></span></div><div id="trades"></div>');
        case 'backtesting': return panel('Repeatable strategy evaluation', '<div class="backtest-intro"><h2>Build evidence before trusting a strategy.</h2><p>Phase 4 will add historical date selection, strategy comparisons, starting capital, equity curves, drawdown, win rate and profit factor. These results are not available yet.</p><p>The existing replay tools remain available for inspecting recorded sessions.</p><a class="button secondary section-gap" href="/legacy.html">Open legacy replay tools</a><div>' + badge('Phase 4 · planned') + '</div></div>') + panel('Recorded sessions', '<div id="history"></div>');
        case 'settings': return `<div class="equal-grid">${panel('Paper account & limits', '<div id="limits" class="panel-body"></div>')}${panel('Data & model', '<div id="configuration" class="panel-body"></div>')}</div>${panel('Strategy risk parameters', `<form id="advanced" data-policy class="panel-body"><div class="form-grid">${[['momentumBps', 'Minimum momentum · bps', 1, 100, 1], ['minVolumeRatio', 'Minimum volume ratio', .1, 10, .1], ['stopAtrMult', 'Stop ATR multiplier', .1, 10, .1], ['maxStopBps', 'Maximum stop distance · bps', 10, 500, 1], ['maxPriceDriftBps', 'Maximum entry drift · bps', 1, 500, 1], ['maxHoldMinutes', 'Maximum hold · minutes', 1, 360, 1], ['modelTimeoutMs', 'Model timeout · milliseconds', 10, 60000, 1]].map(([n, l, min, max, step]) => field(n, l, 'number', `min="${min}" max="${max}" step="${step}" required`)).join('')}</div><div class="form-actions"><button data-account class="button primary">Save strategy parameters</button></div></form>`)}${panel('System activity', '<div id="activity"></div>')}`;
    }
}
function route() {
    page = Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    $('navigation').innerHTML = Object.entries(pages).map(([id, [title]]) => `<a href="#${id}" ${id === page ? 'aria-current="page"' : ''}>${title}</a>`).join('');
    $('page-title').textContent = pages[page][0];
    $('page-description').textContent = pages[page][1];
    $('view').innerHTML = skeleton();
    if (prefill && $('symbol')) {
        $('symbol').value = prefill;
        prefill = null;
    }
    $('view').addEventListener('input', onInput);
    window.scrollTo(0, 0);
    render();
}
function onInput(event) { if (event.target.form?.hasAttribute('data-policy'))
    event.target.form.dataset.dirty = 'true'; if (event.target.closest('#ticket'))
    updateTicket();
else if (!event.target.form)
    renderContent(); }
function positions() { return table(['Symbol', 'Shares', 'Avg. entry', 'Mark', 'Stop-loss', 'Unrealized net', ''], data.positions.map(p => [e(p.symbol), number(p.qty), cash(p.averageEntryPaise), cash(p.marketValuePaise === null ? null : p.mark_paise), cash(p.stop_paise), cash(p.unrealizedPnlPaise, true), p.availableShares ? button('close', p.symbol, `Close ${p.availableShares} shares`) : 'Shares reserved']), 'No open positions. Place a paper order to get started.'); }
function orders() { const filter = $('order-filter')?.value || 'all'; return table(['Time · IST', 'Symbol / side', 'Type', 'Shares', 'Price', 'Status', 'Details / actions'], data.orders.filter(o => filter === 'all' || o.status === filter).slice().reverse().map(o => [time(o.created_at, true), `${e(o.symbol)}<br>${badge(o.side)}`, e(o.type), number(o.qty), cash(o.fill_paise ?? o.limit_paise), badge(o.status), o.status === 'open' ? `${button('cancel', o.id, 'Cancel')}<details class="detail"><summary>Modify limit</summary><form class="inline-modify" data-modify="${e(o.id)}"><input name="limitPrice" aria-label="New limit price for ${e(o.symbol)}" type="number" min="0.01" step="0.01" value="${o.limit_paise / 100}" required><button data-account class="button secondary small-button">Save</button></form></details>` : e(o.reason)])); }
function signals(compact = false) { return table(['Symbol / action', 'Score', 'Status', 'Reason / review'], data.signals.slice(0, compact ? 5 : 100).map(s => [`${e(s.symbol)}<br>${badge(s.action.toLowerCase())}`, number(s.signal.score * 100, 1) + '%', badge(s.status), `<div class="reason">${e(s.reason)}<details class="detail"><summary>Decision details</summary><p>Strategy: ${e(s.strategy)} · ${e(s.signal.strategyVersion)}</p><p>Model: ${e(s.signal.modelVersion)}</p><p>Quote: ${time(s.signal.quoteTs, true)}</p><p>Expires: ${time(s.signal.expiresAt, true)}</p><p>Entry: ${money(s.signal.entryPrice == null ? null : Math.round(s.signal.entryPrice * 100))} · Stop: ${money(s.signal.stopLoss == null ? null : Math.round(s.signal.stopLoss * 100))}</p></details>${!compact && s.status === 'pending' ? button('approve', s.id, `Approve ${s.action} ${s.symbol}`) + button('reject', s.id, `Reject ${s.symbol}`) : ''}</div>`]), 'No strategy decisions yet. Run a market scan.'); }
function activity() {
    return [...data.events, ...data.strategyEvents].sort((a, b) => b.ts - a.ts).slice(0, page === 'overview' ? 6 : 20).map(ev => {
        let detail = ev.detail;
        try {
            if (typeof detail === 'string')
                detail = JSON.parse(detail);
        }
        catch { /* Audit details may be plain text. */ }
        const copy = typeof detail === 'object' && detail !== null ? detail.signal?.reason || detail.reason || (detail.price ? 'Fill ' + money(detail.price) + ' · estimated fee ' + money(detail.fee) : 'Account event recorded') : String(detail ?? '');
        return '<div class="log-item"><small>' + time(ev.ts, true) + ' · ' + e(ev.kind) + '</small>' + e(copy) + '<details class="detail"><summary>Audit details</summary><p>' + e(typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail)) + '</p></details></div>';
    }).join('') || empty('No account activity yet.');
}
function pairs(items) { return '<dl class="definitions">' + items.map(([label, value]) => `<div class="definition-row"><dt>${e(label)}</dt><dd>${value}</dd></div>`).join('') + '</dl>'; }
function renderContent() {
    if (!data)
        return;
    if ($('positions'))
        slot('positions', positions());
    if ($('signals'))
        slot('signals', signals(page === 'overview'));
    if ($('orders'))
        slot('orders', orders());
    if ($('activity'))
        slot('activity', activity());
    if (page === 'overview') {
        const a = data.account, auto = data.automation;
        slot('risk', pairs([['Automation', badge(auto?.settings.mode || 'unavailable')], ['Strategy', e(auto?.settings.strategy || 'Unavailable')], ['Risk', riskStatus(a)], ['Open positions', `${data.positions.length} / ${a?.settings.maxPositions ?? '—'}`], ['Reserved cash', money(a?.reservedCash)], ['Fees to date', money(a?.fees)]]) + `<a class="button secondary section-gap" href="#strategies">Manage strategy</a> ${button(a?.killed ? 'resume' : 'kill', '', a?.killed ? 'Clear emergency stop' : 'Emergency stop')}`);
        slot('curve', chart());
    }
    if (page === 'scanner') {
        const query = $('search').value.toUpperCase(), quotes = new Map(data.market.quotes.map(q => [q.symbol, q]));
        const universe = [...data.market.universe];
        const rows = universe.filter(s => s.includes(query) && (!$('quoted').checked || quotes.has(s))).sort((a, b) => Number(quotes.has(b)) - Number(quotes.has(a)) || (data.signals.find(s => s.symbol === b)?.signal.score ?? -1) - (data.signals.find(s => s.symbol === a)?.signal.score ?? -1)).map((symbol, index) => {
            const q = quotes.get(symbol), s = data.signals.find(s => s.symbol === symbol), fresh = q && data.now - q.ts <= (data.account?.settings.quoteMaxAgeMs ?? 15000);
            return [s ? number(index + 1) : '—', e(symbol), money(q ? Math.round(q.ltp * 100) : null), q?.close ? number((q.ltp / q.close - 1) * 100, 2) + '%' : '—', number(q?.volume), number(q?.atrPercent, 2), number(q?.rvol, 2), s ? number(s.signal.score * 100, 1) + '%' : '—', s ? badge(s.status) + '<div class="reason">' + e(s.reason) + '</div>' : 'No signal', q ? time(q.ts) : 'No quote', button('trade', symbol, 'Trade', fresh ? '' : 'disabled data-stale')];
        });
        slot('scanner', table(['Rank¹', 'Symbol', 'Price', 'Change', 'Volume', 'ATR %', 'Relative vol.', 'Latest score', 'Signal / reason', 'Quote · IST', ''], rows, 'No symbols match this filter.'));
        $('quote-count').textContent = `${quotes.size} quotes · ${universe.length} symbols · ¹ latest signal score`;
    }
    if (page === 'trading')
        $('symbols').innerHTML = data.market.universe.map(s => `<option value="${e(s)}">`).join('');
    if (page === 'strategies')
        slot('runs', table(['Started · IST', 'Strategy', 'Status', 'Result'], data.runs.slice(0, 30).map(r => [time(r.started_at, true), e(r.strategy), badge(r.status), e(r.reason)]), 'No strategy evaluations yet.'));
    if (page === 'journal') {
        const query = $('search').value.toLowerCase();
        const trades = data.trades.filter(t => `${t.symbol} ${t.reason}`.toLowerCase().includes(query));
        slot('trades', table(['Entry / exit · IST', 'Symbol', 'Shares', 'Entry / share', 'Exit / share', 'Costs', 'Net P&L', 'Explanation'], trades.map(t => {
            const entry = data.orders.find(o => o.side === 'buy' && o.symbol === t.symbol && o.created_at === t.opened_at), signal = data.signals.find(s => s.order_id === entry?.id);
            return [`${time(t.opened_at, true)}<br>${time(t.closed_at, true)}`, e(t.symbol), number(t.qty), cash(t.entry_paise / t.qty), cash(t.exit_paise / t.qty), cash(t.fee_paise), cash(t.pnl_paise, true), `<details class="detail"><summary>Trade reasons</summary><p>Strategy: ${e(signal?.strategy || (entry?.reason === 'manual' ? 'Manual' : 'Unavailable in recent history'))}</p><p>Entry: ${e(signal?.reason || entry?.reason || 'Unavailable in recent history')}</p><p>Exit: ${e(t.reason)}</p></details>`];
        }), 'No closed trades match this filter.'));
        $('journal-total').textContent = `${trades.length} trades · Net ${money(trades.reduce((sum, t) => sum + t.pnl_paise, 0), true)}`;
    }
    if (page === 'settings') {
        const a = data.account, s = a?.settings;
        slot('limits', s ? pairs([['Starting capital', money(s.initialCapital)], ['Max order value', money(s.maxOrderValue)], ['Max positions', number(s.maxPositions)], ['Daily loss limit', money(s.dailyLossLimit)], ['Quote age limit', number(s.quoteMaxAgeMs / 1000) + ' seconds'], ['Slippage', number(s.slippageBps) + ' bps'], ['Fallback spread', number(s.fallbackSpreadBps) + ' bps'], ['Estimated fee', number(s.feeBps) + ' bps'], ['Fee effective from', e(s.feeEffectiveFrom)]]) + '<p class="ticket-note">Account limits are set on server startup. Fees are estimates, not broker contract-note charges.</p>' : empty('No paper account in this mode.'));
        slot('configuration', pairs([['Data source', e(data.source)], ['Broker', data.source === 'synthetic-fixtures' ? 'Synthetic demo · no broker access' : e(data.market.broker)], ['Model', e(data.market.model)], ['Scan interval', number(data.automation?.settings.scanIntervalS) + ' seconds'], ['Last scan', time(data.automation?.lastScan, true)], ['Data clock', time(data.now, true)], ['Health', offline ? 'Disconnected' : 'Dashboard connected']]) + '<p class="ticket-note">Provider and model credentials are configured on the server. No secrets are shown or stored in this interface.</p>');
    }
    if (page === 'backtesting')
        slot('history', table(['Date', 'Recorded bars', 'Symbols'], data.history.map(s => [e(s.date), number(s.bars), number(s.symbols)]), 'No replayable sessions recorded yet.'));
    controls();
}
function chart() {
    if (!data.trades.length)
        return empty('Your closed-trade result will appear after your first exit.');
    let total = 0;
    const values = [0, ...data.trades.slice().sort((a, b) => a.closed_at - b.closed_at).map(t => total += t.pnl_paise)], min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    const y = v => 150 - (v - min) / range * 120, points = values.map((v, i) => `${20 + i / (values.length - 1) * 660},${y(v)}`).join(' ');
    return `<div class="chart" role="img" aria-label="Cumulative net closed trade profit ${e(money(total))}; minimum ${e(money(min))}; maximum ${e(money(max))}"><svg viewBox="0 0 700 180" width="100%" height="100%" aria-hidden="true"><path d="M20 ${y(0)}H680" stroke="#526170" stroke-dasharray="4 5"/><polyline points="${points}" fill="none" stroke="${total >= 0 ? '#8ce7b2' : '#ff9098'}" stroke-width="2"/></svg></div><div class="chart-legend"><span>Min ${money(min)} · Max ${money(max)}</span><strong class="${tone(total)}">Net ${money(total, true)}</strong></div>`;
}
function render() {
    if (!data) {
        controls();
        return;
    }
    $('mode-badge').textContent = data.mode.toUpperCase();
    $('mode-badge').className = `badge ${data.mode}`;
    $('source-badge').textContent = data.source;
    $('source-badge').className = 'badge synthetic';
    $('connection').textContent = offline ? 'Disconnected' : (data.source === 'synthetic-fixtures' ? 'Synthetic feed' : data.market.connected ? 'Market connected' : 'Market disconnected') + ' · ' + time(data.now);
    $('updated').textContent = 'Updated ' + time(data.now);
    const a = data.account;
    const notice = !a ? 'Observe / replay mode. Paper account controls are unavailable.' : a.killed ? 'Emergency stop active. New buys are blocked; paper positions are being closed when fresh quotes and session hours permit.' : a.halted ? 'Daily loss halt active. New buys are blocked.' : a.stalePrices ? 'Some position prices are stale. Equity is unavailable until fresh quotes arrive.' : data.source === 'synthetic-fixtures' ? 'Synthetic demo · simulated prices and virtual funds. Data clock runs independently of real market time.' : '';
    $('data-notice').textContent = notice;
    $('data-notice').hidden = !notice;
    $('account-band').innerHTML = [['Paper equity', a?.equity, 'Virtual account value'], ['Available cash', a?.availableCash, 'Unreserved funds'], ['Daily P&L', a?.dailyPnl, 'Realized + unrealized'], ['Realized P&L', a?.realizedPnl, 'Net of estimated fees'], ['Unrealized P&L', a?.unrealizedPnl, 'Open positions, net']].map(([label, value, note]) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${tone(label.includes('P&L') ? value : 0)}">${money(value, label.includes('P&L'))}</div><small>${note}</small></div>`).join('');
    renderContent();
    document.querySelectorAll('[data-policy]').forEach(form => { if (form.dataset.dirty || form.contains(document.activeElement))
        return; for (const [key, value] of Object.entries(data.automation?.settings || {})) {
        const input = form.elements.namedItem(key);
        if (input)
            input.value = value;
    } });
    if ($('jev-option')) {
        const unavailable = data.source === 'synthetic-fixtures' || data.market.model !== 'jev';
        $('jev-option').disabled = unavailable;
        $('jev-option').textContent = unavailable ? 'Jev model · configure provider first' : 'Jev model';
    }
    updateTicket();
    controls();
}
function updateTicket() {
    const form = $('ticket');
    if (!form)
        return;
    const limit = form.elements.type.value === 'limit', buy = form.elements.side.value === 'buy';
    $('limit-field').hidden = !limit;
    form.elements.limitPrice.required = limit;
    $('stop-field').hidden = !buy;
    form.elements.stopLoss.disabled = !buy;
    $('place-order').textContent = `Place paper ${buy ? 'buy' : 'sell'}`;
    const q = data?.market.quotes.find(q => q.symbol === form.elements.symbol.value.toUpperCase().trim());
    const price = limit ? Number(form.elements.limitPrice.value) : q?.ltp;
    $('estimate').textContent = price > 0 ? money(Math.round(price * 100) * Number(form.elements.qty.value)) : '—';
    $('ticket-cash').textContent = money(data?.account?.availableCash);
    $('ticket-quote').textContent = q ? `Last price ${money(Math.round(q.ltp * 100))} · ${time(q.ts)} IST` : 'No quote available. The backend requires a fresh quote to execute.';
    controls();
}
function controls() {
    const blocked = !data || offline || busy;
    document.querySelectorAll('[data-account]').forEach(el => el.disabled = blocked || !data?.account || el.hasAttribute('data-stale'));
    $('scan').disabled = blocked || !data?.automation || data.automation.scanning;
    $('refresh').disabled = fetching || busy;
    if ($('place-order') && $('side').value === 'buy' && (data?.account?.killed || data?.account?.halted))
        $('place-order').disabled = true;
}
$('view').addEventListener('submit', event => {
    const form = event.target;
    event.preventDefault();
    if (!form.reportValidity())
        return;
    if (form.id === 'ticket')
        void act(async () => { const payload = { symbol: form.elements.symbol.value.toUpperCase().trim(), side: form.elements.side.value, qty: Number(form.elements.qty.value), type: form.elements.type.value }; if (payload.type === 'limit')
            payload.limitPrice = Number(form.elements.limitPrice.value); if (payload.side === 'buy' && form.elements.stopLoss.value)
            payload.stopLoss = Number(form.elements.stopLoss.value); const result = await submitOrder(payload); feedback(`${result.symbol} paper ${result.side}: ${result.status}.`); });
    else if (form.hasAttribute('data-policy'))
        void act(async () => { const payload = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, ['mode', 'strategy'].includes(key) ? value : Number(value)])); if (payload.mode === 'automatic' && data.automation.settings.mode !== 'automatic' && !await confirmAction('Enable automatic paper orders?', 'Eligible strategy signals will place virtual orders without individual approval, within the account risk limits.'))
            return; await request('/api/automation/config', payload); delete form.dataset.dirty; feedback('Strategy configuration saved. Pending approvals have expired.'); });
    else if (form.dataset.modify)
        void act(async () => { await request(`/api/paper/orders/${form.dataset.modify}/modify`, { limitPrice: Number(form.elements.limitPrice.value) }); feedback('Limit order updated.'); });
});
$('view').addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled)
        return;
    const { action, id } = target.dataset;
    if (action === 'trade') {
        prefill = id;
        if (page === 'trading') {
            route();
            $('qty').focus();
        }
        else
            location.hash = 'trading';
        return;
    }
    void act(async () => {
        if (action === 'close') {
            const p = data.positions.find(p => p.symbol === id);
            if (!p || !await confirmAction(`Close ${id}?`, `Sell ${p.availableShares} available shares at the simulated market price.`))
                return;
            const result = await submitOrder({ symbol: id, side: 'sell', qty: p.availableShares, type: 'market' });
            feedback(`Close order ${result.status}.`);
            return;
        }
        if (action === 'kill') {
            if (!await confirmAction('Activate emergency stop?', 'Cancel open paper buys, block new entries and attempt to close existing paper positions on the next tick. Exits require fresh quotes during the trading session.'))
                return;
            await request('/api/kill', {});
            feedback('Emergency stop requested. Risk status will update on the next account tick.');
            return;
        }
        const paths = { cancel: `/api/paper/orders/${id}/cancel`, approve: `/api/signals/${id}/approve`, reject: `/api/signals/${id}/reject`, resume: '/api/unkill', pause: '/api/automation/config' };
        const result = await request(paths[action], action === 'pause' ? { mode: 'off' } : {}, action === 'reject' ? [422] : []);
        if (action === 'pause')
            document.querySelectorAll('[data-policy]').forEach(f => delete f.dataset.dirty);
        feedback(action === 'pause' ? 'Automation paused.' : action === 'resume' ? 'Emergency stop cleared.' : `${action}: ${result.status || 'complete'}.`);
    });
});
$('refresh').addEventListener('click', () => void refresh());
$('scan').addEventListener('click', () => void act(async () => { const run = await request('/api/automation/scan', {}); if (run.status === 'failed')
    throw new Error(run.reason || 'Scan failed.'); feedback(`Scan ${run.status}. Review the latest strategy decisions.`); }));
async function refresh() {
    if (fetching)
        return;
    fetching = true;
    controls();
    try {
        data = await request('/api/dashboard');
        offline = false;
        $('load-error').hidden = true;
        render();
    }
    catch (error) {
        offline = true;
        $('load-error').hidden = false;
        $('load-error').textContent = `Connection unavailable: ${error.message} Showing the last received snapshot; order controls are disabled.`;
        $('connection').textContent = 'Disconnected';
    }
    finally {
        fetching = false;
        controls();
    }
}
window.addEventListener('hashchange', route);
route();
void refresh();
setInterval(() => { if (!document.hidden)
    void refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden)
    void refresh(); });
