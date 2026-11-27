// solve.js — a faster drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly the answer makefun-diff 1.0.0 returns for
// the same { old, new }: the same lines, the same Myers search with
// make.fun's tie-break (a deletion wins when it reaches as far as an
// insertion), the same hunks with 3 lines of context around each change
// run. It is faster by interning each distinct line to an integer once
// and then running Myers over integers in typed arrays, keeping only
// the furthest point per diagonal per depth and walking the trace
// back, instead of a heap of path objects with a linked list each.
//
// The entrypoint (main.ts) calls run(input) once per case and writes
// the answers; this module holds no state between calls.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

// The op of a kept, a deleted and an inserted line, as the patch writes them.
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * A text's lines, each with its "\n" (the last one without, when the
 * text does not end in one). The empty text has no lines; "\n" has one,
 * an empty line.
 */
function tokenize(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const cut = text.indexOf('\n', start);
    if (cut === -1) {
      if (start < text.length) lines.push(text.slice(start));
      return lines;
    }
    lines.push(text.slice(start, cut + 1));
    start = cut + 1;
  }
}

/**
 * The runs of the edit script of the middle slices, [{ kind, count }],
 * in order: the common prefix and suffix are already taken off, so this
 * runs Myers's greedy search from the first lines left, following the
 * same rule makefun-diff states (the furthest point per diagonal, the
 * deletion on a tie, no pruning of edge diagonals, every run of equal
 * lines followed as far as it goes) and walking the trace back.
 */
function editRuns(a, aOff, n, b, bOff, m) {
  // The trace: the furthest old lines consumed on each diagonal, per
  // depth. Depth d's row lives at trace[d*d .. d*d + 2*d]; diagonal k
  // sits at trace[d*d + k + d]. A row holds -1 where no path reached.
  // The previous row's base is (d-1)*d, so diagonal k's two candidates
  // sit at prevBase + k - 1 (a deletion) and prevBase + k + 1 (an
  // insertion); the loop walks all three indices two at a time.
  let cap = 256;
  let trace = new Int32Array((cap + 1) * (cap + 1));
  const ensure = (d) => {
    if (d <= cap) return;
    let next = cap;
    while (d > next) next = next * 2 + 1;
    const grown = new Int32Array((next + 1) * (next + 1));
    grown.set(trace);
    trace = grown;
    cap = next;
  };

  // The middle slices as views, so the search indexes them directly.
  const av = a.subarray(aOff, aOff + n);
  const bv = b.subarray(bOff, bOff + m);

  // Depth 0: the common lines from the start.
  let x = 0;
  while (x < n && x < m && av[x] === bv[x]) x++;
  trace[0] = x;
  let dFinal = -1;
  if (x >= n && x >= m) dFinal = 0;

  for (let d = 1; dFinal < 0; d++) {
    ensure(d);
    const base = d * d;
    const prevBase = (d - 1) * d;
    // Diagonal k = -d takes an insertion only, from diagonal -d+1.
    {
      const v = trace[prevBase - d + 1];
      let xx = -1;
      if (v >= 0 && v + d - 1 < m) xx = v;
      if (xx >= 0) {
        let yy = xx + d;
        while (xx < n && yy < m && av[xx] === bv[yy]) {
          xx++;
          yy++;
        }
        trace[base] = xx;
        if (xx >= n && yy >= m) {
          dFinal = d;
          break;
        }
      } else trace[base] = -1;
    }
    // The middle diagonals take a deletion or an insertion, whichever
    // lies further into the old text, and the deletion when both reach
    // one point: make.fun's tie-break.
    let w = base + 2;
    let rd = prevBase - d + 1;
    let ri = prevBase - d + 3;
    for (let k = -d + 2; k <= d - 2; k += 2, w += 2, rd += 2, ri += 2) {
      const vd = trace[rd];
      const vi = trace[ri];
      const xDel = vd >= 0 && vd < n ? vd + 1 : -1;
      const xIns = vi >= 0 && vi - (k + 1) < m ? vi : -1;
      if (xDel < 0 && xIns < 0) {
        trace[w] = -1;
        continue;
      }
      let xx = xDel >= xIns ? xDel : xIns;
      let yy = xx - k;
      while (xx < n && yy < m && av[xx] === bv[yy]) {
        xx++;
        yy++;
      }
      trace[w] = xx;
      if (xx >= n && yy >= m) {
        dFinal = d;
        break;
      }
    }
    if (dFinal >= 0) break;
    // Diagonal k = d takes a deletion only, from diagonal d-1.
    {
      const v = trace[prevBase + d - 1];
      let xx = -1;
      if (v >= 0 && v < n) xx = v + 1;
      if (xx >= 0) {
        let yy = xx - d;
        while (xx < n && yy < m && av[xx] === bv[yy]) {
          xx++;
          yy++;
        }
        trace[base + 2 * d] = xx;
        if (xx >= n && yy >= m) dFinal = d;
      } else trace[base + 2 * d] = -1;
    }
  }

  // Walk the trace back from (n, m), collecting the ops in reverse.
  // The point after each round's edit is read off the previous row,
  // so no walk mistakes a kept line for an edited one.
  const ops = [];
  let xx = n;
  let yy = m;
  let k = n - m;
  for (let d = dFinal; d >= 1; d--) {
    const prev = (d - 1) * (d - 1);
    const vDelRaw = k > -d ? trace[prev + (k - 1) + (d - 1)] : -1;
    const vInsRaw = k < d ? trace[prev + (k + 1) + (d - 1)] : -1;
    const xDel = vDelRaw >= 0 && vDelRaw < n ? vDelRaw + 1 : -1;
    const xIns = vInsRaw >= 0 && vInsRaw - (k + 1) < m ? vInsRaw : -1;
    if (xDel < 0 && xIns < 0) throw new Error('makefun-diff: the trace ends without a path');
    const isDel = xDel >= xIns;
    const xAfterEdit = isDel ? xDel : xIns;
    const snake = xx - xAfterEdit;
    if (snake < 0) throw new Error('makefun-diff: the trace disagrees with itself');
    for (let i = 0; i < snake; i++) ops.push(KEEP);
    if (isDel) {
      ops.push(DELETE);
      yy = xAfterEdit - k;
      xx = xAfterEdit - 1;
      k = k - 1;
    } else {
      ops.push(INSERT);
      yy = xAfterEdit - k - 1;
      xx = xAfterEdit;
      k = k + 1;
    }
  }
  // Depth 0's common lines from the start.
  for (let i = 0; i < xx; i++) ops.push(KEEP);

  // Reverse the ops into runs of one kind.
  const runs = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const kind = ops[i];
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last.kind === kind) last.count++;
    else runs.push({ kind, count: 1 });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function pushLine(out, op, line) {
  if (line.charCodeAt(line.length - 1) === 10) out.push(op + line);
  else out.push(op + line + '\n%\n');
}

/** make.fun's own patch of input.old into input.new (the header). */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;

  // Intern each distinct line to an integer once, so every comparison
  // Myers makes is an integer comparison, not a string one.
  const ids = new Map();
  const aIds = new Int32Array(n);
  const bIds = new Int32Array(m);
  let nextId = 0;
  for (let i = 0; i < n; i++) {
    let id = ids.get(a[i]);
    if (id === undefined) {
      id = nextId++;
      ids.set(a[i], id);
    }
    aIds[i] = id;
  }
  for (let i = 0; i < m; i++) {
    let id = ids.get(b[i]);
    if (id === undefined) {
      id = nextId++;
      ids.set(b[i], id);
    }
    bIds[i] = id;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...editRuns(aIds, prefix, n - prefix - suffix, bIds, prefix, m - prefix - suffix));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) pushLine(out, '=', a[at]);
      for (let i = 0; i < c.dels; i++) pushLine(out, '-', a[c.o + i]);
      for (let i = 0; i < c.ins; i++) pushLine(out, '+', b[c.p + i]);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) pushLine(out, '=', a[at]);
  }
  return out.join('');
}
