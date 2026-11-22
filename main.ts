// Driver for site-faster: reads every case, answers each one on its own with
// run() from solve.js, and writes the aligned answers array in one stringify.
// Paths default to /input and /output; MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// override them outside the grading container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Run without the optimising compiler before solve.js loads: a single cold
// pass never repays TurboFan/Maglev CPU, and the interpreter/baseline tiers
// produce byte-identical output. Unknown flags are ignored by
// setFlagsFromString, so on a V8 without it this simply loses the gain.
setFlagsFromString('--no-opt');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i].input);
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
