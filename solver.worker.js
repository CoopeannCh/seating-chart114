// solver.worker.js  (module)

let aborted = false;

self.onmessage = async (ev) => {
  const { type, payload } = ev.data || {};
  if (type === 'cancel') { aborted = true; return; }
  if (type !== 'start') return;

  aborted = false;

  try {
    const {
      students = [],
      studentsWithHeightMap = {},
      constraints = [],
      numRows,
      numCols,
      timeLimitSec = 3,
      heightConstraintEnabled = false,
      seed = Date.now()
    } = payload;

    // 基本檢查
    if (!Array.isArray(students) || !Number.isInteger(numRows) || !Number.isInteger(numCols)) {
      postResult({ ok: false, reason: 'error', message: '參數錯誤（students/numRows/numCols）' });
      return;
    }

    // === 0) 零限制快速通道（沒有任何限制，且沒啟用身高檢查） ===
    if ((!constraints || constraints.length === 0) && !heightConstraintEnabled) {
      const plan = makeEmptyPlan(numRows, numCols);
      const rng = mulberry32(hash32(seed));
      const shuffled = [...students].sort(() => rng() - 0.5);
      // 用座位順序：先填滿前 R-1 排；最後才使用最後一排 → 空位只在最後一排
      const order = buildSeatOrder(numRows, numCols, shuffled.length);
      let i = 0;
      for (const { r, c } of order) {
        plan[r][c] = shuffled[i++];
        if (i >= shuffled.length) break;
      }
      postResult({ ok: true, plan, numRows, numCols });
      return;
    }

    // === 1) 早期可行性檢查 ===
    const infeasibleMsg = precheckFeasibility(students, constraints, numRows, numCols);
    if (infeasibleMsg) {
      postResult({ ok: false, reason: 'infeasible', message: `無法生成：${infeasibleMsg}` });
      return;
    }

    // === 2) 建立空白表 + 求解準備 ===
    const plan = makeEmptyPlan(numRows, numCols);

    // 只指派前 N 席位（確保空位只留在最後一排）
    const N = students.length;
    const seatOrder = buildSeatOrder(numRows, numCols, N);

    // 隨機學生順序（可重現）
    const rng = mulberry32(hash32(seed));
    const shuffled = [...students].sort(() => rng() - 0.5);

    const used = new Set();
    const helpers = makeHelpers(constraints, studentsWithHeightMap, numRows, numCols, heightConstraintEnabled);
    const deadline = performance.now() + Math.max(1, Math.min(60, timeLimitSec)) * 1000;

    let steps = 0;
    async function solve(idx) {
      if (aborted) return 'aborted';
      if (performance.now() > deadline) return 'timeout';
      if (idx === seatOrder.length) return true;

      steps++;
      if (steps % 400 === 0) {
        self.postMessage({ type: 'progress', payload: { placed: idx, total: seatOrder.length } });
        // 讓出執行緒一瞬間（避免 WebView / 低階裝置卡頓）
        await new Promise(r => setTimeout(r, 0));
      }

      const { r, c } = seatOrder[idx];

      // 依座位的 row/col 範圍先過濾可能人選（大幅減枝）
      const candidates = [];
      for (const s of shuffled) {
        if (used.has(s)) continue;
        if (!withinRange(helpers.getRowRange(s), r + 1)) continue;
        if (!withinRange(helpers.getColRange(s), c + 1)) continue;
        candidates.push(s);
      }

      // 啟發式：優先嘗試 domain 較窄的人
      candidates.sort((a, b) => helpers.domainWidth(a) - helpers.domainWidth(b));

      for (const s of candidates) {
        plan[r][c] = s;
        if (helpers.isPlacementValid(s, r, c, plan)) {
          used.add(s);
          const res = await solve(idx + 1);
          if (res === true || res === 'timeout' || res === 'aborted') return res;
          used.delete(s);
        }
        plan[r][c] = null;
      }
      return false;
    }

    const res = await solve(0);

    if (res === true) {
      postResult({ ok: true, plan, numRows, numCols });
    } else if (res === 'timeout') {
      postResult({ ok: false, reason: 'timeout', message: '超過時間上限，未找到解。' });
    } else if (res === 'aborted') {
      postResult({ ok: false, reason: 'aborted', message: '已停止。' });
    } else {
      postResult({ ok: false, reason: 'no_solution', message: '在限制條件下找不到解，請放寬限制或增加座位。' });
    }
  } catch (e) {
    postResult({ ok: false, reason: 'error', message: e?.message || String(e) });
  }
};

// ====== Helpers ======

function postResult(result) {
  self.postMessage({ type: 'result', payload: result });
}

function makeEmptyPlan(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(null));
}

// 產生座位順序：先 0..rows-2 的所有列，再最後一列；最後只取前 N 個
function buildSeatOrder(numRows, numCols, N) {
  const order = [];
  // 先排除最後一排
  for (let r = 0; r < Math.max(0, numRows - 1); r++) {
    for (let c = 0; c < numCols; c++) order.push({ r, c });
  }
  // 最後才放入最底下一排
  if (numRows > 0) {
    const last = numRows - 1;
    for (let c = 0; c < numCols; c++) order.push({ r: last, c });
  }
  return order.slice(0, N);
}

function withinRange([s, e], val) {
  return val >= s && val <= e;
}

function makeHelpers(constraints, heightMap, numRows, numCols, heightOn) {
  const rowsMap = {}; // name -> [startRow,endRow] (1-based)
  const colsMap = {}; // name -> [startCol,endCol] (1-based)

  for (const cons of constraints) {
    if (cons.type === 'preferred_rows') {
      const [s, e] = String(cons.students[1]).split('-').map(Number);
      rowsMap[cons.students[0]] = [s, e];
    }
    if (cons.type === 'preferred_cols') {
      const [s, e] = String(cons.students[1]).split('-').map(Number);
      colsMap[cons.students[0]] = [s, e];
    }
  }

  const getRowRange = (name) => rowsMap[name] ?? [1, numRows];
  const getColRange = (name) => colsMap[name] ?? [1, numCols];

  function isPlacementValid(student, r, c, grid) {
    // 身高限制：後排不可比前排高（兩者都有數字才比）
    if (heightOn && r > 0) {
      const front = grid[r - 1][c];
      if (front) {
        const curH = heightMap[student];
        const frontH = heightMap[front];
        if (typeof curH === 'number' && typeof frontH === 'number') {
          if (curH > frontH) return false;
        }
      }
    }

    // 不相鄰（含斜對角）
    for (let rr = Math.max(0, r - 1); rr <= Math.min(grid.length - 1, r + 1); rr++) {
      for (let cc = Math.max(0, c - 1); cc <= Math.min(grid[0].length - 1, c + 1); cc++) {
        const other = grid[rr][cc];
        if (!other) continue;
        if (rr === r && cc === c) continue;
        const bad = constraints.find(cons =>
          cons.type === 'not_adjacent' &&
          ((cons.students[0] === student && cons.students[1] === other) ||
           (cons.students[1] === student && cons.students[0] === other))
        );
        if (bad) return false;
      }
    }

    // 指定排/列（1-based）
    const row1 = r + 1, col1 = c + 1;
    const [rs, re] = getRowRange(student);
    if (row1 < rs || row1 > re) return false;
    const [cs, ce] = getColRange(student);
    if (col1 < cs || col1 > ce) return false;

    return true;
  }

  const domainWidth = (name) => {
    const [rs, re] = getRowRange(name);
    const [cs, ce] = getColRange(name);
    return (re - rs) + (ce - cs);
  };

  return { getRowRange, getColRange, isPlacementValid, domainWidth };
}

function precheckFeasibility(students, constraints, numRows, numCols) {
  const rowsMap = {};
  const colsMap = {};
  for (const cons of constraints) {
    if (cons.type === 'preferred_rows') {
      const [s, e] = String(cons.students[1]).split('-').map(Number);
      rowsMap[cons.students[0]] = [s, e];
    }
    if (cons.type === 'preferred_cols') {
      const [s, e] = String(cons.students[1]).split('-').map(Number);
      colsMap[cons.students[0]] = [s, e];
    }
  }
  for (const name of students) {
    const [rs = 1, re = numRows] = rowsMap[name] || [1, numRows];
    const [cs = 1, ce = numCols] = colsMap[name] || [1, numCols];
    if (rs > re || cs > ce) return `${name} 的排/列限制無效（沒有任何可坐位置）。`;
    if (rs < 1 || re > numRows || cs < 1 || ce > numCols) return `${name} 的排/列限制超出教室範圍。`;
  }
  return null;
}

// ---- Tiny PRNG（為了隨機但可重現）----
function hash32(x) {
  x = (x ^ 0xDEADBEEF) >>> 0;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  return x >>> 0;
}
function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
