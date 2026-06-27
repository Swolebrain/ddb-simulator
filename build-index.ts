import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "docs");

const simulations = [
  {
    title: "DDB Bucketing Scaling",
    href: "./ddb-bucketing-scaling/",
    description:
      "Monte Carlo visualization of DynamoDB partition-key bucketing throughput and scaling behavior.",
  },
  {
    title: "DDB Bucketing Performance",
    href: "./ddb-bucketing-performance/",
    description:
      "Interactive comparison of sequential, parallel, and hybrid query strategies for bucketed DynamoDB listings.",
  },
  {
    title: "Team Throughput",
    href: "./team-throughput/",
    description:
      "Animated SVG simulation of developers, pull-request CI, staging, and production release flow.",
  },
];

const cards = simulations
  .map(
    (simulation) => `
      <a class="card" href="${simulation.href}">
        <span>Simulation</span>
        <strong>${simulation.title}</strong>
        <p>${simulation.description}</p>
      </a>`
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Simulations</title>
  <link rel="icon" href="data:," />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 20% 15%, #1e3a8a 0, #0f172a 42%, #020617 100%);
      color: #e5edf8;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1040px, 100%);
      margin: 0 auto;
      padding: clamp(28px, 8vw, 88px) 20px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(2.25rem, 8vw, 5rem);
      letter-spacing: -0.07em;
      line-height: 0.94;
    }
    .intro {
      max-width: 680px;
      margin: 0 0 34px;
      color: #9fb0c8;
      font-size: 1.05rem;
      line-height: 1.55;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
    }
    .card {
      display: grid;
      gap: 12px;
      min-height: 220px;
      padding: 24px;
      border: 1px solid rgba(148, 163, 184, 0.26);
      border-radius: 24px;
      background: linear-gradient(145deg, rgba(15, 23, 42, 0.92), rgba(30, 41, 59, 0.66));
      color: inherit;
      text-decoration: none;
      box-shadow: 0 22px 60px rgba(0, 0, 0, 0.32);
      transition: transform 150ms ease, border-color 150ms ease, background 150ms ease;
    }
    .card:hover, .card:focus-visible {
      transform: translateY(-3px);
      border-color: rgba(125, 211, 252, 0.75);
      background: linear-gradient(145deg, rgba(12, 74, 110, 0.78), rgba(30, 41, 59, 0.74));
      outline: none;
    }
    .card span {
      width: fit-content;
      border: 1px solid rgba(125, 211, 252, 0.38);
      border-radius: 999px;
      padding: 5px 10px;
      color: #93c5fd;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .card strong {
      font-size: 1.55rem;
      line-height: 1.08;
      letter-spacing: -0.04em;
    }
    .card p {
      margin: 0;
      color: #a8b7cc;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <main>
    <h1>Simulations</h1>
    <p class="intro">Standalone HTML simulations. Each route is a regular linked page so it works locally, from Vite, and on GitHub Pages from the committed <code>docs/</code> folder.</p>
    <section class="grid" aria-label="Available simulations">
${cards}
    </section>
  </main>
</body>
</html>`;

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "index.html"), html, "utf8");
console.log("Wrote docs/index.html");
