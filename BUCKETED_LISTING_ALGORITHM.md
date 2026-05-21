# Bucketed DynamoDB Listing Algorithm

## Background

A DynamoDB table stores child resources under a container resource. Today, the partition key is the container resource ID, meaning all children share a single DynamoDB partition. This limits write throughput to ~60 TPS per container (a single partition's write capacity).

To break this bottleneck, we split each container's children across **B buckets** (e.g., 31). The new partition key becomes `{ContainerID}_{BucketNumber}`, where `BucketNumber = hash(childId) % B`. Writes now distribute across B partitions, scaling throughput linearly.

The challenge: **List operations** must still return a unified, paginated view across all buckets.

---

## The Problem

A caller asks: "Give me page N of all children in container X, page size P." The data is spread across B partitions. How do we assemble a single paginated result set?

Two approaches:

---

## Approach A: Sequential Bucket Drain (Single Cursor)

**Concept:** Drain one bucket at a time. Don't move to the next bucket until the current one is fully exhausted.

**Algorithm:**

1. Start at bucket 0. Query bucket 0 for up to P items.
2. If bucket 0 returns P items with a `LastEvaluatedKey`, or returns P items without one (ambiguous — might be more): return those P items. The pagination cursor is `{current_bucket: 0, start_key: LastEvaluatedKey}` (or `{current_bucket: 1, start_key: null}` if no LEK but exactly P items returned — This means the end of that partition was reached and is a rare edge case).
3. If bucket 0 returns fewer than P items (bucket exhausted): take those items, move to bucket 1, query bucket 1 for up to `P - items_so_far` items. Continue until the page is full or all buckets are exhausted.
4. The pagination cursor always contains just: which bucket we're currently in, and optionally a DynamoDB `ExclusiveStartKey` within that bucket.
5. On subsequent calls, resume from `current_bucket` using the stored start key. If that bucket exhausts mid-page, advance to the next bucket and continue filling.

**Characteristics:**

- **Token size:** Minimal — one bucket number + at most one DynamoDB key.
- **Queries per page:** Usually 1. Only multiple when a bucket exhausts mid-page and we spill into the next.
- **RCU efficiency:** Excellent — every item fetched is returned. No wasted reads.
- **Ordering:** Items are grouped by bucket. All of bucket 0's items come before bucket 1's items, etc. Within a bucket, ordered by sort key.
- **Latency per page:** Single DynamoDB query in the common case. Very fast.
- **Downside — uneven page sizes near bucket boundaries:** When a bucket exhausts mid-page, you issue a second query to the next bucket to fill the remainder. Minor.
- **Downside — no parallelism:** Each page hits exactly one partition. You don't benefit from parallel fan-out.
- **Skewed distributions:** If one bucket has 90% of items, most pages are served from that one bucket (fast, efficient). The nearly-empty buckets are drained quickly when reached.

---

## Approach B: Parallel All-Bucket Query (Multi-Cursor)

**Concept:** Query all B buckets in parallel on every call. Fill the page sequentially by bucket number from the combined results.

**Algorithm:**

1. Query all B buckets in parallel, requesting up to P items from each.
2. Fill the result page sequentially by bucket number: take all items from bucket 0 first. If the page isn't full, take items from bucket 1. Continue until P items are collected.
3. Determine the pagination cursor:
   - Walk through the buckets that contributed items to the page. For each bucket:
     - If you used **all** its returned items and it returned no `LastEvaluatedKey` → bucket is exhausted, no cursor needed.
     - If you used **all** its returned items and it **did** return a `LastEvaluatedKey` → bucket may have more. Store this bucket number and its `LastEvaluatedKey`.
     - If you used only **some** of its returned items (page filled mid-bucket) → this bucket is where we resume. Store this bucket number and construct a start key from the last item taken.
   - The cursor contains: the **first non-exhausted bucket** and its start key.
4. On subsequent calls, skip all buckets before `last_bucket` (they're exhausted). Query from `last_bucket` onward (using the start key for `last_bucket`, fresh queries for later buckets). Fill the page sequentially as before.

**The key distinction from Approach A:**

- Approach A: Query **one bucket at a time**, sequentially. Move to the next only when the current is exhausted.
- Approach B: Query **all remaining buckets in parallel** on every call, but fill the page sequentially. Skip exhausted buckets on subsequent calls.

**Characteristics:**

- **Token size:** Still minimal — one bucket number + one DynamoDB key. Same as Approach A.
- **Queries per page:** B on the first call, decreasing as buckets exhaust. But always queries all non-exhausted buckets.
- **RCU efficiency:** Poor — you fetch up to P×B items but only return P. Items fetched from later buckets are discarded if earlier buckets filled the page.
- **Ordering:** Same as Approach A — sequential by bucket number.
- **Latency per page:** Bounded by the slowest of the parallel queries. Doesn't improve much until many buckets exhaust.
- **Upside — faster exhaustion detection:** You learn immediately which buckets are empty, rather than discovering it sequentially.
- **Downside — wasted RCU:** On early pages, you fetch P items from all B buckets but may only use items from the first 1–2 buckets. The rest are thrown away.
- **Skewed distributions:** Wastes more RCU on nearly-empty buckets (fetches from them even though they contribute few items).

---

## Key Tradeoffs to Simulate

| Dimension | Approach A (Sequential Drain) | Approach B (Parallel All-Bucket) |
|-----------|-------------------------------|----------------------------------|
| Queries per page | 1 (occasionally 2 at bucket boundaries) | B, decreasing as buckets exhaust |
| RCU per page | P (exactly what's returned) | Up to P×B (most discarded on early pages) |
| Latency per page | Sum of Single DDB queries (~ms) | Max of B parallel queries |
| Total RCU for full pagination | Optimal — reads exactly N items total | N + wasted reads from later buckets |
| Token size | O(1) | O(1) |
| Parallelism benefit | None | Discovers empty buckets faster |
| Time to complete full pagination | B sequential bucket drains, each paginated | Fewer total pages (fills from multiple buckets) but each page costs more |
| Skew handling | Efficient — stays on the big bucket | Wasteful — queries empty buckets repeatedly |

## What the Simulation Should Measure

- **Total RCU consumed** across a full pagination of N items at page size P
- **Number of DynamoDB queries issued** across full pagination
- **P50 and P99 latency per page** (modeled as max query latency across parallel calls for B, single query latency for A)
- **Wasted items fetched but not returned** across full pagination
- **Total number of pages** to drain all items
- **Behavior under uniform distribution** (items spread evenly across buckets)
- **Behavior under skewed distribution** (e.g., 80% of items in 3 buckets)
