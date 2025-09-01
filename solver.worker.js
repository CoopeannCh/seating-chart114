async function generateSeatingPlan() {
  const students = parseStudentData();
  const layoutType = document.getElementById('layout-type').value;

  if (layoutType === 'single_row') {
    const numRows = parseInt(document.getElementById('rows').value, 10);
    const numCols = parseInt(document.getElementById('cols').value, 10);
    if (isNaN(numRows) || isNaN(numCols) || numRows <= 0 || numCols <= 0) {
      setStatusMessage('請輸入有效的排數/列數。', 'error');
      return;
    }
    if (students.length > numRows * numCols) {
      setStatusMessage(`座位不足！學生人數(${students.length})超過座位總數(${numRows * numCols})。`, 'error');
      return;
    }
    const timeLimitSec = Math.max(1, Math.min(60, parseInt(document.getElementById('time-limit').value, 10) || 3));
    const heightConstraintEnabled = document.getElementById('height-constraint-enabled').checked;

    // 交給 Worker 求解
    startSingleRowSolveWithWorker({
      students,
      studentsWithHeightMap, // 由 parseStudentData() 產生
      constraints,
      numRows,
      numCols,
      timeLimitSec,
      heightConstraintEnabled
    });
    return;
  }

  // ===== group (維持你原本的同步算法) =====
  const numGroups = parseInt(document.getElementById('num-groups').value, 10);
  const groupSize = parseInt(document.getElementById('group-size').value, 10);
  if (isNaN(numGroups) || isNaN(groupSize) || numGroups <= 0 || groupSize <= 0) {
    setStatusMessage('請輸入有效的組數/每組座位數。', 'error');
    return;
  }
  if (students.length > numGroups * groupSize) {
    setStatusMessage(`座位不足！學生人數(${students.length})超過座位總數(${numGroups * groupSize})。`, 'error');
    return;
  }
  const planData = Array.from({ length: numGroups }, () => []);
  const shuffled = [...students].sort(() => Math.random() - 0.5);

  const solve = (idx) => {
    if (idx === shuffled.length) return true;
    const s = shuffled[idx];
    const order = Array.from({ length: numGroups }, (_, i) => i).sort((a, b) => planData[a].length - planData[b].length);
    for (const g of order) {
      if (planData[g].length < groupSize && isPlacementValid(s, g, null, planData, 'group')) {
        planData[g].push(s);
        if (solve(idx + 1)) return true;
        planData[g].pop();
      }
    }
    return false;
  };

  if (solve(0)) {
    currentSeatingPlan = { students, plan: planData, layout: 'group', numGroups, groupSize };
    setStatusMessage('座位表成功生成！', 'success');
    displaySeatingPlan(planData, numGroups, groupSize, 'group');
  } else {
    setStatusMessage('無法在限制條件下找到合適的座位安排。請調整限制或增加座位數。', 'error');
    displaySeatingPlan(null, numGroups, groupSize, 'group');
  }
}
