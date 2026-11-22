// Driver for the site-generator speed entry.
// The --no-opt flag is set first, on purpose: the harness times a
// single cold pass, so the CPU V8 would spend in its optimising
// tiers is never repaid by that one execution. Disabling it via
// node:v8 before the solver exists keeps the whole run in the
// baseline tier, and solve.js is loaded with a dynamic import
// further down — a static import would be hoisted and evaluated
// ahead of the flag call, defeating the ordering.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-opt');

type CaseRow = { id: string; input: unknown };

async function drive(): Promise<void> {
  const solverHref = new URL('./solve.js', import.meta.url).href;
  const solver = (await import(solverHref)) as {
    run: (input: unknown) => unknown;
  };

  const sourceDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const payload = readFileSync(join(sourceDir, 'cases.json'), 'utf8');
  const rows = JSON.parse(payload) as CaseRow[];

  const collected: unknown[] = [];
  for (const row of rows) collected.push(solver.run(row.input));

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'answers.json'), JSON.stringify(collected));
}

await drive();
