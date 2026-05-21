import { runSimulation, NUM_BUCKETS } from './simulation';
import Chart from 'chart.js/auto';

const resourcesSlider = document.getElementById('nested-resources-slider') as HTMLInputElement;
const resourcesValue = document.getElementById('nested-resources-value') as HTMLSpanElement;
const pageSizeSlider = document.getElementById('page-size-slider') as HTMLInputElement;
const pageSizeValue = document.getElementById('page-size-value') as HTMLSpanElement;
const parallelSlider = document.getElementById('parallel-slider') as HTMLInputElement;
const parallelValue = document.getElementById('parallel-value') as HTMLSpanElement;
const status = document.getElementById('status') as HTMLSpanElement;

parallelSlider.max = String(NUM_BUCKETS);

const chartConfigs = [
  { id: 'chart-rcu', title: 'RCU (Mean)', key: 'rcuMean' as const },
  { id: 'chart-queries', title: 'Queries (Mean)', key: 'queriesMean' as const },
  { id: 'chart-lat-mean', title: 'Latency Mean (ms)', key: 'latMean' as const },
  { id: 'chart-lat-p50', title: 'Latency P50 (ms)', key: 'latP50' as const },
  { id: 'chart-lat-p99', title: 'Latency P99 (ms)', key: 'latP99' as const },
];

const charts: Chart[] = chartConfigs.map(cfg => {
  const ctx = (document.getElementById(cfg.id) as HTMLCanvasElement).getContext('2d')!;
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [''],
      datasets: [
        { label: 'A (Sequential)', data: [0], backgroundColor: 'rgba(54,162,235,0.7)' },
        { label: 'B (Parallel)', data: [0], backgroundColor: 'rgba(255,99,132,0.7)' },
        { label: 'C (Hybrid)', data: [0], backgroundColor: 'rgba(75,192,192,0.7)' },
      ],
    },
    options: { responsive: true, plugins: { title: { display: true, text: cfg.title } } },
  });
});

function run() {
  const numResources = parseInt(resourcesSlider.value);
  const pageSize = parseInt(pageSizeSlider.value);
  const parallelFetches = parseInt(parallelSlider.value);
  resourcesValue.textContent = String(numResources);
  pageSizeValue.textContent = String(pageSize);
  parallelValue.textContent = String(parallelFetches);
  status.textContent = 'Running...';

  setTimeout(() => {
    const result = runSimulation(numResources, pageSize, parallelFetches);
    chartConfigs.forEach((cfg, i) => {
      charts[i].data.datasets[0].data = [result.a[cfg.key]];
      charts[i].data.datasets[1].data = [result.b[cfg.key]];
      charts[i].data.datasets[2].data = [result.c[cfg.key]];
      charts[i].update();
    });
    status.textContent = '';
  }, 10);
}

let timer: number;
function debouncedRun() {
  clearTimeout(timer);
  timer = window.setTimeout(run, 300);
}

resourcesSlider.addEventListener('input', () => { resourcesValue.textContent = resourcesSlider.value; debouncedRun(); });
pageSizeSlider.addEventListener('input', () => { pageSizeValue.textContent = pageSizeSlider.value; debouncedRun(); });
parallelSlider.addEventListener('input', () => { parallelValue.textContent = parallelSlider.value; debouncedRun(); });

run();
