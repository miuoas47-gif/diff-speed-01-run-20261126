// A faster drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly the answer makefun-diff 1.0.0's diffPatch returns for
// the same input { old, new }: make.fun's own patch of the two texts, as one JSON
// string. The rule, as the house baseline's vendor/makefun-diff/index.js states it:
//
//   Lines. A text is cut after every "\n" (the only separator; a "\r" is part of its
//   line), and a last line with no "\n" is a line too. Two lines are equal only when
//   they are the same code units, newline or its absence included.
//
//   The edit script. The lines both texts share at their start are kept (the longest
//   common prefix), then the lines both share at their end, of the lines left (the
//   longest common suffix). Between them, Myers's greedy search runs from the first
//   lines: for d = 0, 1, 2, ... edits and each diagonal k = x - y from -d to d in
//   steps of 2, the furthest point a path of d edits reaches on k is either one old
//   line past the furthest (d-1)-point on diagonal k - 1 (a deletion) or one new line
//   past the furthest (d-1)-point on diagonal k + 1 (an insertion), whichever lies
//   further into the old text, and the deletion when both reach the same point; a
//   move past the end of either text is no candidate, no edge diagonal is pruned,
//   and from that point the path keeps every line equal in both texts as far as it
//   can. The first path to reach the ends of both texts is the edit script.
//
//   The patch. A first line "makefun-diff/1 old=<N> new=<M> hunks=<H> deleted=<D>
//   inserted=<I>", then each hunk: a line "@ <os> <ol> <ns> <nl>", and one line per
//   line it covers: "=" and the line if kept, "-" if deleted, "+" if inserted. Each
//   run of changes lists its deletions before its insertions and shows up to 3 kept
//   lines before and after it, and two runs at most 6 kept lines apart share a hunk.
//   A line that ends its text with no newline is written with one and followed by a
//   line "%". Identical texts are the first line alone.
//
// How this module is faster than makefun-diff 1.0.0 while returning the same answer:
//   - Every distinct line is interned once to a small integer id (a fresh Map per
//     case, so nothing is cached from one case to the next), and the whole search
//     compares integers in typed arrays instead of comparing strings line by line.
//     No line string is built to intern it: a line's id is its part's interned
//     base times two plus one when the line ends with "\n".
//   - The search keeps its furthest-reached x per (d, k) in one Int32Array per d,
//     with -1 for a diagonal no path reached, and no object is allocated per step:
//     makefun-diff builds a linked path object per edit and per kept run. The
//     deletion predecessor of one diagonal is the insertion predecessor of the
//     next, so each step reads one stored value and carries it on.
//   - The script is recovered by walking those stored rows backwards, choosing each
//     step's predecessor by the same rule the forward search used (deletion on a
//     tie), which rebuilds the very path the forward search found.
//   - The patch is written straight from the runs into one array of pieces, with
//     no line string built for it either.

/** The patch's first word. */
export const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
export const CONTEXT = 3;

/** The op of a kept, a deleted and an inserted line, as the patch writes them. */
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** Run kinds, as small integers while the script is built. */
const R_KEEP = 0;
const R_DELETE = 1;
const R_INSERT = 2;

/**
 * One text's lines: the parts between "\n"s, and the same lines as interned
 * integer ids, so two lines are equal exactly when their ids are equal. A line's
 * id is its part's interned base times two plus one when the line ends with "\n"
 * (every line but possibly the last does), so no line string is built here.
 */
function tokenize(text, intern) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const hasLast = parts[last] !== '';
  const n = last + (hasLast ? 1 : 0);
  const ids = new Int32Array(n);
  const map = intern.map;
  let next = intern.next;
  for (let i = 0; i < last; i++) {
    const part = parts[i];
    let base = map.get(part);
    if (base === undefined) {
      base = next++;
      map.set(part, base);
    }
    ids[i] = base * 2 + 1;
  }
  if (hasLast) {
    const part = parts[last];
    let base = map.get(part);
    if (base === undefined) {
      base = next++;
      map.set(part, base);
    }
    ids[last] = base * 2;
  }
  intern.next = next;
  return { parts, ids, n, hasLast };
}

/**
 * The edit script of the middle slices a (old lines) into b (new lines), as runs
 * [{ kind, count }] in order, by the rule in the header: the forward greedy search
 * with the deletion-preferred tie-break, then a backwards walk over the rows it
 * stored, which rebuilds the first path that reached both ends.
 */
function editRuns(a, b, n, m) {
  // The rows of furthest-reached x per d: rows[d][k + d] is the old lines consumed
  // after d edits and the snake on diagonal k, or -1 when no path reached k.
  const rows = [];
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[x] === b[y]) {
    x++;
    y++;
  }
  const row0 = new Int32Array(1);
  row0[0] = x;
  rows.push(row0);
  let dEnd = 0;
  let kEnd = 0;
  if (x < n || y < m) {
    outer: for (let d = 1; ; d++) {
      const row = new Int32Array(2 * d + 1);
      const prev = rows[d - 1];
      // k = -d: only the insertion from diagonal k + 1 = -d + 1 can reach it.
      // Its predecessor is prev[0], which is also the deletion predecessor of
      // the next diagonal, so it is carried forward from here.
      let xpDel = prev[0];
      {
        const k = -d;
        if (xpDel >= 0 && xpDel - (k + 1) < m) {
          let xx = xpDel;
          let yy = xx - k;
          while (xx < n && yy < m && a[xx] === b[yy]) {
            xx++;
            yy++;
          }
          row[0] = xx;
          // Only the diagonal k = n - m runs through both ends, so only it can
          // finish the search.
          if (k === n - m && xx >= n && yy >= m) {
            dEnd = d;
            kEnd = k;
            break outer;
          }
        } else {
          row[0] = -1;
        }
      }
      // Interior diagonals: the deletion predecessor of k + 2 is the insertion
      // predecessor of k, so each step reads one value and carries it on.
      for (let k = -d + 2; k <= d - 2; k += 2) {
        const xpIns = prev[k + d];
        // A deletion is a candidate only while an old line is left to delete; an
        // insertion only while a new line is left to insert. The deletion wins a
        // tie, exactly as the header's rule says.
        const delX = xpDel >= 0 && xpDel < n ? xpDel + 1 : -1;
        const insX = xpIns >= 0 && xpIns - (k + 1) < m ? xpIns : -1;
        if (delX < 0 && insX < 0) {
          row[k + d] = -1;
        } else {
          let xx;
          if (delX >= 0 && (insX < 0 || delX >= insX)) xx = delX;
          else xx = insX;
          let yy = xx - k;
          while (xx < n && yy < m && a[xx] === b[yy]) {
            xx++;
            yy++;
          }
          row[k + d] = xx;
          if (k === n - m && xx >= n && yy >= m) {
            dEnd = d;
            kEnd = k;
            break outer;
          }
        }
        xpDel = xpIns;
      }
      // k = d: only the deletion from diagonal k - 1 = d - 1 can reach it, and
      // its predecessor is the value carried out of the interior loop.
      {
        const k = d;
        if (xpDel >= 0 && xpDel < n) {
          let xx = xpDel + 1;
          let yy = xx - k;
          while (xx < n && yy < m && a[xx] === b[yy]) {
            xx++;
            yy++;
          }
          row[2 * d] = xx;
          if (k === n - m && xx >= n && yy >= m) {
            dEnd = d;
            kEnd = k;
            break outer;
          }
        } else {
          row[2 * d] = -1;
        }
      }
      rows.push(row);
    }
  }

  // Walk the winning path backwards. Each step re-derives, from the stored rows,
  // the move the forward search took at (d, k) and the snake that followed it, and
  // records them as run segments in reverse order, merging neighbours of one kind.
  const segs = [];
  const pushSeg = (kind, count) => {
    if (count <= 0) return;
    const last = segs[segs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else segs.push({ kind, count });
  };
  let xx = n;
  let k = kEnd;
  for (let d = dEnd; d >= 1; d--) {
    const prev = rows[d - 1];
    const xpDel = prev[k + d - 2];
    const xpIns = prev[k + d];
    const delX = xpDel >= 0 && xpDel < n ? xpDel + 1 : -1;
    const insX = xpIns >= 0 && xpIns - (k + 1) < m ? xpIns : -1;
    let xPrime;
    let kind;
    if (delX >= 0 && (insX < 0 || delX >= insX)) {
      xPrime = delX;
      kind = R_DELETE;
    } else {
      xPrime = insX;
      kind = R_INSERT;
    }
    pushSeg(R_KEEP, xx - xPrime);
    pushSeg(kind, 1);
    // The next step walks the predecessor's own post-snake point: for a deletion
    // that is (xpDel, xpDel - (k - 1)), one old line short of the move's point,
    // and for an insertion (xpIns, xpIns - (k + 1)), the move's point itself.
    xx = kind === R_DELETE ? xpDel : xpIns;
    k = kind === R_DELETE ? k - 1 : k + 1;
  }
  // The d = 0 snake, from the first lines to where the first edit starts.
  pushSeg(R_KEEP, xx);
  segs.reverse();
  return segs;
}

/**
 * A line as the patch writes it: its op, the line's part, a newline, and "%" on a
 * line of its own when the line had none. The pieces go into `out` unjoined, so no
 * line string is built.
 */
function written(out, op, parts, i, lastBare, n) {
  out.push(op, parts[i]);
  if (i === n - 1 && lastBare) out.push('\n%\n');
  else out.push('\n');
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  // Fresh interning per case: nothing is carried from one case to the next.
  const intern = { map: new Map(), next: 0 };
  const oldT = tokenize(input.old, intern);
  const newT = tokenize(input.new, intern);
  const a = oldT.ids;
  const b = newT.ids;
  const n = oldT.n;
  const m = newT.n;
  const aParts = oldT.parts;
  const bParts = newT.parts;
  const aLastBare = oldT.hasLast;
  const bLastBare = newT.hasLast;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: R_KEEP, count: prefix });
  runs.push(...editRuns(a.subarray(prefix, n - suffix), b.subarray(prefix, m - suffix), n - prefix - suffix, m - prefix - suffix));
  if (suffix > 0) runs.push({ kind: R_KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === R_KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.at(-1);
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === R_DELETE) {
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
    const h = hunks.at(-1);
    const prev = h?.at(-1);
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h.at(-1);
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) written(out, KEEP, aParts, at, aLastBare, n);
      for (let i = 0; i < c.dels; i++) written(out, DELETE, aParts, c.o + i, aLastBare, n);
      for (let i = 0; i < c.ins; i++) written(out, INSERT, bParts, c.p + i, bLastBare, m);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) written(out, KEEP, aParts, at, aLastBare, n);
  }
  return out.join('');
}
