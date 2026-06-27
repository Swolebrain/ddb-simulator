# Simulation Gallery

Standalone HTML simulations published from `docs/` for GitHub Pages.

## Simulations

- `ddb-bucketing-scaling/` - DynamoDB partition-key bucketing throughput and scaling simulation.
- `ddb-bucketing-performance/` - DynamoDB bucketed listing strategy performance simulation.
- `team-throughput/` - SVG animation of developer throughput through CI, staging, and production.

## Local Development

Install dependencies:

```bash
npm install
```

Run the local Vite server with generated-page reloads:

```bash
npm run dev
```

Open the URL Vite prints and use the root gallery to navigate to each simulation.

## Build

Generate the GitHub Pages output in `docs/`:

```bash
npm run build
```

Type-check the generator sources:

```bash
npm run check
```

Preview the generated `docs/` site:

```bash
npm run preview
```

## GitHub Pages

GitHub Pages should publish from the committed `docs/` folder. The build preserves `docs/.nojekyll` and regenerates:

- `docs/index.html`
- `docs/ddb-bucketing-scaling/index.html`
- `docs/ddb-bucketing-performance/index.html`
- `docs/team-throughput/index.html`

## Precommit

The Husky precommit hook runs:

```bash
npm run check
npm run build
git diff --exit-code -- docs
```

Commits fail if TypeScript fails, the build fails, or committed `docs/` output is stale.
