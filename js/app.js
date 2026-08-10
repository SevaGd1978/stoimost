// ---------- State ----------
        const state = {
            km: 2400,
            fuelPrice: 86.8,
            fuelConsumption: 30,
            fuel: 62500,
            salary: 39600,
            platonRate: 6,
            platon: 14400,
            travel: 6000,
            autoFuel: true,
            autoSalary: true,
            autoPlaton: true,
            editedFuel: false,
            editedSalary: false,
            editedPlaton: false,
            history: [],
            chart: null,
        };

        // ---------- DOM refs ----------
        const $ = id => document.getElementById(id);
        const kmInput = $('km');
        const fuelPriceInput = $('fuelPrice');
        const fuelConsumptionInput = $('fuelConsumption');
        const fuelInput = $('fuel');
        const salaryInput = $('salary');
        const platonRateInput = $('platonRate');
        const platonInput = $('platon');
        const travelInput = $('travel');
        const autoFuelCheck = $('autoFuel');
        const autoSalaryCheck = $('autoSalary');
        const autoPlatonCheck = $('autoPlaton');
        const totalValue = $('totalValue');
        const perKm = $('perKm');
        const totalBadge = $('totalBadge');
        const breakdownContainer = $('breakdownContainer');
        const historyList = $('historyList');
        const historyCount = $('historyCount');
        const daysDisplay = $('daysDisplay');

        // ---------- Calculations ----------
        function computeFuel(km, price, consumption) {
            if (km <= 0 || price <= 0 || consumption <= 0) return 0;
            return Math.round((km / 100) * consumption * price);
        }

        function computeSalary(km) {
            return Math.round(km * 16.5);
        }

        function computePlaton(km, rate) {
            if (km <= 0 || rate <= 0) return 0;
            return Math.round(km * rate);
        }

        function computeTotal() {
            const km = parseFloat(kmInput.value) || 0;
            const price = parseFloat(fuelPriceInput.value) || 0;
            const consumption = parseFloat(fuelConsumptionInput.value) || 0;
            const rate = parseFloat(platonRateInput.value) || 0;

            let fuel = parseFloat(fuelInput.value) || 0;
            let salary = parseFloat(salaryInput.value) || 0;
            let platon = parseFloat(platonInput.value) || 0;
            const travel = parseFloat(travelInput.value) || 0;

            // Auto-fuel
            if (autoFuelCheck.checked && !state.editedFuel) {
                const autoFuel = computeFuel(km, price, consumption);
                fuelInput.value = autoFuel;
                fuel = autoFuel;
                fuelInput.classList.add('auto-calc');
                fuelInput.classList.remove('is-edited');
            } else {
                fuelInput.classList.remove('auto-calc');
                if (state.editedFuel) {
                    fuelInput.classList.add('is-edited');
                } else {
                    fuelInput.classList.remove('is-edited');
                }
            }

            // Auto-salary
            if (autoSalaryCheck.checked && !state.editedSalary) {
                const autoSalary = computeSalary(km);
                salaryInput.value = autoSalary;
                salary = autoSalary;
                salaryInput.classList.add('auto-calc');
                salaryInput.classList.remove('is-edited');
            } else {
                salaryInput.classList.remove('auto-calc');
                if (state.editedSalary) {
                    salaryInput.classList.add('is-edited');
                } else {
                    salaryInput.classList.remove('is-edited');
                }
            }

            // Auto-platon
            if (autoPlatonCheck.checked && !state.editedPlaton) {
                const autoPlaton = computePlaton(km, rate);
                platonInput.value = autoPlaton;
                platon = autoPlaton;
                platonInput.classList.add('auto-calc');
                platonInput.classList.remove('is-edited');
            } else {
                platonInput.classList.remove('auto-calc');
                if (state.editedPlaton) {
                    platonInput.classList.add('is-edited');
                } else {
                    platonInput.classList.remove('is-edited');
                }
            }

            const total = fuel + salary + platon + travel;
            const perKmVal = km > 0 ? total / km : 0;

            return {
                km,
                fuel,
                salary,
                platon,
                travel,
                total,
                perKm: perKmVal,
                fuelPrice: price,
                fuelConsumption: consumption,
                platonRate: rate
            };
        }

        function updateUI() {
            const data = computeTotal();

            totalValue.innerHTML = `${formatNumber(data.total)} <span class="rub">₽</span>`;
            perKm.innerHTML = `${formatNumber(data.perKm)} <span class="rub">₽/км</span>`;

            const days = Math.round(data.travel / 1000);
            daysDisplay.textContent = days || 0;

            renderBreakdown(data);
            updateChart(data);
            totalBadge.textContent = 'обновлено';
            autoSaveToHistory(data);
        }

        function renderBreakdown(data) {
            const items = [
                { label: 'Топливо', value: data.fuel, color: '#f59e0b' },
                { label: 'Зарплата (с налогами)', value: data.salary, color: '#2a7de1' },
                { label: 'Платон', value: data.platon, color: '#8b5cf6' },
                { label: 'Командировочные', value: data.travel, color: '#10b981' },
            ];

            const total = data.total || 1;
            let html = '';
            items.forEach(item => {
                const pct = total > 0 ? (item.value / total) * 100 : 0;
                html += `
                        <div class="breakdown-item">
                            <div class="left">
                                <span class="color-dot" style="background:${item.color}"></span>
                                <span class="name">${item.label}</span>
                                <span class="pct">${pct.toFixed(1)}%</span>
                            </div>
                            <span class="amount">${formatNumber(item.value)} ₽</span>
                        </div>
                    `;
            });
            html += `
                    <div class="breakdown-total">
                        <span>Итого</span>
                        <span>${formatNumber(total)} ₽</span>
                    </div>
                `;
            breakdownContainer.innerHTML = html;
        }

        // ---------- Chart ----------
        function updateChart(data) {
            const labels = ['Топливо', 'Зарплата', 'Платон', 'Командировочные'];
            const values = [data.fuel, data.salary, data.platon, data.travel];
            const colors = ['#f59e0b', '#2a7de1', '#8b5cf6', '#10b981'];

            const ctx = document.getElementById('costChart').getContext('2d');

            if (state.chart) {
                state.chart.data.datasets[0].data = values;
                state.chart.data.datasets[0].backgroundColor = colors;
                state.chart.update();
                return;
            }

            state.chart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: values,
                        backgroundColor: colors,
                        borderColor: '#ffffff',
                        borderWidth: 3,
                        hoverOffset: 8,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '62%',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const pct = total > 0 ? (context.parsed / total * 100).toFixed(1) : 0;
                                    return `${context.label}: ${formatNumber(context.parsed)} ₽ (${pct}%)`;
                                }
                            }
                        }
                    }
                },
                plugins: [{
                    id: 'centerText',
                    beforeDraw: function(chart) {
                        const { width, height, ctx } = chart;
                        ctx.save();
                        const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                        const text = formatNumber(total);
                        ctx.font = '700 22px "Segoe UI", sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillStyle = '#0b1e33';
                        ctx.fillText(text, width / 2, height / 2 - 4);
                        ctx.font = '400 11px "Segoe UI", sans-serif';
                        ctx.fillStyle = '#94a3b8';
                        ctx.fillText('всего ₽', width / 2, height / 2 + 22);
                        ctx.restore();
                    }
                }]
            });
        }

        // ---------- History ----------
        function loadHistory() {
            try {
                const raw = localStorage.getItem('tripHistory');
                state.history = raw ? JSON.parse(raw) : [];
                if (!Array.isArray(state.history)) state.history = [];
            } catch {
                state.history = [];
            }
            renderHistory();
        }

        function saveHistory() {
            try {
                localStorage.setItem('tripHistory', JSON.stringify(state.history));
            } catch { /* ignore */ }
            renderHistory();
        }

        function renderHistory() {
            const list = historyList;
            const count = state.history.length;
            historyCount.textContent = count;

            if (count === 0) {
                list.innerHTML = `<div class="history-empty">Нет сохранённых расчётов</div>`;
                return;
            }

            let html = '';
            const reversed = [...state.history].reverse();
            reversed.forEach((item, idx) => {
                const realIdx = state.history.length - 1 - idx;
                const date = new Date(item.timestamp);
                const dateStr = date.toLocaleDateString('ru-RU') + ' ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit',
                    minute: '2-digit' });
                html += `
                        <div class="history-item">
                            <div class="left">
                                <span class="date">${dateStr}</span>
                                <div class="detail">
                                    <span>🚛 ${item.km} км</span>
                                    <span>⛽ ${formatNumber(item.fuel)} ₽</span>
                                    <span>🧾 ${formatNumber(item.total)} ₽</span>
                                </div>
                            </div>
                            <div style="display:flex;align-items:center;gap:12px;">
                                <span class="total">${formatNumber(item.total)} ₽</span>
                                <button class="delete-btn" onclick="deleteHistory(${realIdx})" title="Удалить">✕</button>
                            </div>
                        </div>
                    `;
            });
            list.innerHTML = html;
        }

        function autoSaveToHistory(data) {
            if (state._lastSave) {
                const last = state._lastSave;
                if (Math.abs(last.total - data.total) < 1 && last.km === data.km) return;
            }
            if (data.total === 0) return;

            state._lastSave = { ...data };

            clearTimeout(state._saveTimeout);
            state._saveTimeout = setTimeout(() => {
                const exists = state.history.some(h =>
                    Math.abs(h.total - data.total) / (h.total || 1) < 0.01 &&
                    h.km === data.km &&
                    Math.abs(h.fuel - data.fuel) / (h.fuel || 1) < 0.01
                );
                if (!exists) {
                    state.history.push({
                        km: data.km,
                        fuel: data.fuel,
                        salary: data.salary,
                        platon: data.platon,
                        travel: data.travel,
                        total: data.total,
                        fuelPrice: data.fuelPrice,
                        fuelConsumption: data.fuelConsumption,
                        platonRate: data.platonRate,
                        timestamp: Date.now(),
                    });
                    saveHistory();
                }
            }, 800);
        }

        function saveCalculation() {
            const data = computeTotal();
            state.history.push({
                km: data.km,
                fuel: data.fuel,
                salary: data.salary,
                platon: data.platon,
                travel: data.travel,
                total: data.total,
                fuelPrice: data.fuelPrice,
                fuelConsumption: data.fuelConsumption,
                platonRate: data.platonRate,
                timestamp: Date.now(),
            });
            saveHistory();
            showToast('✅ Расчёт сохранён!', 'success');
        }

        function deleteHistory(index) {
            if (index >= 0 && index < state.history.length) {
                state.history.splice(index, 1);
                saveHistory();
                showToast('🗑️ Запись удалена', '');
            }
        }

        function clearHistory() {
            if (state.history.length === 0) return;
            if (confirm('Удалить всю историю расчётов?')) {
                state.history = [];
                saveHistory();
                showToast('🗑️ История очищена', '');
            }
        }

        function loadFromHistory(index) {
            if (state.history.length === 0) {
                showToast('Нет сохранённых расчётов', 'error');
                return;
            }
            const idx = index === -1 ? state.history.length - 1 : index;
            const item = state.history[idx];
            if (!item) return;

            kmInput.value = item.km;
            fuelInput.value = item.fuel;
            salaryInput.value = item.salary;
            platonInput.value = item.platon;
            travelInput.value = item.travel;

            if (item.fuelPrice !== undefined) {
                fuelPriceInput.value = item.fuelPrice;
                fuelConsumptionInput.value = item.fuelConsumption;
            } else {
                fuelPriceInput.value = 86.8;
                fuelConsumptionInput.value = 30;
            }
            if (item.platonRate !== undefined) {
                platonRateInput.value = item.platonRate;
            } else {
                platonRateInput.value = 6;
            }

            state.editedFuel = false;
            state.editedSalary = false;
            state.editedPlaton = false;
            autoFuelCheck.checked = true;
            autoSalaryCheck.checked = true;
            autoPlatonCheck.checked = true;
            fuelInput.classList.add('auto-calc');
            fuelInput.classList.remove('is-edited');
            salaryInput.classList.add('auto-calc');
            salaryInput.classList.remove('is-edited');
            platonInput.classList.add('auto-calc');
            platonInput.classList.remove('is-edited');

            updateUI();
            showToast('📥 Расчёт загружен', 'success');
        }

        // ---------- Reset ----------
        function resetToDefaults() {
            kmInput.value = 2400;
            fuelPriceInput.value = 86.8;
            fuelConsumptionInput.value = 30;
            fuelInput.value = 62500;
            platonRateInput.value = 6;
            platonInput.value = 14400;
            travelInput.value = 6000;
            state.editedFuel = false;
            state.editedSalary = false;
            state.editedPlaton = false;
            autoFuelCheck.checked = true;
            autoSalaryCheck.checked = true;
            autoPlatonCheck.checked = true;
            fuelInput.classList.add('auto-calc');
            fuelInput.classList.remove('is-edited');
            salaryInput.classList.add('auto-calc');
            salaryInput.classList.remove('is-edited');
            platonInput.classList.add('auto-calc');
            platonInput.classList.remove('is-edited');
            updateUI();
            showToast('↺ Значения сброшены', '');
        }

        // ---------- Export CSV ----------
        function exportCSV() {
            const data = computeTotal();
            const headers = ['Километраж', 'Цена топлива (₽/л)', 'Расход (л/100км)', 'Топливо', 'Зарплата', 'Ставка Платона (₽/км)',
                'Платон', 'Командировочные', 'Итого'
            ];
            const row = [data.km, data.fuelPrice, data.fuelConsumption, data.fuel, data.salary, data.platonRate, data.platon,
                data.travel, data.total
            ];
            let csv = headers.join(';') + '\n' + row.join(';') + '\n';

            if (state.history.length > 0) {
                const hHeaders = ['Дата', 'Км', 'Цена топлива', 'Расход', 'Топливо', 'Зарплата', 'Ставка Платона', 'Платон',
                    'Командировочные', 'Итого'
                ];
                const hRows = state.history.map(h => {
                    const d = new Date(h.timestamp);
                    const ds = d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit',
                        minute: '2-digit' });
                    const price = h.fuelPrice !== undefined ? h.fuelPrice : '';
                    const cons = h.fuelConsumption !== undefined ? h.fuelConsumption : '';
                    const rate = h.platonRate !== undefined ? h.platonRate : '';
                    return [ds, h.km, price, cons, h.fuel, h.salary, rate, h.platon, h.travel, h.total].join(';');
                });
                csv += '\n--- История ---\n' + hHeaders.join(';') + '\n' + hRows.join('\n');
            }

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `рейс_${new Date().toISOString().slice(0,10)}.csv`;
            link.click();
            URL.revokeObjectURL(link.href);
            showToast('📤 CSV экспортирован', 'success');
        }

        // ---------- Toast ----------
        function showToast(msg, type = '') {
            const el = document.getElementById('toast');
            el.textContent = msg;
            el.className = 'toast show ' + type;
            clearTimeout(el._timeout);
            el._timeout = setTimeout(() => {
                el.classList.remove('show');
            }, 2800);
        }

        // ---------- Helpers ----------
        function formatNumber(val) {
            if (val === undefined || val === null || isNaN(val)) return '0';
            return Math.round(val).toLocaleString('ru-RU');
        }

        // ---------- Event binding ----------
        function bindInputs() {
            // Авто-топливо
            const fuelDeps = [kmInput, fuelPriceInput, fuelConsumptionInput];
            fuelDeps.forEach(inp => {
                inp.addEventListener('input', () => {
                    if (autoFuelCheck.checked && !state.editedFuel) {
                        const km = parseFloat(kmInput.value) || 0;
                        const price = parseFloat(fuelPriceInput.value) || 0;
                        const cons = parseFloat(fuelConsumptionInput.value) || 0;
                        fuelInput.value = computeFuel(km, price, cons);
                    }
                    updateUI();
                });
            });

            fuelInput.addEventListener('input', () => {
                if (autoFuelCheck.checked) {
                    const km = parseFloat(kmInput.value) || 0;
                    const price = parseFloat(fuelPriceInput.value) || 0;
                    const cons = parseFloat(fuelConsumptionInput.value) || 0;
                    const autoFuel = computeFuel(km, price, cons);
                    const current = parseFloat(fuelInput.value) || 0;
                    if (Math.abs(current - autoFuel) > 1) {
                        state.editedFuel = true;
                        fuelInput.classList.add('is-edited');
                        fuelInput.classList.remove('auto-calc');
                        autoFuelCheck.checked = false;
                    } else {
                        state.editedFuel = false;
                        fuelInput.classList.remove('is-edited');
                        fuelInput.classList.add('auto-calc');
                        autoFuelCheck.checked = true;
                    }
                }
                updateUI();
            });

            autoFuelCheck.addEventListener('change', () => {
                if (autoFuelCheck.checked) {
                    state.editedFuel = false;
                    fuelInput.classList.add('auto-calc');
                    fuelInput.classList.remove('is-edited');
                    const km = parseFloat(kmInput.value) || 0;
                    const price = parseFloat(fuelPriceInput.value) || 0;
                    const cons = parseFloat(fuelConsumptionInput.value) || 0;
                    fuelInput.value = computeFuel(km, price, cons);
                } else {
                    fuelInput.classList.remove('auto-calc');
                }
                updateUI();
            });

            // Авто-зарплата
            salaryInput.addEventListener('input', () => {
                if (autoSalaryCheck.checked) {
                    const km = parseFloat(kmInput.value) || 0;
                    const autoSalary = computeSalary(km);
                    const current = parseFloat(salaryInput.value) || 0;
                    if (Math.abs(current - autoSalary) > 1) {
                        state.editedSalary = true;
                        salaryInput.classList.add('is-edited');
                        salaryInput.classList.remove('auto-calc');
                        autoSalaryCheck.checked = false;
                    } else {
                        state.editedSalary = false;
                        salaryInput.classList.remove('is-edited');
                        salaryInput.classList.add('auto-calc');
                        autoSalaryCheck.checked = true;
                    }
                }
                updateUI();
            });

            autoSalaryCheck.addEventListener('change', () => {
                if (autoSalaryCheck.checked) {
                    state.editedSalary = false;
                    salaryInput.classList.add('auto-calc');
                    salaryInput.classList.remove('is-edited');
                    const km = parseFloat(kmInput.value) || 0;
                    salaryInput.value = computeSalary(km);
                } else {
                    salaryInput.classList.remove('auto-calc');
                }
                updateUI();
            });

            // Авто-Платон
            const platonDeps = [kmInput, platonRateInput];
            platonDeps.forEach(inp => {
                inp.addEventListener('input', () => {
                    if (autoPlatonCheck.checked && !state.editedPlaton) {
                        const km = parseFloat(kmInput.value) || 0;
                        const rate = parseFloat(platonRateInput.value) || 0;
                        platonInput.value = computePlaton(km, rate);
                    }
                    updateUI();
                });
            });

            platonInput.addEventListener('input', () => {
                if (autoPlatonCheck.checked) {
                    const km = parseFloat(kmInput.value) || 0;
                    const rate = parseFloat(platonRateInput.value) || 0;
                    const autoPlaton = computePlaton(km, rate);
                    const current = parseFloat(platonInput.value) || 0;
                    if (Math.abs(current - autoPlaton) > 1) {
                        state.editedPlaton = true;
                        platonInput.classList.add('is-edited');
                        platonInput.classList.remove('auto-calc');
                        autoPlatonCheck.checked = false;
                    } else {
                        state.editedPlaton = false;
                        platonInput.classList.remove('is-edited');
                        platonInput.classList.add('auto-calc');
                        autoPlatonCheck.checked = true;
                    }
                }
                updateUI();
            });

            autoPlatonCheck.addEventListener('change', () => {
                if (autoPlatonCheck.checked) {
                    state.editedPlaton = false;
                    platonInput.classList.add('auto-calc');
                    platonInput.classList.remove('is-edited');
                    const km = parseFloat(kmInput.value) || 0;
                    const rate = parseFloat(platonRateInput.value) || 0;
                    platonInput.value = computePlaton(km, rate);
                } else {
                    platonInput.classList.remove('auto-calc');
                }
                updateUI();
            });

            // Командировочные
            travelInput.addEventListener('input', updateUI);
        }

        // ---------- Init ----------
        function init() {
            loadHistory();
            bindInputs();

            // Первоначальный расчёт
            const km = parseFloat(kmInput.value) || 0;
            const price = parseFloat(fuelPriceInput.value) || 0;
            const cons = parseFloat(fuelConsumptionInput.value) || 0;
            const rate = parseFloat(platonRateInput.value) || 0;

            if (autoFuelCheck.checked) fuelInput.value = computeFuel(km, price, cons);
            if (autoSalaryCheck.checked) salaryInput.value = computeSalary(km);
            if (autoPlatonCheck.checked) platonInput.value = computePlaton(km, rate);

            updateUI();
            setTimeout(() => {
                const data = computeTotal();
                updateChart(data);
            }, 100);
        }

        document.addEventListener('DOMContentLoaded', init);
