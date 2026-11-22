# site-faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mr1229751/site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mr1229751/site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

site-faster is a dependency-free, from-scratch reimplementation of the makefun-site 1.0.0 static site generator that returns the identical output tree for every input — every generated page, index and tag page, static file and the build report, byte for byte — while doing far less work per character: one line split per source shared by the front-matter parser and the Markdown lexer, a char-code block classifier, and a single-pass inline scanner that copies plain text runs instead of escaping character by character. `main.ts` is the harness driver (reads cases, answers each one alone with `run()` from `solve.js`, writes the aligned answers array); `solve.js` is the whole generator.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=site-faster&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
