# diff-speed-01-run-20261126

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/miuoas47-gif/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/miuoas47-gif/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for make.fun's own makefun-diff 1.0.0: it returns exactly the
same patch for every pair of texts, but computes it faster.

`solve.js` exports `run(input)`, which takes `{ old, new }` (two texts) and returns
makefun-diff's patch as one string: a header line
`makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I`, then one hunk per
group of nearby changes, with `=` for kept lines, `-` for deleted lines and `+`
for inserted lines. The edit script is Myers's greedy search with makefun-diff's
own tie-break (a deletion wins when deletion and insertion reach the same point),
run over lines interned to integer ids in typed arrays, so the search compares
integers instead of strings and allocates no object per step; the script is then
recovered by walking the stored search rows backwards.

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## Run it

```sh
node main.ts
```

Node 22 or later, no dependencies to install. With the practice set in
`input/cases.json`, it writes the answers to `output/answers.json`. Outside a
container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input`
and `/output`.

Entered on [make.fun](https://make.fun/?ref=6gvkzysc&utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards
