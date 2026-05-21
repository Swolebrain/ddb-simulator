export const NUM_BUCKETS = 31;
export const NUM_RUNS = 1000;
export const PAGE_SIZE = 10;

function normalRandom(mean: number, stdev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0.01, mean + z * stdev);
}

function uniformInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function distributeResources(numResources: number): number[] {
  const base = numResources / NUM_BUCKETS;
  const buckets = Array.from({ length: NUM_BUCKETS }, () =>
    Math.max(0, Math.round(base) + uniformInt(-3, 3))
  );
  let diff = numResources - buckets.reduce((a, b) => a + b, 0);
  while (diff !== 0) {
    const i = uniformInt(0, NUM_BUCKETS - 1);
    if (diff > 0) { buckets[i]++; diff--; }
    else if (buckets[i] > 0) { buckets[i]--; diff++; }
  }
  return buckets;
}

export interface Metrics {
  totalRcu: number;
  totalQueries: number;
  totalPages: number;
  pageLatencies: number[];
}

function simulateDdbQuery(itemsLeft: number, itemsRequested: number) {
  const latency = normalRandom(10, 1);
  const itemsReturned = Math.min(itemsLeft, itemsRequested);
  const hasLEK = itemsLeft >= itemsRequested;
  return { itemsReturned, hasLEK, latency };
}

export function approachA(bucketItems: number[], pageSize: number): Metrics {
  const metrics: Metrics = { totalRcu: 0, totalQueries: 0, totalPages: 0, pageLatencies: [] };
  const remaining = [...bucketItems];
  let currentBucket = 0;

  while (currentBucket < NUM_BUCKETS) {
    let pageItems = 0;
    let pageLatency = 0;
    let itemsNeeded = pageSize;

    while (itemsNeeded > 0 && currentBucket < NUM_BUCKETS) {
      const { itemsReturned, hasLEK, latency } = simulateDdbQuery(remaining[currentBucket], itemsNeeded);
      remaining[currentBucket] -= itemsReturned;
      pageItems += itemsReturned;
      itemsNeeded -= itemsReturned;
      pageLatency += latency;
      metrics.totalRcu += itemsReturned;
      metrics.totalQueries++;

      if (!hasLEK) currentBucket++;
      else break;
    }

    if (pageItems > 0) {
      metrics.totalPages++;
      metrics.pageLatencies.push(pageLatency);
    }
  }
  return metrics;
}

export function approachB(bucketItems: number[], pageSize: number): Metrics {
  const metrics: Metrics = { totalRcu: 0, totalQueries: 0, totalPages: 0, pageLatencies: [] };
  const remaining = [...bucketItems];
  let firstNonExhausted = 0;

  while (firstNonExhausted < NUM_BUCKETS) {
    let pageItems = 0;
    let itemsNeeded = pageSize;
    const queryLatencies: number[] = [];
    const snapshot = [...remaining];

    const results: Array<{ bucket: number; returned: number; hasLEK: boolean; latency: number }> = [];
    for (let i = firstNonExhausted; i < NUM_BUCKETS; i++) {
      const { itemsReturned, hasLEK, latency } = simulateDdbQuery(remaining[i], pageSize);
      results.push({ bucket: i, returned: itemsReturned, hasLEK, latency });
      queryLatencies.push(latency);
      metrics.totalQueries++;
      metrics.totalRcu += itemsReturned;
    }

    const pageLatency = Math.max(...queryLatencies);
    let pageFilled = false;

    for (const { bucket, returned, hasLEK } of results) {
      const take = Math.min(returned, itemsNeeded);
      remaining[bucket] -= take;
      pageItems += take;
      itemsNeeded -= take;

      if (itemsNeeded === 0) {
        if (take < returned || hasLEK) firstNonExhausted = bucket;
        else firstNonExhausted = bucket + 1;
        for (let j = firstNonExhausted + 1; j < NUM_BUCKETS; j++) remaining[j] = snapshot[j];
        pageFilled = true;
        break;
      }
    }

    if (!pageFilled) firstNonExhausted = NUM_BUCKETS;
    if (pageItems > 0) {
      metrics.totalPages++;
      metrics.pageLatencies.push(pageLatency);
    }
    while (firstNonExhausted < NUM_BUCKETS && remaining[firstNonExhausted] === 0) firstNonExhausted++;
  }
  return metrics;
}

export function approachC(bucketItems: number[], pageSize: number, parallelFetches: number = 2): Metrics {
  const metrics: Metrics = { totalRcu: 0, totalQueries: 0, totalPages: 0, pageLatencies: [] };
  const remaining = [...bucketItems];
  let firstNonExhausted = 0;
  let isFirstPage = true;

  while (firstNonExhausted < NUM_BUCKETS) {
    let pageItems = 0;
    let itemsNeeded = pageSize;
    let pageLatency = 0;

    if (isFirstPage) {
      const snapshot = [...remaining];
      const queryLatencies: number[] = [];
      const results: Array<{ bucket: number; returned: number; hasLEK: boolean; latency: number }> = [];

      for (let i = 0; i < NUM_BUCKETS; i++) {
        const { itemsReturned, hasLEK, latency } = simulateDdbQuery(remaining[i], pageSize);
        results.push({ bucket: i, returned: itemsReturned, hasLEK, latency });
        queryLatencies.push(latency);
        metrics.totalQueries++;
        metrics.totalRcu += itemsReturned;
      }

      pageLatency = Math.max(...queryLatencies);

      let pageFilled = false;
      for (const { bucket, returned, hasLEK } of results) {
        const take = Math.min(returned, itemsNeeded);
        remaining[bucket] -= take;
        pageItems += take;
        itemsNeeded -= take;

        if (itemsNeeded === 0) {
          if (take < returned || hasLEK) firstNonExhausted = bucket;
          else firstNonExhausted = bucket + 1;
          for (let j = firstNonExhausted + 1; j < NUM_BUCKETS; j++) remaining[j] = snapshot[j];
          pageFilled = true;
          break;
        }
      }

      if (!pageFilled) firstNonExhausted = NUM_BUCKETS;
      isFirstPage = false;
    } else {
      while (itemsNeeded > 0 && firstNonExhausted < NUM_BUCKETS) {
        const pairBuckets: number[] = [];
        for (let b = 0; b < parallelFetches && firstNonExhausted + b < NUM_BUCKETS; b++) {
          pairBuckets.push(firstNonExhausted + b);
        }

        const pairResults: Array<{ bucket: number; returned: number; hasLEK: boolean; latency: number }> = [];
        const pairLatencies: number[] = [];
        for (const i of pairBuckets) {
          const { itemsReturned, hasLEK, latency } = simulateDdbQuery(remaining[i], pageSize);
          pairResults.push({ bucket: i, returned: itemsReturned, hasLEK, latency });
          pairLatencies.push(latency);
          metrics.totalQueries++;
          metrics.totalRcu += itemsReturned;
        }

        pageLatency += Math.max(...pairLatencies);

        let filled = false;
        for (const { bucket, returned, hasLEK } of pairResults) {
          const take = Math.min(returned, itemsNeeded);
          remaining[bucket] -= take;
          pageItems += take;
          itemsNeeded -= take;

          if (itemsNeeded === 0) {
            if (take < returned || hasLEK) firstNonExhausted = bucket;
            else firstNonExhausted = bucket + 1;
            filled = true;
            break;
          } else {
            firstNonExhausted = bucket + 1;
          }
        }
        if (filled) break;
      }
    }

    if (pageItems > 0) {
      metrics.totalPages++;
      metrics.pageLatencies.push(pageLatency);
    }
    while (firstNonExhausted < NUM_BUCKETS && remaining[firstNonExhausted] === 0) firstNonExhausted++;
  }
  return metrics;
}

export interface AggregateStats {
  rcuMean: number;
  queriesMean: number;
  latMean: number;
  latP50: number;
  latP99: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function runSimulation(numResources: number, pageSize: number = PAGE_SIZE, parallelFetches: number = 2): { a: AggregateStats; b: AggregateStats; c: AggregateStats } {
  const statsA: number[][] = [[], [], []]; // rcu, queries, latency
  const statsB: number[][] = [[], [], []];
  const statsC: number[][] = [[], [], []];

  for (let run = 0; run < NUM_RUNS; run++) {
    const buckets = distributeResources(numResources);
    const mA = approachA(buckets, pageSize);
    const mB = approachB(buckets, pageSize);
    const mC = approachC(buckets, pageSize, parallelFetches);

    statsA[0].push(mA.totalRcu); statsA[1].push(mA.totalQueries); statsA[2].push(mA.pageLatencies.reduce((a, b) => a + b, 0));
    statsB[0].push(mB.totalRcu); statsB[1].push(mB.totalQueries); statsB[2].push(mB.pageLatencies.reduce((a, b) => a + b, 0));
    statsC[0].push(mC.totalRcu); statsC[1].push(mC.totalQueries); statsC[2].push(mC.pageLatencies.reduce((a, b) => a + b, 0));
  }

  function agg(stats: number[][]): AggregateStats {
    const [r, q, l] = stats.map(s => [...s].sort((a, b) => a - b));
    return { rcuMean: mean(r), queriesMean: mean(q), latMean: mean(l), latP50: percentile(l, 50), latP99: percentile(l, 99) };
  }

  return { a: agg(statsA), b: agg(statsB), c: agg(statsC) };
}
