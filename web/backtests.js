import { escapeHtml as e, money, number, time, tone } from './format.js';
const names = { vwap_momentum: 'VWAP momentum', session_hold: 'Session buy-and-hold', recorded_ai: 'Recorded AI decisions' };
const colors = ['#8ce7b2', '#9ac6f6', '#f2cf8d'];
const table = (heads, rows) => `<div class="table-wrap"><table><thead><tr>${heads.map(h => `<th scope="col">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const panel = (title, body) => `<section class="panel"><div class="panel-head"><h2>${title}</h2></div>${body}</section>`;
const input = (name, label, value, min, max, step = 1) => `<div class="field"><label for="bt-${name}">${label}</label><input id="bt-${name}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" required></div>`;
export function mountBacktests(root, { request }) {
    let catalog = { datasets: [], runs: [] }, selected, result, busy = false;
    const find = id => root.querySelector(`#bt-${id}`);
    root.innerHTML = `<div class="notice info">Historical evaluation uses isolated simulated cash. It never submits to your paper account or a broker. Results depend on data and fill assumptions.</div><div id="bt-message" role="status" aria-live="polite" hidden></div>
 ${panel('Evaluation dataset', `<div class="panel-body"><div class="bt-actions"><button type="button" data-bt="demo" class="button secondary">Load synthetic example</button><label class="button secondary bt-upload" for="bt-file">Import dataset JSON</label><input id="bt-file" type="file" accept=".json,application/json" class="bt-file"><button type="button" data-bt="refresh" class="button secondary">Refresh saved data</button></div><p class="ticket-note">Imports require full 375-minute sessions for every declared symbol, source identity and a historical universe date. Prices are INR. Synthetic examples demonstrate the workflow; they are not market evidence.</p><details class="detail section-gap"><summary>Capture existing local bars</summary><form id="bt-capture" class="section-gap"><div class="form-grid"><div class="field"><label for="bt-name">Dataset name</label><input id="bt-name" name="name" required maxlength="80" placeholder="Historical NSE sessions"></div><div class="field"><label for="bt-universeAsOf">Historical universe as of</label><input id="bt-universeAsOf" name="universeAsOf" type="date" required></div><div class="field"><label for="bt-capture-start">First session</label><input id="bt-capture-start" name="startDate" type="date" required></div><div class="field"><label for="bt-capture-end">Last session</label><input id="bt-capture-end" name="endDate" type="date" required></div><div class="field"><label for="bt-capture-symbols">Historical symbols · comma separated</label><input id="bt-capture-symbols" name="symbols" required placeholder="INFY,TCS" maxlength="620"></div></div><p class="ticket-note">The local cache has unverified source/adjustment provenance. Partial sessions, missing members and duplicates are rejected. Capture expects every weekday; for exchange holidays, import JSON with an explicitly declared session list. Do not label today's surviving symbols as a historical universe.</p><label class="checkbox-label"><input name="synthetic" type="checkbox" checked>Synthetic / demonstration bars</label><button class="button secondary section-gap">Validate and capture cache</button></form></details><p class="ticket-note"><a href="/legacy.html">Legacy replay tools</a></p></div>`)}
 ${panel('Compare strategies', `<form id="bt-run" class="panel-body"><div class="field"><label for="bt-dataset">Dataset</label><select id="bt-dataset" name="datasetId" required></select><small id="bt-source"></small></div><div class="form-grid"><div class="field"><label for="bt-startDate">First session (in-sample)</label><input id="bt-startDate" name="startDate" type="date" required></div><div class="field"><label for="bt-endDate">Last session</label><input id="bt-endDate" name="endDate" type="date" required></div><div class="field"><label for="bt-holdoutDate">Holdout starts</label><input id="bt-holdoutDate" name="holdoutDate" type="date" required></div>${input('initialCapital', 'Starting capital · INR', 10000, 100, 1e7)}</div><fieldset class="bt-strategies"><legend>Strategies · same data and assumptions</legend>${Object.entries(names).map(([id, name]) => `<label class="checkbox-label"><input name="strategies" value="${id}" type="checkbox" ${id === 'recorded_ai' ? '' : 'checked'}>${name}</label>`).join('')}<p class="ticket-note">Recorded AI requires imported decisions made after their feature bars closed and a declared model training cutoff before the dataset. We cannot attest their provenance or eliminate model pretraining leakage.</p></fieldset><details class="detail section-gap"><summary>Costs, risk and strategy parameters</summary><div class="form-grid section-gap">${input('maxOrderValue', 'Maximum order · INR', 1000, 1, 1e7)}${input('maxPositions', 'Maximum positions', 3, 1, 20)}${input('dailyLossLimit', 'Daily loss limit · INR', 300, 1, 1e7)}${input('feeBps', 'Estimated fee per side · bps', 5, 0, 100, .1)}${input('spreadBps', 'Full spread · bps', 5, 0, 100, .1)}${input('slippageBps', 'Adverse slippage per side · bps', 2, 0, 100, .1)}${input('participation', 'Prior-minute volume participation', .01, .001, .1, .001)}${input('momentumBps', 'VWAP minimum momentum · bps', 5, 1, 100)}${input('minVolumeRatio', 'VWAP minimum volume ratio', 1.2, .1, 10, .1)}${input('stopAtrMult', 'VWAP stop ATR multiplier', 1.5, .1, 10, .1)}${input('maxStopBps', 'Maximum stop distance · bps', 100, 10, 500)}${input('maxHoldMinutes', 'Maximum hold · minutes (not benchmark)', 30, 1, 360)}${input('cooldownS', 'Re-entry cooldown · seconds', 300, 0, 86400)}${input('minScore', 'VWAP minimum score', .6, 0, 1, .01)}</div></details><p class="ticket-note">Each strategy starts fresh in each window. Holdout results stay separate. Repeated tuning against this holdout invalidates its independence.</p><div class="form-actions"><button id="bt-submit" class="button primary" disabled>Run comparison</button></div></form>`)}
 <div id="bt-results"></div>${panel('Saved evaluations', '<div id="bt-saved"></div>')}`;
    function message(copy, error = false) { const el = find('message'); el.hidden = false; el.className = `feedback${error ? ' error' : ''}`; el.textContent = copy; }
    function controls() { root.querySelectorAll('button,input,select').forEach(el => el.disabled = busy); find('submit').disabled = busy || !catalog.datasets.length; const ai = root.querySelector('[value="recorded_ai"]'); ai.disabled = busy || !selected?.aiDecisions; if (!selected?.aiDecisions)
        ai.checked = false; }
    async function action(fn) { if (busy)
        return; busy = true; controls(); try {
        await fn();
    }
    catch (error) {
        message(error.message, true);
    }
    finally {
        busy = false;
        controls();
    } }
    function choose(id) {
        const previous = selected?.id;
        selected = catalog.datasets.find(d => d.id === id) || catalog.datasets[0];
        if (!selected)
            return;
        find('dataset').value = selected.id;
        const dates = selected.dates;
        if (previous !== selected.id) {
            find('startDate').value = dates[0];
            find('endDate').value = dates.at(-1);
            find('holdoutDate').value = dates[Math.floor(dates.length / 2)];
        }
        find('source').textContent = `${selected.synthetic ? 'SYNTHETIC · ' : ''}${selected.source} · ${dates.length} sessions · ${selected.symbols.join(', ')} · ${number(selected.barCount)} bars · universe ${selected.universeAsOf}`;
        controls();
    }
    async function load(id) {
        catalog = await request('/api/backtests');
        find('dataset').innerHTML = catalog.datasets.length ? catalog.datasets.map(d => `<option value="${e(d.id)}">${e(d.name)}${d.synthetic ? ' · SYNTHETIC' : ''}</option>`).join('') : '<option value="">Import data or load the synthetic example</option>';
        choose(id || selected?.id);
        find('saved').innerHTML = catalog.runs.length ? table(['Created · IST', 'Dataset', 'Period / holdout', 'Strategies', ''], catalog.runs.map(r => [time(r.createdAt, true), e(r.datasetName) + (r.synthetic ? ' · SYNTHETIC' : ''), `${e(r.startDate)} → ${e(r.endDate)}<br>Holdout ${e(r.holdoutDate)}`, e(r.strategies.map(s => names[s]).join(', ')), `<button type="button" class="button secondary small-button" data-open="${e(r.id)}">Open result</button>`])) : '<div class="empty">No saved evaluations yet.</div>';
    }
    const pct = value => value == null ? '—' : number(value, 2) + '%';
    function draw() {
        if (!result)
            return;
        const period = find('period')?.value || 'outOfSample', strategy = find('trades-strategy')?.value || result.results[0].strategy;
        const windows = result.results.map(r => r[period]);
        const stats = [['Gross P&L', 'grossPnl', v => money(v)], ['Net P&L', 'netPnl', v => money(v, true)], ['Fees', 'fees', v => money(v)], ['Spread + slippage', 'friction', v => money(v)], ['Total costs', 'totalCosts', v => money(v)], ['Closed trades', 'tradeCount', v => number(v)], ['Win rate', 'winRate', pct], ['Average win', 'averageWin', v => money(v)], ['Average loss', 'averageLoss', v => money(v)], ['Profit factor', 'profitFactor', (v, m) => v === null ? m.profitFactorState === 'no-losses' ? 'No losing trades' : '—' : number(v, 2)], ['Expectancy / trade', 'expectancy', v => money(v)], ['Maximum drawdown', 'maxDrawdown', v => money(v)], ['Maximum drawdown %', 'maxDrawdownPct', pct], ['Average hold · minutes', 'averageHoldingMinutes', v => number(v, 2)], ['Time exposure', 'exposurePct', pct], ['Return on capital', 'returnOnCapitalPct', pct], ['Ending equity', 'endingEquity', v => money(v)]];
        const rows = stats.map(([label, key, format]) => [label, ...windows.map(w => `<span class="num ${key === 'netPnl' ? tone(w.metrics[key]) : ''}">${e(format(w.metrics[key], w.metrics))}</span>`)]);
        const points = windows.flatMap(w => w.equity), min = Math.min(result.config.initialCapital, ...points.map(p => p.equity)), max = Math.max(result.config.initialCapital, ...points.map(p => p.equity)), first = Math.min(...points.map(p => p.ts)), last = Math.max(...points.map(p => p.ts));
        const paths = windows.map((w, index) => `<polyline fill="none" stroke="${colors[index]}" stroke-width="2" points="${w.equity.map(p => `${30 + (p.ts - first) / (last - first || 1) * 650},${185 - (p.equity - min) / (max - min || 1) * 150}`).join(' ')}"/>`).join('');
        const chosen = result.results.find(r => r.strategy === strategy) || result.results[0], trades = chosen[period].trades;
        find('results').innerHTML = `${panel(result.synthetic ? 'Synthetic evaluation result' : 'Historical evaluation result', `<div class="panel-body"><div class="toolbar bt-result-toolbar"><label for="bt-period">Evaluation window</label><select id="bt-period"><option value="outOfSample" ${period === 'outOfSample' ? 'selected' : ''}>Holdout · out-of-sample</option><option value="inSample" ${period === 'inSample' ? 'selected' : ''}>In-sample · tuning</option></select><button type="button" data-bt="export" class="button secondary">Export result JSON</button></div><p>${e(result.datasetName)} · ${e(windows[0].dates[0])} → ${e(windows[0].dates.at(-1))} · ${e(result.version)}</p><p class="ticket-note">Frozen run ${e(result.id)}. All money in INR; execution and equity records store integer paise. ${result.synthetic ? 'Synthetic results are a demonstration, not historical performance.' : ''}</p></div>${table(['Metric', ...result.results.map(r => names[r.strategy])], rows)}`)}
  ${panel('Equity comparison', `<div class="bt-chart" role="img" aria-label="${e(period === 'outOfSample' ? 'Holdout' : 'In-sample')} marked equity by strategy; minimum ${e(money(min))}, maximum ${e(money(max))}"><svg viewBox="0 0 710 220" width="100%" aria-hidden="true"><path d="M30 35H680M30 185H680" stroke="#29333d"/>${paths}</svg></div><div class="bt-legend">${result.results.map((r, i) => `<span style="color:${colors[i]}">${e(names[r.strategy])}</span>`).join('')}<span>Min ${money(min)} · Max ${money(max)}</span><span>${time(first, true)} → ${time(last, true)} IST</span></div><p class="panel-body ticket-note">Close-marked equity after costs paid. Lines connect recorded minutes across overnight gaps; positions are flat overnight. Time exposure is the fraction of replay minutes with a holding, not capital-weighted exposure.</p>`)}
  ${panel('Trade ledger', `<div class="toolbar"><label for="bt-trades-strategy">Strategy</label><select id="bt-trades-strategy">${result.results.map(r => `<option value="${e(r.strategy)}" ${r.strategy === chosen.strategy ? 'selected' : ''}>${e(names[r.strategy])}</option>`).join('')}</select><span class="muted">${trades.length} closed trades</span></div>${trades.length ? table(['Symbol / shares', 'Entry / exit · IST', 'Raw entry / exit', 'Gross', 'Fees', 'Spread + slippage', 'Net', 'Reasons'], trades.map(t => [`${e(t.symbol)} · ${number(t.qty)}`, `${time(t.openedAt, true)}<br>${time(t.closedAt, true)}`, `${money(t.entryPaise)}<br>${money(t.exitPaise)}`, money(t.grossPnl), money(t.fees), money(t.friction), `<span class="num ${tone(t.netPnl)}">${money(t.netPnl, true)}</span>`, `<details class="detail"><summary>Entry / exit</summary><p>${e(t.entryReason)}</p><p>${e(t.exitReason)}</p></details>`])) : '<div class="empty">No trades in this window. This is a valid result, not evidence of profitability.</div>'}`)}
  ${panel('Assumptions & provenance', `<div class="panel-body"><details class="detail"><summary>Inspect frozen configuration, data hash and limitations</summary><p>Source: ${e(result.source)} · Universe as of ${e(result.universeAsOf)}</p><p>Data SHA-256: ${e(result.datasetHash)}</p><p>Run fingerprint: ${e(result.fingerprint)}</p><ul>${result.assumptions.map(a => `<li>${e(a)}</li>`).join('')}</ul><pre class="code">${e(JSON.stringify({ config: result.config, versions: result.results.map(r => ({ strategy: r.strategy, version: r.strategyVersion, models: r.modelVersions })), rejectedEntries: chosen[period].rejectedEntries }, null, 2))}</pre></details></div>`)}`;
    }
    root.addEventListener('change', event => {
        if (event.target.id === 'bt-dataset')
            choose(event.target.value);
        if (['bt-period', 'bt-trades-strategy'].includes(event.target.id))
            draw();
        if (event.target.id === 'bt-file')
            void action(async () => { const file = event.target.files[0]; if (!file)
                return; if (file.size > 4 * 1024 * 1024)
                throw new Error('Dataset JSON must be at most 4 MiB.'); const saved = await request('/api/backtests/import', JSON.parse(await file.text())); await load(saved.id); message('Dataset validated and saved.'); });
    });
    root.addEventListener('submit', event => {
        event.preventDefault();
        event.stopPropagation();
        const form = event.target;
        if (!form.reportValidity())
            return;
        // FormData must be read before action() disables controls.
        const values = new FormData(form);
        if (form.id === 'bt-capture')
            void action(async () => { const saved = await request('/api/backtests/capture', { ...Object.fromEntries(values), synthetic: values.get('synthetic') === 'on' }); await load(saved.id); message('Local dataset validated and captured.'); });
        if (form.id === 'bt-run') {
            const parameters = {}, payload = {};
            for (const [key, value] of values) {
                if (['momentumBps', 'minVolumeRatio', 'stopAtrMult', 'maxStopBps', 'maxHoldMinutes', 'cooldownS', 'minScore'].includes(key))
                    parameters[key] = Number(value);
                else if (key !== 'strategies')
                    payload[key] = ['datasetId', 'startDate', 'endDate', 'holdoutDate'].includes(key) ? value : Number(value);
            }
            payload.strategies = values.getAll('strategies');
            payload.parameters = parameters;
            void action(async () => { result = await request('/api/backtests/run', payload); await load(selected.id); draw(); find('results').scrollIntoView({ block: 'start' }); message('Evaluation saved. Review the holdout results and assumptions.'); });
        }
    });
    root.addEventListener('click', event => {
        const target = event.target.closest('button');
        if (!target || target.disabled)
            return;
        if (target.dataset.open)
            void action(async () => { result = await request(`/api/backtests/${target.dataset.open}`); draw(); find('results').scrollIntoView({ block: 'start' }); message('Saved evaluation loaded.'); });
        if (target.dataset.bt === 'demo')
            void action(async () => { const saved = await request('/api/backtests/demo', {}); await load(saved.id); message('Synthetic example loaded. It contains no actual market prices.'); });
        if (target.dataset.bt === 'refresh')
            void action(async () => { await load(); message('Saved datasets and evaluations refreshed.'); });
        if (target.dataset.bt === 'export' && result) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
            a.download = `dipdaemon-evaluation-${result.id}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }
    });
    void action(load);
}
