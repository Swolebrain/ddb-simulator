import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/ddb-bucketing-scaling"
);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const WCU_LIMIT_PER_PARTITION = 600; // max WCU a single customer may place on any one partition
const WCU_PER_OPERATION = 11; // each resource write costs 11 WCU (~10 KB item)
const WCU_PER_GSI_OPERATION = 1; // GSI projections are small (≤1 KB)
const NUM_BUCKETS = 32; // option 2: hash(resourceId) % 32
const NUM_RUNS = 20_000; // Monte Carlo iterations per partition count

const OPS_LIMIT_PER_PARTITION = WCU_LIMIT_PER_PARTITION / WCU_PER_OPERATION;
// Without GSI bucketing, all writes for a container hit the same GSI partition.
// The GSI caps throughput at WCU_LIMIT / 1 WCU regardless of base table partitioning.
const GSI_OPS_LIMIT = WCU_LIMIT_PER_PARTITION / WCU_PER_GSI_OPERATION;

// DynamoDB typically starts at 4 partitions and can grow into the thousands.
// We include non-power-of-2 values to surface uneven-distribution effects.
const PARTITION_COUNTS = [
  4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024,
  1536, 2048,
];

// ---------------------------------------------------------------------------
// PRNG helpers
// ---------------------------------------------------------------------------

// Mulberry32 – fast, deterministic 32-bit PRNG
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform: standard normal sample from two uniforms
function makeNormalSampler(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = Math.max(rng(), 1e-15);
    const u2 = rng();
    const mag = Math.sqrt(-2 * Math.log(u1));
    spare = mag * Math.sin(2 * Math.PI * u2);
    return mag * Math.cos(2 * Math.PI * u2);
  };
}

// ---------------------------------------------------------------------------
// Core simulation logic
// ---------------------------------------------------------------------------

interface PartitionResult {
  partitions: number;

  // Current design: all writes for a container go to one partition.
  currentDesignMaxOps: number;

  // Option 1: PK = containerId#resourceId.
  // Analytical upper bound assumes perfect uniform distribution.
  option1Analytical: number;
  // Simulated: models per-second Poisson variance across N partitions.
  // Each second a customer writes at rate R = N * OPS_LIMIT;
  // each partition's load ~ Poisson(OPS_LIMIT) ≈ Normal(OPS_LIMIT, √OPS_LIMIT).
  // Max safe R = OPS_LIMIT² * N / max_partition_load.
  option1P50: number;
  option1P99: number;

  // Option 2: PK = containerId#(hash(resourceId) % 32).
  // Structural variance: the 32 bucket PKs hash into N partitions once per container.
  // Max safe R = OPS_LIMIT * 32 / max_buckets_on_any_partition.
  option2Mean: number;
  option2P50: number;
  option2P95: number;
  option2P99: number;
  option2Theoretical: number;
}

function runSimulation(): PartitionResult[] {
  const rng = makePrng(0xdeadbeef);
  const normal = makeNormalSampler(rng);
  const results: PartitionResult[] = [];

  for (const N of PARTITION_COUNTS) {
    // ------------------------------------------------------------------
    // Option 1 simulation
    // Simulate at the analytical max rate: R = N * OPS_LIMIT.
    // Each of the N partitions receives Poisson(OPS_LIMIT) writes/sec,
    // approximated by Normal(OPS_LIMIT, √OPS_LIMIT).
    // ------------------------------------------------------------------
    const opt1MaxLoads: number[] = new Array(NUM_RUNS);
    for (let run = 0; run < NUM_RUNS; run++) {
      let max = 0;
      for (let i = 0; i < N; i++) {
        const load = OPS_LIMIT_PER_PARTITION + Math.sqrt(OPS_LIMIT_PER_PARTITION) * normal();
        if (load > max) max = load;
      }
      opt1MaxLoads[run] = max;
    }
    opt1MaxLoads.sort((a, b) => a - b);
    // max safe R = OPS_LIMIT * (N * OPS_LIMIT) / maxLoad = OPS_LIMIT² * N / maxLoad
    const opt1ToOps = (maxLoad: number) =>
      Math.round((OPS_LIMIT_PER_PARTITION * OPS_LIMIT_PER_PARTITION * N) / maxLoad);
    const opt1P50 = opt1MaxLoads[Math.floor(NUM_RUNS * 0.5)];
    const opt1P99 = opt1MaxLoads[Math.floor(NUM_RUNS * 0.99)];

    // ------------------------------------------------------------------
    // Option 2 simulation
    // Place NUM_BUCKETS uniform random points into N partitions (models
    // DDB's hash assignment of the 32 fixed bucket PKs per container).
    // ------------------------------------------------------------------
    const opt2MaxCounts: number[] = new Array(NUM_RUNS);
    for (let run = 0; run < NUM_RUNS; run++) {
      const counts = new Int32Array(N);
      for (let b = 0; b < NUM_BUCKETS; b++) {
        counts[Math.floor(rng() * N)]++;
      }
      let max = 0;
      for (let i = 0; i < N; i++) if (counts[i] > max) max = counts[i];
      opt2MaxCounts[run] = max;
    }
    opt2MaxCounts.sort((a, b) => a - b);
    const opt2ToOps = (maxB: number) =>
      Math.round((OPS_LIMIT_PER_PARTITION * NUM_BUCKETS) / maxB);
    const opt2Sum = opt2MaxCounts.reduce((a, b) => a + b, 0);
    const opt2Mean = opt2Sum / NUM_RUNS;
    const opt2P50 = opt2MaxCounts[Math.floor(NUM_RUNS * 0.5)];
    const opt2P95 = opt2MaxCounts[Math.floor(NUM_RUNS * 0.95)];
    const opt2P99 = opt2MaxCounts[Math.floor(NUM_RUNS * 0.99)];

    results.push({
      partitions: N,
      currentDesignMaxOps: Math.round(OPS_LIMIT_PER_PARTITION),
      option1Analytical: Math.round(OPS_LIMIT_PER_PARTITION * N),
      option1P50: opt1ToOps(opt1P50),
      option1P99: opt1ToOps(opt1P99),
      option2Mean: opt2ToOps(opt2Mean),
      option2P50: opt2ToOps(opt2P50),
      option2P95: opt2ToOps(opt2P95),
      option2P99: opt2ToOps(opt2P99),
      option2Theoretical: Math.round(OPS_LIMIT_PER_PARTITION * NUM_BUCKETS),
    });

    process.stdout.write(
      `N=${String(N).padStart(5)} | ` +
        `Opt1 analytical=${String(Math.round(OPS_LIMIT_PER_PARTITION * N)).padStart(7)} ` +
        `p50=${String(opt1ToOps(opt1P50)).padStart(7)} ` +
        `p99=${String(opt1ToOps(opt1P99)).padStart(7)} | ` +
        `Opt2 p50=${String(opt2ToOps(opt2P50)).padStart(6)} ` +
        `p99=${String(opt2ToOps(opt2P99)).padStart(6)}\n`
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function generateHtml(results: PartitionResult[]): string {
  const labels = results.map((r) => r.partitions);
  const datasets = {
    currentDesign:       results.map((r) => r.currentDesignMaxOps),
    option1Analytical:   results.map((r) => r.option1Analytical),
    option1P50:          results.map((r) => r.option1P50),
    option1P99:          results.map((r) => r.option1P99),
    option2Theoretical:  results.map((r) => r.option2Theoretical),
    option2P50:          results.map((r) => r.option2P50),
    option2Mean:         results.map((r) => r.option2Mean),
    option2P95:          results.map((r) => r.option2P95),
    option2P99:          results.map((r) => r.option2P99),
    gsiBackpressure:     results.map(() => GSI_OPS_LIMIT),
  };

  const opsLimit = Math.round(OPS_LIMIT_PER_PARTITION);
  const opsCeiling = Math.round(OPS_LIMIT_PER_PARTITION * NUM_BUCKETS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DynamoDB Partition Key Design – Max Safe Ops/s Simulation</title>
  <link rel="icon" href="data:," />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      margin: 0;
      padding: 24px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 4px; color: #f8fafc; }
    .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 32px; }
    .card {
      background: #1e2230;
      border: 1px solid #2d3352;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .chart-wrap { position: relative; height: 520px; }
    .legend-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 10px;
      margin-top: 24px;
    }
    .legend-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      background: #252a3a;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.8rem;
    }
    .legend-swatch {
      width: 14px;
      height: 14px;
      border-radius: 3px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .legend-label { font-weight: 600; color: #f1f5f9; }
    .legend-desc { color: #94a3b8; margin-top: 2px; line-height: 1.4; }
    .params {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 0.8rem;
      color: #64748b;
      margin-top: 8px;
    }
    .param { background: #1e2230; border: 1px solid #2d3352; border-radius: 6px; padding: 4px 10px; }
    .insights { line-height: 1.7; color: #cbd5e1; font-size: 0.9rem; }
    .insights li { margin-bottom: 8px; }
    code { background: #252a3a; padding: 1px 5px; border-radius: 4px; font-family: monospace; font-size: 0.85em; }
  </style>
</head>
<body>

<h1>DynamoDB Partition Key Design – Max Safe Ops/s per Customer</h1>
<p class="subtitle">
  Monte Carlo simulation (${NUM_RUNS.toLocaleString()} runs per data point) •
  Constraint: ≤ ${WCU_LIMIT_PER_PARTITION} WCU (${opsLimit} ops/s) from any single customer on any single partition •
  ${WCU_PER_OPERATION} WCU per operation
</p>

<div class="params">
  <span class="param">WCU / operation: <strong>${WCU_PER_OPERATION}</strong></span>
  <span class="param">WCU limit / partition: <strong>${WCU_LIMIT_PER_PARTITION}</strong></span>
  <span class="param">Ops/s limit / partition: <strong>${opsLimit}</strong></span>
  <span class="param">Buckets (option 2): <strong>${NUM_BUCKETS}</strong></span>
  <span class="param">Option 2 ceiling: <strong>${opsCeiling.toLocaleString()} ops/s</strong></span>
  <span class="param">GSI backpressure: <strong>${GSI_OPS_LIMIT.toLocaleString()} ops/s</strong></span>
  <span class="param">Runs / point: <strong>${NUM_RUNS.toLocaleString()}</strong></span>
</div>

<br/>

<div class="card">
  <div class="chart-wrap">
    <canvas id="chart"></canvas>
  </div>
  <div class="legend-grid" id="legendGrid"></div>
</div>

<div class="card">
  <h2 style="margin-top:0; font-size:1.1rem;">Key Insights</h2>
  <ul class="insights">
    <li>
      <strong>Current design</strong> (<code>PK = containerId</code>): every write hits the same
      partition. Hard cap at <code>${opsLimit} ops/s</code> forever.
    </li>
    <li>
      <strong>Option 1 – analytical</strong>: the theoretical ceiling assuming perfectly uniform
      distribution across all N partitions. Grows linearly with N but provides no noisy-neighbor isolation.
    </li>
    <li>
      <strong>Option 1 – simulated</strong>: each second, a customer's writes distribute as
      Poisson(R/N) per partition. Even with random UUIDs the <em>extreme value</em> effect means
      the busiest partition will exceed R/N, especially as N grows. The P99 line shows the rate at
      which 99% of seconds stay within the per-partition limit. The gap from analytical widens with
      N because more partitions means a higher expected maximum.
    </li>
    <li>
      <strong>Option 2 – simulated</strong>: structural variance — the 32 bucket PKs are mapped
      to physical partitions once, permanently. P50 and P99 are across containers, not time: 1% of
      containers will have an unlucky bucket-to-partition mapping that permanently limits them below P99.
      Once N ≥ 32, load plateaus near <code>${opsCeiling} ops/s</code>.
    </li>
    <li>
      <strong>GSI backpressure</strong>: the table has GSIs keyed by resource attributes without
      bucketing. GSI projections are small (1 WCU/write), but without a bucket suffix in the GSI
      partition key, all writes for a container land on the same GSI partition.
      This creates a hard ceiling of <code>${GSI_OPS_LIMIT} ops/s</code> — the API throttle must
      be set below this regardless of how well the base table scales. To remove this ceiling,
      the GSIs would need to adopt the same bucketing scheme.
    </li>
  </ul>
</div>

<script>
const labels = ${JSON.stringify(labels)};
const data = ${JSON.stringify(datasets)};

const COLORS = {
  currentDesign:      '#ef4444',
  option1Analytical:  '#3b82f6',
  option1P50:         '#7dd3fc',
  option1P99:         '#1d4ed8',
  option2Theoretical: '#a78bfa',
  option2P50:         '#22c55e',
  option2Mean:        '#86efac',
  option2P95:         '#facc15',
  option2P99:         '#f97316',
  gsiBackpressure:    '#f43f5e',
};

const LEGEND = [
  { key: 'currentDesign',     label: 'Current design (PK = containerId)',            desc: 'All writes hit one partition. Hard cap at ${opsLimit} ops/s forever.' },
  { key: 'option1Analytical', label: 'Option 1 – analytical (ideal uniform)',         desc: 'OPS_LIMIT × N. Assumes perfect distribution; an upper bound, not achievable in practice.' },
  { key: 'option1P50',        label: 'Option 1 – P50 simulated',                     desc: 'Median second: the rate at which half of all seconds stay within the partition limit.' },
  { key: 'option1P99',        label: 'Option 1 – P99 simulated',                     desc: 'Conservative rate: 99% of seconds stay within limit. Gap from analytical grows with N due to extreme-value effect.' },
  { key: 'option2Theoretical',label: 'Option 2 – theoretical ceiling',                desc: '${opsLimit} × ${NUM_BUCKETS} = ${opsCeiling} ops/s. Asymptotic maximum for the bucketing scheme.' },
  { key: 'option2P50',        label: 'Option 2 – P50 (median container)',             desc: 'Half of containers will get at least this much headroom from their bucket mapping.' },
  { key: 'option2Mean',       label: 'Option 2 – mean',                              desc: 'Average max-safe ops/s across Monte Carlo runs.' },
  { key: 'option2P95',        label: 'Option 2 – P95',                              desc: '5% of containers get less than this due to bucket collisions.' },
  { key: 'option2P99',        label: 'Option 2 – P99 (conservative container limit)', desc: 'Only 1% of containers are permanently limited below this.' },
  { key: 'gsiBackpressure',   label: 'GSI backpressure limit (unbucketed)',            desc: 'Without GSI bucketing, all writes for a container hit the same GSI partition (1 WCU/op). Hard ceiling at ${GSI_OPS_LIMIT} ops/s regardless of base table scale.' },
];

const chartDatasets = [
  { label: 'Current design',             data: data.currentDesign,      borderColor: COLORS.currentDesign,     borderWidth: 2,   borderDash: [6,3], pointRadius: 3, tension: 0.3, fill: false },
  { label: 'Option 1 – analytical',      data: data.option1Analytical,  borderColor: COLORS.option1Analytical, borderWidth: 2,   borderDash: [4,2], pointRadius: 2, tension: 0.3, fill: false },
  { label: 'Option 1 – P50 simulated',   data: data.option1P50,         borderColor: COLORS.option1P50,        borderWidth: 2,   pointRadius: 3,    tension: 0.3, fill: false },
  { label: 'Option 1 – P99 simulated',   data: data.option1P99,         borderColor: COLORS.option1P99,        borderWidth: 2.5, pointRadius: 3,    tension: 0.3, fill: false },
  { label: 'Option 2 – theoretical',     data: data.option2Theoretical, borderColor: COLORS.option2Theoretical,borderWidth: 1.5, borderDash: [4,4], pointRadius: 0, tension: 0,   fill: false },
  { label: 'Option 2 – P50',             data: data.option2P50,         borderColor: COLORS.option2P50,        borderWidth: 2.5, pointRadius: 3,    tension: 0.3, fill: false },
  { label: 'Option 2 – mean',            data: data.option2Mean,        borderColor: COLORS.option2Mean,       borderWidth: 1.5, borderDash: [3,2], pointRadius: 2, tension: 0.3, fill: false },
  { label: 'Option 2 – P95',             data: data.option2P95,         borderColor: COLORS.option2P95,        borderWidth: 1.5, pointRadius: 2,    tension: 0.3, fill: false },
  { label: 'Option 2 – P99',             data: data.option2P99,         borderColor: COLORS.option2P99,        borderWidth: 2,   pointRadius: 3,    tension: 0.3, fill: false },
  { label: 'GSI backpressure (unbucketed)', data: data.gsiBackpressure, borderColor: COLORS.gsiBackpressure,   borderWidth: 2.5, borderDash: [8,4], pointRadius: 0, tension: 0,   fill: false },
];

const ctx = document.getElementById('chart').getContext('2d');
new Chart(ctx, {
  type: 'line',
  data: { labels, datasets: chartDatasets },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1e2230',
        borderColor: '#2d3352',
        borderWidth: 1,
        titleColor: '#f8fafc',
        bodyColor: '#cbd5e1',
        callbacks: {
          title: items => \`\${items[0].label} partitions\`,
          label: ctx => \` \${ctx.dataset.label}: \${ctx.parsed.y.toLocaleString()} ops/s\`,
        },
      },
    },
    scales: {
      x: {
        type: 'logarithmic',
        title: {
          display: true,
          text: 'DynamoDB partitions (N)',
          color: '#94a3b8',
          font: { size: 12 },
          padding: { top: 8 },
        },
        afterBuildTicks: scale => {
          scale.ticks = labels.map(v => ({ value: v }));
        },
        ticks: {
          color: '#64748b',
          maxRotation: 45,
          minRotation: 45,
          callback: v => v,
        },
        grid: { color: '#1e2a3a' },
      },
      y: {
        type: 'logarithmic',
        title: {
          display: true,
          text: 'Max safe ops/s per customer',
          color: '#94a3b8',
          font: { size: 12, weight: 'bold' },
          padding: { bottom: 12 },
        },
        ticks: {
          color: '#64748b',
          callback: v => {
            if (v < 1) return null;
            const leading = String(Math.round(v))[0];
            return (leading === '1' || leading === '2' || leading === '5') ? (+v).toLocaleString() : null;
          },
        },
        grid: { color: '#1e2a3a' },
      },
    },
  },
});

const grid = document.getElementById('legendGrid');
LEGEND.forEach(({ key, label, desc }) => {
  const el = document.createElement('div');
  el.className = 'legend-item';
  el.innerHTML = \`
    <div class="legend-swatch" style="background:\${COLORS[key]}"></div>
    <div>
      <div class="legend-label">\${label}</div>
      <div class="legend-desc">\${desc}</div>
    </div>
  \`;
  grid.appendChild(el);
});
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Running simulation...\n");
const results = runSimulation();
const html = generateHtml(results);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "index.html"), html, "utf8");
console.log("\nWrote docs/ddb-bucketing-scaling/index.html");
