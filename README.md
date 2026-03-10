# DynamoDB Partition Key Simulator

Monte Carlo simulation comparing three DynamoDB partition key strategies to determine max safe ops/s per customer as partition count scales.

**[Live Results →](https://swolebrain.github.io/ddb-simulator/)**

## Strategies Compared

1. **Current design** (`PK = containerId`) — All writes hit one partition. Hard-capped at 55 ops/s.
2. **Option 1** (`PK = containerId#resourceId`) — Uniform distribution across partitions. Scales linearly but subject to extreme-value hotspots.
3. **Option 2** (`PK = containerId#(hash(resourceId) % 32)`) — 32-bucket scheme. Plateaus near 1,745 ops/s once N ≥ 32. Variance is structural (per-container), not temporal.

The simulation also models **GSI backpressure**: without bucketed GSI partition keys, a hard ceiling of 600 ops/s applies regardless of base table design.

## Running

```bash
npm install
npm run simulate
```

This runs `npx ts-node simulation.ts` and generates `output.html` with an interactive Chart.js visualization.

Parameters: 600 WCU/partition, 11 WCU/op, 32 buckets, 20,000 Monte Carlo runs per data point.
