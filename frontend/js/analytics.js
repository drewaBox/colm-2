// Staff overview request charts, rendered as dependency-free SVG.
(function () {
  const monthlyChart = document.getElementById("monthlyRequestsChart");
  const documentChart = document.getElementById("documentRequestsChart");
  if (!monthlyChart || !documentChart) return;

  const colors = ["#087f5b", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#ec4899", "#64748b", "#84cc16", "#f97316"];
  const escape = value => escapeHtml(value);

  function renderMonthly(rows) {
    const width = 760, height = 280, left = 44, right = 18, top = 18, bottom = 52;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const max = Math.max(1, ...rows.map(row => Number(row.request_count)));
    const maxTick = Math.ceil(max / 4) * 4;
    const y = value => top + plotHeight - plotHeight * value / maxTick;
    const step = plotWidth / rows.length;
    const barWidth = Math.min(34, step * 0.62);
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = Math.round(maxTick * index / 4);
      return `<g><line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="chart-grid"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end" class="chart-label">${value}</text></g>`;
    }).join("");
    const bars = rows.map((row, index) => {
      const value = Number(row.request_count);
      const x = left + index * step + (step - barWidth) / 2;
      const barHeight = plotHeight * value / maxTick;
      const date = new Date(`${row.request_month}T00:00:00`);
      const label = date.toLocaleDateString(undefined, { month: "short" });
      return `<g><title>${date.toLocaleDateString(undefined, { month: "long", year: "numeric" })}: ${value} requests</title>
        <rect x="${x.toFixed(1)}" y="${y(value).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, barHeight).toFixed(1)}" rx="5" class="chart-bar"/>
        <text x="${x + barWidth / 2}" y="${height - 24}" text-anchor="middle" class="chart-label">${escape(label)}</text>
        <text x="${x + barWidth / 2}" y="${Math.max(top + 12, y(value) - 6)}" text-anchor="middle" class="chart-value">${value}</text></g>`;
    }).join("");
    monthlyChart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="analytics-svg" aria-hidden="true">${grid}${bars}</svg>`;
  }

  function pieSlicePath(startAngle, endAngle, radius) {
    const point = angle => [radius + radius * Math.cos(angle), radius + radius * Math.sin(angle)];
    const start = point(startAngle), end = point(endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    return `M ${radius} ${radius} L ${start[0]} ${start[1]} A ${radius} ${radius} 0 ${largeArc} 1 ${end[0]} ${end[1]} Z`;
  }

  function renderDocuments(rows) {
    if (!rows.length) {
      documentChart.innerHTML = '<p class="analytics-empty">No document requests yet.</p>';
      return;
    }
    const total = rows.reduce((sum, row) => sum + Number(row.request_count), 0);
    if (!total) {
      documentChart.innerHTML = '<p class="analytics-empty">No document requests yet.</p>';
      return;
    }
    const radius = 92, center = radius, size = radius * 2;
    let angle = -Math.PI / 2;
    const slices = rows.map((row, index) => {
      const value = Number(row.request_count);
      const nextAngle = angle + Math.PI * 2 * value / total;
      const color = colors[index % colors.length];
      const path = pieSlicePath(angle, nextAngle, radius);
      angle = nextAngle;
      return `<path d="${path}" fill="${color}" stroke="var(--white)" stroke-width="2"><title>${escape(row.name)}: ${value} (${(value * 100 / total).toFixed(1)}%)</title></path>`;
    }).join("");
    const legend = rows.map((row, index) => {
      const value = Number(row.request_count);
      const color = colors[index % colors.length];
      return `<li><span class="pie-legend-swatch" style="--pie-color:${color}" aria-hidden="true"></span><span class="pie-legend-name">${escape(row.name)}</span><strong>${(value * 100 / total).toFixed(1)}%</strong><span class="pie-legend-count">${value}</span></li>`;
    }).join("");
    documentChart.innerHTML = `<div class="pie-chart-layout">
      <svg viewBox="0 0 ${size} ${size}" class="pie-chart-svg" aria-hidden="true">${slices}</svg>
      <ul class="pie-chart-legend">${legend}</ul>
    </div>`;
  }

  async function load() {
    monthlyChart.innerHTML = '<p class="requests-empty">Loading chart...</p>';
    documentChart.innerHTML = '<p class="requests-empty">Loading chart...</p>';
    try {
      const data = await Api.get("requests.php", { action: "analytics" });
      renderMonthly(data.monthly);
      renderDocuments(data.documents);
    } catch (error) {
      const message = `<p class="analytics-empty">${escape(error.message)}</p>`;
      monthlyChart.innerHTML = message;
      documentChart.innerHTML = message;
    }
  }

  window.loadRequestAnalytics = load;
})();
