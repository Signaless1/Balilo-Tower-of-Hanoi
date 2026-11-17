'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const COLORS = [
  '#46e1ff', '#5798ff', '#8f72ff', '#bc68ec', '#ff55c5',
  '#ff668c', '#ff9b5d', '#ffcf65', '#a8e66b', '#52dfb4'
];
const FRIENDLY_ERRORS = {
  invalid_tower: 'That tower does not exist.',
  same_tower: 'Choose a different destination tower.',
  move_limit: 'You have reached the move limit.',
  empty_source: 'There is no disk on that tower to move.',
  tower_locked: 'One of those towers is currently locked.',
  route_closed: 'There is no open route between those towers.',
  key_locked: 'A key disk must be moved before this tower can be used.',
  larger_on_smaller: 'A larger disk cannot be placed on a smaller disk.',
  restricted: 'That move is not allowed by this puzzle.'
};

let engineOnline = false;

const state = {
  view: 'home', mode: 'classic', rules: null, pos: [], initialPos: [],
  moves: 0, selected: null, legal: [], hintMove: null,
  history: [], redo: [], moveLog: [], startedAt: null, elapsed: 0,
  timerId: null, optimal: null, timeLimit: 0, timeLeft: 0, busy: false,
  hints: 0, mistakes: 0, assisted: false, solving: false,
  historyVisible: false, toastTimer: null, hintTimer: null, finished: false,
  dragPointer: null, dragSource: null, suppressNextClick: false, musicOn: false, soundOn: true, audioContext: null, musicTimer: null, musicGain: null, sfxGain: null, musicPad: null, musicStep: 0
};

async function api(op, payload = {}) {
  const response = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Server error (${response.status})`);
  return data;
}

function showView(name) {
  state.view = name;
  for (const view of ['home', 'setup', 'game', 'how']) $(`#${view}View`).classList.toggle('hidden', view !== name);
  $('#winOverlay').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toast(message, kind = 'error') {
  const el = $('#toast');
  el.textContent = message;
  el.style.borderColor = kind === 'success' ? 'rgba(89,230,160,.4)' : 'rgba(255,100,124,.4)';
  el.style.color = kind === 'success' ? '#b7ffda' : '#ffc2ce';
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function updateEngineStatus(online, message) {
  engineOnline = online;
  const el = $('.engine-status');
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
  $('#engineStatus').textContent = message;
  $('#startButton').disabled = !online;
  $('#launchButton').disabled = !online;
}

async function checkEngine({ quiet = false } = {}) {
  try {
    await api('ping');
    updateEngineStatus(true, 'PROLOG ENGINE ONLINE');
  } catch (error) {
    const detail = error?.message || 'Unable to reach /api';
    updateEngineStatus(false, 'PROLOG ENGINE OFFLINE');
    if (!quiet) toast(`Prolog server unavailable: ${detail}. Check the run.bat window.`);
  }
}

function selectedMode() { return state.mode; }
function maxDiskCount() { return selectedMode() === 'infinity' ? 6 : selectedMode() === 'timeattack' ? 8 : 10; }

function setMode(mode) {
  state.mode = mode;
  $$('.mode-option').forEach((button) => button.classList.toggle('selected', button.dataset.mode === mode));
  const infinity = mode === 'infinity';
  $('#towerConfig').classList.toggle('hidden', !infinity);
  $('#sourceConfig').classList.toggle('hidden', infinity);
  $('#diskCount').max = String(maxDiskCount());
  if (Number($('#diskCount').value) > maxDiskCount()) $('#diskCount').value = String(maxDiskCount());
  updateDiskOutput();
  const note = {
    classic: 'The classic 3-tower puzzle has a proven minimum of <b>2ⁿ − 1</b> moves.',
    zen: 'No clock pressure. Explore the puzzle and use free hints whenever you need them.',
    infinity: 'Choose 4–6 towers and a route network. The Prolog solver searches the legal state space for an optimal path.',
    timeattack: 'Race the clock. Your time limit is based on the optimal solution length.'
  }[mode];
  $('#setupNote').innerHTML = note;
}

function updateDiskOutput() {
  const count = Number($('#diskCount').value);
  $('#diskOutput').textContent = `${count} DISKS`;
}

function closedRoutes(towers, topology) {
  const closed = [];
  for (let a = 0; a < towers; a++) {
    for (let b = a + 1; b < towers; b++) {
      let keep = true;
      if (topology === 'line') keep = b - a === 1;
      if (topology === 'ring') keep = (b - a === 1) || (a === 0 && b === towers - 1);
      if (topology === 'star') keep = a === 0;
      if (!keep) closed.push([a, b]);
    }
  }
  return closed;
}

function makeSetup() {
  const numDisks = Number($('#diskCount').value);
  const infinity = selectedMode() === 'infinity';
  const numTowers = infinity ? Number($('#towerCount').value) : 3;
  const source = infinity ? 0 : Number($('#sourceTower').value);
  const goal = infinity ? numTowers - 1 : Number($('#goalTower').value);
  if (source === goal) throw new Error('The start and goal towers must be different.');
  const initial_positions = Array(numDisks).fill(source);
  const target_positions = Array(numDisks).fill(goal);
  return {
    num_towers: numTowers,
    num_disks: numDisks,
    initial_positions,
    target_positions,
    closed_routes: infinity ? closedRoutes(numTowers, $('#topology').value) : [],
    restrictions: [],
    move_limit: -1
  };
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const secs = (safe % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
}

function startClock() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    if (!state.startedAt || state.finished) return;
    state.elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    if (state.mode === 'timeattack') {
      state.timeLeft = Math.max(0, state.timeLimit - state.elapsed);
      $('#timerValue').textContent = formatTime(state.timeLeft);
      if (state.timeLeft <= 0 && !state.finished) {
        state.solving = false;
        toast('Time is up. Restart the puzzle to try again.');
        $('#boardStatus').textContent = 'TIME EXPIRED';
        $('#boardHelp').textContent = 'The clock has run out. Restart to attempt the puzzle again.';
      }
    } else {
      $('#timerValue').textContent = formatTime(state.elapsed);
    }
  }, 250);
}

async function launchGame() {
  try {
    const rules = makeSetup();
    const validation = await api('validate_rules', rules);
    if (!validation.valid) throw new Error('The selected puzzle configuration is invalid.');
    state.rules = rules;
    state.pos = [...rules.initial_positions];
    state.initialPos = [...rules.initial_positions];
    state.moves = 0;
    state.selected = null;
    state.legal = [];
    state.hintMove = null;
    state.history = [];
    state.redo = [];
    state.moveLog = [];
    state.startedAt = null;
    state.elapsed = 0;
    state.optimal = null;
    state.hints = 0;
    state.mistakes = 0;
    state.assisted = false;
    state.solving = false;
    state.finished = false;
    state.historyVisible = false;
    $('#historyPanel').classList.add('hidden');
    $('#historyList').innerHTML = '';
    $('#gameModeLabel').textContent = `${state.mode.toUpperCase()} MODE`;
    $('#timerValue').textContent = '00:00';
    $('#moveCount').textContent = '0';
    $('#optimalValue').textContent = '…';
    $('#boardDiskLabel').textContent = `${rules.num_disks} DISKS · ${rules.num_towers} TOWERS`;
    $('#goalTowerName').textContent = `Tower ${String(rules.target_positions[0] + 1).padStart(2, '0')}`;
    $('#boardStatus').textContent = 'PUZZLE IN PROGRESS';
    $('#boardHelp').textContent = 'Drag a top disk to another tower, or tap two towers to move.';
    state.timeLimit = 0;
    state.timeLeft = 0;
    if (state.timerId) clearInterval(state.timerId);
    renderBoard();
    updateControls();
    showView('game');
    try {
      const result = await api('solver_distance', { ...rules, pos: state.pos });
      state.optimal = Number(result.distance);
      $('#optimalValue').textContent = state.optimal >= 0 ? String(state.optimal) : 'N/A';
    } catch (error) {
      state.optimal = null;
      $('#optimalValue').textContent = 'N/A';
    }
    if (state.mode === 'timeattack') {
      const reference = state.optimal > 0 ? state.optimal : Math.pow(2, rules.num_disks) - 1;
      state.timeLimit = Math.max(45, reference * 4 + 15);
      state.timeLeft = state.timeLimit;
      $('#timerValue').textContent = formatTime(state.timeLeft);
    }
    updateBoardProgress();
  } catch (error) {
    toast(error.message || 'Could not start the puzzle.');
  }
}

function disksOnTower(tower) {
  return state.pos.map((position, index) => ({ disk: index + 1, tower: position }))
    .filter((entry) => entry.tower === tower)
    .sort((a, b) => a.disk - b.disk);
}

function diskWidth(disk, total) {
  if (total <= 1) return 78;
  return 34 + ((disk - 1) / (total - 1)) * 62;
}

function renderBoard() {
  if (!state.rules) return;
  const board = $('#board');
  board.style.setProperty('--tower-count', state.rules.num_towers);
  board.innerHTML = '';
  for (let tower = 0; tower < state.rules.num_towers; tower++) {
    const towerEl = document.createElement('div');
    towerEl.className = 'tower';
    towerEl.dataset.tower = String(tower);
    towerEl.tabIndex = 0;
    towerEl.setAttribute('role', 'button');
    towerEl.setAttribute('aria-label', `Tower ${tower + 1}, ${disksOnTower(tower).length} disks`);
    if (state.selected === tower) towerEl.classList.add('selected');
    if (state.selected !== null && state.legal.some(([src, dst]) => src === state.selected && dst === tower)) towerEl.classList.add('legal');
    if (state.hintMove && state.hintMove[0] === tower) towerEl.classList.add('hint-source');
    if (state.hintMove && state.hintMove[1] === tower) towerEl.classList.add('hint-destination');

    const stack = document.createElement('div');
    stack.className = 'disk-stack';
    const towerDisks = disksOnTower(tower);
    for (const { disk } of towerDisks) {
      const diskEl = document.createElement('div');
      diskEl.className = 'disk';
      const isTopDisk = disk === towerDisks[0]?.disk;
      if (isTopDisk) {
        diskEl.classList.add('top-disk');
        diskEl.draggable = true;
        diskEl.setAttribute('role', 'button');
        diskEl.setAttribute('aria-label', `Drag disk ${disk} from tower ${tower + 1}`);
        diskEl.addEventListener('dragstart', (event) => {
          if (state.finished || state.solving || state.busy) { event.preventDefault(); return; }
          ensureAudioEngine();
          playSfx('pickup');
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(tower));
          state.dragSource = tower;
          state.selected = tower;
          diskEl.classList.add('is-dragging');
          towerEl.classList.add('drag-source');
        });
        diskEl.addEventListener('dragend', () => {
          $$('.tower').forEach((el) => el.classList.remove('drag-over', 'drag-source'));
          $$('.disk').forEach((el) => el.classList.remove('is-dragging'));
          const source = state.dragSource;
          state.dragSource = null;
          if (source !== undefined && source !== null && state.selected === source && !state.busy) {
            selectTower(source);
          }
        });
        // Touch and stylus dragging, since native HTML drag-and-drop is inconsistent on phones.
        diskEl.addEventListener('pointerdown', (event) => {
          if ((event.pointerType === 'touch' || event.pointerType === 'pen') && !state.finished && !state.solving && !state.busy) {
            ensureAudioEngine();
            playSfx('pickup');
            state.dragPointer = { source: tower, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
            diskEl.classList.add('touch-dragging');
          }
        });
      }
      if (state.hintMove && state.hintMove[0] === tower && isTopDisk) diskEl.classList.add('disk-halo');
      diskEl.style.width = `${diskWidth(disk, state.rules.num_disks)}%`;
      diskEl.style.background = `linear-gradient(100deg,${COLORS[(disk - 1) % COLORS.length]},${COLORS[(disk - 1) % COLORS.length]}bb)`;
      diskEl.style.setProperty('--disk-color', COLORS[(disk - 1) % COLORS.length]);
      diskEl.textContent = String(disk).padStart(2, '0');
      stack.appendChild(diskEl);
    }
    const pole = document.createElement('div'); pole.className = 'tower-pole';
    const base = document.createElement('div'); base.className = 'tower-base';
    const label = document.createElement('div'); label.className = 'tower-label'; label.textContent = `TOWER ${String(tower + 1).padStart(2, '0')}`;
    towerEl.append(stack, pole, base, label);
    towerEl.addEventListener('click', () => {
      if (state.suppressNextClick) { state.suppressNextClick = false; return; }
      handleTowerClick(tower);
    });
    towerEl.addEventListener('dragenter', (event) => {
      if (state.dragSource !== undefined && state.dragSource !== null) {
        event.preventDefault();
        towerEl.classList.add('drag-over');
      }
    });
    towerEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      towerEl.classList.add('drag-over');
    });
    towerEl.addEventListener('dragleave', (event) => {
      if (!towerEl.contains(event.relatedTarget)) towerEl.classList.remove('drag-over');
    });
    towerEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      towerEl.classList.remove('drag-over');
      const rawSource = event.dataTransfer.getData('text/plain');
      const source = Number(rawSource);
      if (rawSource !== '' && Number.isInteger(source) && source >= 0 && source < state.rules.num_towers && source !== tower) {
        await commitMove(source, tower, false);
      }
    });
    towerEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleTowerClick(tower); }
    });
    board.appendChild(towerEl);
  }
  updateBoardProgress();
}

// Finish touch/stylus drag when the pointer is released over a different tower.
document.addEventListener('pointerup', async (event) => {
  const drag = state.dragPointer;
  if (!drag || drag.pointerId !== event.pointerId) return;
  state.dragPointer = null;
  $$('.disk').forEach((el) => el.classList.remove('touch-dragging'));
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tower');
  const destination = target ? Number(target.dataset.tower) : drag.source;
  const movedDistance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (destination !== drag.source && movedDistance > 12) {
    state.suppressNextClick = true;
    window.setTimeout(() => { state.suppressNextClick = false; }, 400);
    await commitMove(drag.source, destination, false);
  }
});

document.addEventListener('pointercancel', () => {
  state.dragPointer = null;
  $$('.disk').forEach((el) => el.classList.remove('touch-dragging'));
});

function updateBoardProgress() {
  if (!state.rules) return;
  const goal = state.rules.target_positions[0];
  const count = state.pos.filter((tower) => tower === goal).length;
  $('#goalProgressText').textContent = `${count} / ${state.rules.num_disks}`;
  $('#goalProgressBar').style.width = `${(count / state.rules.num_disks) * 100}%`;
}

async function selectTower(tower) {
  state.selected = tower;
  const requestedPosition = [...state.pos];
  state.legal = [];
  renderBoard();
  const payload = {
    ...state.rules, pos: state.pos, moves_used: state.moves,
    teleport: 0, locked: [], dynamic_closed: []
  };
  try {
    const result = await api('legal_moves', payload);
    if (state.selected === tower && requestedPosition.every((value, index) => state.pos[index] === value)) {
      state.legal = result.moves || [];
      renderBoard();
    }
  } catch (error) {
    state.legal = [];
  }
}

async function handleTowerClick(tower) {
  if (!state.rules || state.finished || state.solving || state.busy) return;
  if (state.mode === 'timeattack' && state.startedAt && state.timeLeft <= 0) return;
  ensureAudioEngine();
  if (state.selected === null) {
    const sourceDisks = disksOnTower(tower);
    if (!sourceDisks.length) { setFeedback('That tower is empty.', 'error'); return; }
    playSfx('pickup');
    await selectTower(tower);
    setFeedback(`Tower ${tower + 1} selected. Choose a destination.`, '');
    return;
  }
  if (state.selected === tower) {
    state.selected = null; state.legal = []; renderBoard();
    setFeedback('Selection cleared.', '');
    return;
  }
  await commitMove(state.selected, tower, false);
}

function setFeedback(message, kind = '') {
  const el = $('#moveFeedback');
  el.textContent = message;
  el.className = `move-feedback ${kind}`.trim();
}

// Animate a disk as a floating layer so its travel remains visible while the
// Prolog-validated board state is still unchanged underneath it.
async function animateDiskMove(src, dst, { automatic = false } = {}) {
  const sourceTower = document.querySelector(`.tower[data-tower="${src}"]`);
  const targetTower = document.querySelector(`.tower[data-tower="${dst}"]`);
  const disk = sourceTower?.querySelector('.top-disk');
  if (!sourceTower || !targetTower || !disk) return;

  const from = disk.getBoundingClientRect();
  const targetTopDisk = targetTower.querySelector('.top-disk');
  const targetBase = targetTower.querySelector('.tower-base');
  const targetTop = targetTopDisk
    ? targetTopDisk.getBoundingClientRect().top - from.height + 1
    : (targetBase?.getBoundingClientRect().top ?? targetTower.getBoundingClientRect().bottom - 38) - from.height + 1;
  const targetRect = targetTower.getBoundingClientRect();
  const targetLeft = targetRect.left + (targetRect.width - from.width) / 2;
  const dx = targetLeft - from.left;
  const dy = targetTop - from.top;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  sourceTower.classList.add('lifted-from');
  targetTower.classList.add('landing-target');
  disk.classList.add('in-transit');
  playSfx('whoosh');

  const flyer = disk.cloneNode(true);
  flyer.classList.remove('top-disk', 'in-transit', 'is-dragging', 'touch-dragging', 'disk-halo');
  flyer.setAttribute('aria-hidden', 'true');
  Object.assign(flyer.style, {
    position: 'fixed', left: `${from.left}px`, top: `${from.top}px`,
    width: `${from.width}px`, height: `${from.height}px`, margin: '0',
    zIndex: '10000', pointerEvents: 'none', opacity: '1',
    transformOrigin: 'center center', willChange: 'transform, filter',
    boxShadow: `0 0 28px ${getComputedStyle(disk).getPropertyValue('--disk-color').trim() || '#46e1ff'}, inset 0 2px 6px rgba(255,255,255,.45)`
  });
  document.body.appendChild(flyer);

  if (reducedMotion) {
    flyer.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    await new Promise(resolve => setTimeout(resolve, 90));
  } else {
    const arc = Math.min(112, 34 + Math.abs(dx) * 0.13);
    const animation = flyer.animate([
      { transform: 'translate3d(0,0,0) scale(1)', filter: 'brightness(1)' },
      { transform: `translate3d(${dx * 0.52}px, ${dy * 0.52 - arc}px, 0) scale(1.16)`, filter: 'brightness(1.35)' },
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(1)`, filter: 'brightness(1.08)' }
    ], {
      duration: automatic ? 440 : 610,
      easing: 'cubic-bezier(.22,.78,.22,1)',
      fill: 'forwards'
    });
    try { await animation.finished; } catch (_) { /* animation was cancelled */ }
  }

  flyer.remove();
  disk.classList.remove('in-transit');
  sourceTower.classList.remove('lifted-from');
  targetTower.classList.remove('landing-target');
  playSfx('land');
}

function pulseTower(tower) {
  const el = document.querySelector(`.tower[data-tower="${tower}"]`);
  if (!el) return;
  el.classList.remove('tower-landed');
  // Force a restart when the same tower receives consecutive moves.
  void el.offsetWidth;
  el.classList.add('tower-landed');
  const burst = document.createElement('span');
  burst.className = 'landing-burst';
  burst.setAttribute('aria-hidden', 'true');
  burst.textContent = '✦';
  el.appendChild(burst);
  window.setTimeout(() => { el.classList.remove('tower-landed'); burst.remove(); }, 560);
}

async function commitMove(src, dst, automatic) {
  if (state.busy) return false;
  if (state.mode === 'timeattack' && state.startedAt && state.timeLeft <= 0) return false;
  state.busy = true;
  const payload = {
    ...state.rules, pos: state.pos, moves: state.moves,
    locked: [], dynamic_closed: [], src, dst, teleport: 0
  };
  try {
    const result = await api('apply_move', payload);
    if (!result.ok) {
      state.mistakes += 1;
      playSfx('blocked');
      state.selected = null; state.legal = [];
      renderBoard();
      const message = FRIENDLY_ERRORS[result.reason] || `Illegal move: ${result.reason}`;
      setFeedback(message, 'error');
      return false;
    }
    await animateDiskMove(src, dst, { automatic });
    state.history.push([...state.pos]);
    state.redo = [];
    state.pos = result.pos;
    state.moves += 1;
    if (!state.startedAt) {
      state.startedAt = Date.now();
      startClock();
    }
    state.moveLog.push({ number: state.moves, src, dst, disk: result.disk, automatic });
    state.selected = null; state.legal = []; state.hintMove = null;
    renderBoard();
    pulseTower(dst);
    updateControls();
    renderHistory();
    setFeedback(`Disk ${result.disk} moved: Tower ${src + 1} → Tower ${dst + 1}.`, 'success');
    $('#moveCount').textContent = String(state.moves);
    if (isSolved()) await finishGame();
    return true;
  } catch (error) {
    setFeedback(error.message || 'Could not submit that move to Prolog.', 'error');
    return false;
  } finally {
    state.busy = false;
    updateControls();
  }
}

function isSolved() {
  return state.pos.every((tower, index) => tower === state.rules.target_positions[index]);
}

function updateControls() {
  $('#undoButton').disabled = state.history.length === 0 || state.solving || state.busy || state.finished;
  $('#redoButton').disabled = state.redo.length === 0 || state.solving || state.busy || state.finished;
  $('#hintButton').disabled = state.solving || state.finished || state.busy;
  $('#solveButton').disabled = state.solving || state.finished || state.busy;
}

async function undoMove() {
  if (!state.history.length || state.solving || state.finished || state.busy) return;
  const previous = state.history[state.history.length - 1];
  const diskIndex = state.pos.findIndex((tower, index) => tower !== previous[index]);
  if (diskIndex >= 0) {
    state.busy = true; updateControls();
    try { await animateDiskMove(state.pos[diskIndex], previous[diskIndex]); }
    finally { state.busy = false; }
  }
  state.redo.push([...state.pos]);
  state.pos = state.history.pop();
  state.moves = Math.max(0, state.moves - 1);
  state.moveLog.pop();
  state.selected = null; state.legal = []; state.hintMove = null;
  $('#moveCount').textContent = String(state.moves);
  renderBoard(); if (diskIndex >= 0) pulseTower(previous[diskIndex]); updateControls(); renderHistory();
  setFeedback('Last move undone.', '');
}

async function redoMove() {
  if (!state.redo.length || state.solving || state.finished || state.busy) return;
  const next = state.redo[state.redo.length - 1];
  const diskIndex = state.pos.findIndex((tower, index) => tower !== next[index]);
  const src = diskIndex >= 0 ? state.pos[diskIndex] : -1;
  const dst = diskIndex >= 0 ? next[diskIndex] : -1;
  if (diskIndex >= 0) {
    state.busy = true; updateControls();
    try { await animateDiskMove(src, dst); }
    finally { state.busy = false; }
  }
  state.redo.pop();
  const previous = [...state.pos];
  const disk = diskIndex + 1;
  state.history.push(previous);
  state.pos = next;
  state.moves += 1;
  state.moveLog.push({ number: state.moves, src, dst, disk, automatic: false });
  if (!state.startedAt) { state.startedAt = Date.now(); startClock(); }
  $('#moveCount').textContent = String(state.moves);
  renderBoard(); if (dst >= 0) pulseTower(dst); updateControls(); renderHistory();
  setFeedback('Move restored.', '');
  if (isSolved()) finishGame();
}

async function showHint() {
  if (!state.rules || state.finished || state.solving) return;
  try {
    const result = await api('solver_best_move', { ...state.rules, pos: state.pos });
    if (!result.move || result.move.length !== 2) {
      setFeedback('No optimal move is available from this position.', 'error');
      return;
    }
    state.hintMove = result.move;
    state.hints += 1;
    renderBoard();
    setFeedback(`Hint: move the top disk from Tower ${result.move[0] + 1} to Tower ${result.move[1] + 1}.`, 'success');
    clearTimeout(state.hintTimer);
    state.hintTimer = setTimeout(() => { state.hintMove = null; renderBoard(); }, 3200);
  } catch (error) {
    setFeedback(error.message || 'The Prolog solver could not calculate a hint.', 'error');
  }
}

async function autoSolve() {
  if (!state.rules || state.finished || state.solving) return;
  ensureAudioEngine();
  const space = Math.pow(state.rules.num_towers, state.rules.num_disks);
  if (space > 150000) {
    toast('Auto-solve is limited to puzzles with at most 150,000 possible states.');
    return;
  }
  state.solving = true;
  state.assisted = true;
  updateControls();
  setFeedback('Prolog is calculating the optimal path…', '');
  try {
    while (!isSolved() && state.solving) {
      const result = await api('solver_best_move', { ...state.rules, pos: state.pos });
      if (!result.move || result.move.length !== 2) throw new Error('No solution was found for this position.');
      const moved = await commitMove(result.move[0], result.move[1], true);
      if (!moved) throw new Error('The solver path could not be applied.');
      if (!isSolved()) await new Promise((resolve) => setTimeout(resolve, 190));
    }
    if (isSolved()) setFeedback('Puzzle solved by the Prolog optimal solver.', 'success');
  } catch (error) {
    toast(error.message || 'Auto-solve failed.');
  } finally {
    state.solving = false;
    updateControls();
  }
}

function renderHistory() {
  const list = $('#historyList');
  list.innerHTML = '';
  state.moveLog.forEach((move) => {
    const item = document.createElement('li');
    item.textContent = `#${move.number} · D${move.disk} · ${move.src + 1} → ${move.dst + 1}${move.automatic ? ' · AUTO' : ''}`;
    list.appendChild(item);
  });
  $('#historyCount').textContent = `${state.moveLog.length} MOVES`;
}

async function finishGame() {
  if (state.finished) return;
  state.finished = true;
  state.solving = false;
  playSfx('win');
  if (state.startedAt) state.elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  if (state.timerId) clearInterval(state.timerId);
  state.timeLeft = state.mode === 'timeattack' ? Math.max(0, state.timeLimit - state.elapsed) : 0;
  $('#boardStatus').textContent = 'PUZZLE COMPLETE';
  $('#boardHelp').textContent = 'All disks have reached the goal tower.';
  updateControls();
  let score = 0;
  let optimal = state.optimal;
  try {
    if (optimal === null || optimal < 0) {
      const distance = await api('solver_distance', { ...state.rules, pos: state.initialPos });
      optimal = Number(distance.distance);
    }
    const result = await api('score', {
      num_disks: state.rules.num_disks,
      num_towers: state.rules.num_towers,
      moves: state.moves,
      optimal: Math.max(0, optimal || 0),
      elapsed: state.elapsed,
      time_limit: state.timeLimit,
      time_left: state.timeLeft,
      best_combo: 0,
      use_combo: 0,
      use_speed: state.mode === 'timeattack' ? 1 : 0,
      hints: state.hints,
      power_moves: 0,
      mistakes: state.mistakes,
      objectives_done: 0,
      assisted: state.assisted ? 1 : 0,
      free_hints: state.mode === 'zen' ? 1 : 0
    });
    score = result.total || 0;
  } catch (error) {
    console.warn('Could not calculate score:', error);
  }
  $('#winMoves').textContent = String(state.moves);
  $('#winOptimal').textContent = optimal >= 0 ? String(optimal) : '—';
  $('#winTime').textContent = formatTime(state.elapsed);
  $('#winScore').textContent = Number(score).toLocaleString();
  $('#winMessage').textContent = state.assisted ? 'The Prolog solver completed this demonstration.' : 'Every disk found its place. Nicely done.';
  $('#winOverlay').classList.remove('hidden');
}

function restartGame() {
  if (!state.rules || state.solving) return;
  if (!window.confirm('Restart this puzzle and clear the move history?')) return;
  if (state.timerId) clearInterval(state.timerId);
  state.pos = [...state.initialPos];
  state.moves = 0; state.selected = null; state.legal = []; state.hintMove = null;
  state.history = []; state.redo = []; state.moveLog = [];
  state.startedAt = null; state.elapsed = 0; state.hints = 0; state.mistakes = 0;
  state.assisted = false; state.finished = false; state.solving = false;
  state.timeLeft = state.timeLimit;
  $('#moveCount').textContent = '0';
  $('#timerValue').textContent = state.mode === 'timeattack' ? formatTime(state.timeLimit) : '00:00';
  $('#boardStatus').textContent = 'PUZZLE IN PROGRESS';
  $('#boardHelp').textContent = 'Drag a top disk to another tower, or tap two towers to move.';
  $('#winOverlay').classList.add('hidden');
  setFeedback('Puzzle restarted.', '');
  renderBoard(); updateControls(); renderHistory();
}

function toggleHistory() {
  state.historyVisible = !state.historyVisible;
  $('#historyPanel').classList.toggle('hidden', !state.historyVisible);
}

function goToSetup() {
  if (state.solving) state.solving = false;
  if (state.timerId) clearInterval(state.timerId);
  showView('setup');
}

// Original ambient music and synthesized game sound effects use Web Audio;
// no copyrighted tracks or external audio files are required.
const MUSIC_NOTES = [261.63, 329.63, 392.00, 493.88, 392.00, 329.63, 293.66, 349.23,
  440.00, 523.25, 440.00, 349.23, 293.66, 369.99, 440.00, 554.37];

function ensureAudioEngine() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!state.audioContext) {
    state.audioContext = new AudioContextClass();
    state.musicGain = state.audioContext.createGain();
    state.musicGain.gain.value = 0.0001;
    state.musicGain.connect(state.audioContext.destination);
    state.sfxGain = state.audioContext.createGain();
    state.sfxGain.gain.value = 0.72;
    state.sfxGain.connect(state.audioContext.destination);
    const pad = [130.81, 164.81, 196.00].map((frequency, index) => {
      const oscillator = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();
      oscillator.type = index === 1 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.003;
      oscillator.connect(gain); gain.connect(state.musicGain); oscillator.start();
      return oscillator;
    });
    state.musicPad = pad;
  }
  if (state.audioContext.state === 'suspended') state.audioContext.resume().catch(() => {});
  return true;
}

function playMusicNote(frequency, duration = 0.72) {
  const ctx = state.audioContext;
  if (!ctx || !state.musicGain || !state.musicOn) return;
  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();
  oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, now);
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(0.055, now + 0.07);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(envelope); envelope.connect(state.musicGain);
  oscillator.start(now); oscillator.stop(now + duration + 0.03);
}

function playSfx(kind) {
  if (!state.soundOn || !ensureAudioEngine()) return;
  const ctx = state.audioContext;
  const now = ctx.currentTime;
  const tone = (frequency, endFrequency, duration, volume, type = 'sine', delay = 0) => {
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    const start = now + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.025, duration * 0.25));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain); gain.connect(state.sfxGain);
    osc.start(start); osc.stop(start + duration + 0.02);
  };
  if (kind === 'pickup') {
    tone(430, 760, 0.12, 0.13, 'triangle');
  } else if (kind === 'whoosh') {
    tone(190, 540, 0.32, 0.075, 'sawtooth');
    tone(620, 920, 0.20, 0.035, 'sine', 0.08);
  } else if (kind === 'land') {
    tone(560, 740, 0.16, 0.12, 'sine');
    tone(840, 1040, 0.22, 0.075, 'triangle', 0.045);
  } else if (kind === 'blocked') {
    tone(210, 125, 0.20, 0.12, 'square');
  } else if (kind === 'win') {
    tone(523.25, 783.99, 0.28, 0.11, 'triangle');
    tone(659.25, 987.77, 0.32, 0.10, 'triangle', 0.10);
    tone(783.99, 1174.66, 0.46, 0.12, 'sine', 0.20);
  }
}

function startMusic() {
  if (!ensureAudioEngine()) {
    toast('Background music is not supported by this browser.');
    return false;
  }
  const ctx = state.audioContext;
  state.musicGain.gain.cancelScheduledValues(ctx.currentTime);
  state.musicGain.gain.setTargetAtTime(0.32, ctx.currentTime, 0.18);
  state.musicOn = true; state.musicStep = 0;
  playMusicNote(MUSIC_NOTES[state.musicStep++]);
  clearInterval(state.musicTimer);
  state.musicTimer = setInterval(() => {
    playMusicNote(MUSIC_NOTES[state.musicStep % MUSIC_NOTES.length]);
    state.musicStep += 1;
  }, 620);
  updateMusicButton();
  return true;
}

function stopMusic() {
  state.musicOn = false;
  clearInterval(state.musicTimer); state.musicTimer = null;
  if (state.musicGain && state.audioContext) {
    const gain = state.musicGain.gain;
    gain.cancelScheduledValues(state.audioContext.currentTime);
    gain.setTargetAtTime(0.0001, state.audioContext.currentTime, 0.12);
  }
  updateMusicButton();
}

function updateMusicButton() {
  const button = $('#musicToggle');
  if (!button) return;
  button.setAttribute('aria-pressed', String(state.musicOn));
  button.setAttribute('aria-label', state.musicOn ? 'Turn background music off' : 'Turn background music on');
  button.classList.toggle('playing', state.musicOn);
  button.innerHTML = state.musicOn ? '♫ <span>MUSIC ON</span>' : '♫ <span>MUSIC OFF</span>';
}

function updateSoundButton() {
  const button = $('#soundToggle');
  if (!button) return;
  button.setAttribute('aria-pressed', String(state.soundOn));
  button.setAttribute('aria-label', state.soundOn ? 'Turn sound effects off' : 'Turn sound effects on');
  button.classList.toggle('playing', state.soundOn);
  button.innerHTML = state.soundOn ? '◖ <span>SFX ON</span>' : '◖ <span>SFX OFF</span>';
}

function toggleMusic() {
  if (state.musicOn) stopMusic(); else startMusic();
}

function toggleSound() {
  state.soundOn = !state.soundOn;
  if (state.soundOn) { ensureAudioEngine(); playSfx('pickup'); }
  updateSoundButton();
}

function bindEvents() {
  $('#musicToggle').addEventListener('click', toggleMusic);
  $('#soundToggle').addEventListener('click', toggleSound);
  $('#startButton').addEventListener('click', () => showView('setup'));
  $('#backHome').addEventListener('click', () => showView('home'));
  $('#backSetup').addEventListener('click', goToSetup);
  $('#howButton').addEventListener('click', () => showView('how'));
  $('#backHow').addEventListener('click', () => showView('home'));
  $('#howPlayButton').addEventListener('click', () => showView('setup'));
  $('#diskCount').addEventListener('input', updateDiskOutput);
  $$('.mode-option').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  $('#launchButton').addEventListener('click', launchGame);
  $('#undoButton').addEventListener('click', undoMove);
  $('#redoButton').addEventListener('click', redoMove);
  $('#hintButton').addEventListener('click', showHint);
  $('#solveButton').addEventListener('click', autoSolve);
  $('#restartButton').addEventListener('click', restartGame);
  $('#historyButton').addEventListener('click', toggleHistory);
  $('#playAgainButton').addEventListener('click', () => { $('#winOverlay').classList.add('hidden'); restartWithoutPrompt(); });
  $('#winMenuButton').addEventListener('click', () => { $('#winOverlay').classList.add('hidden'); goToSetup(); });
  document.addEventListener('keydown', (event) => {
    if (state.view !== 'game' || event.target.matches('input,select,textarea')) return;
    const key = event.key.toLowerCase();
    if (key === 'z') { event.preventDefault(); undoMove(); }
    else if (key === 'y') { event.preventDefault(); redoMove(); }
    else if (key === 'h') { event.preventDefault(); showHint(); }
    else if (key === 'a') { event.preventDefault(); autoSolve(); }
    else if (key === 'r') { event.preventDefault(); restartGame(); }
    else if (/^[1-6]$/.test(key) && state.rules) handleTowerClick(Number(key) - 1);
    else if (key === 'escape' && state.selected !== null) { state.selected = null; state.legal = []; renderBoard(); }
  });
}

function restartWithoutPrompt() {
  if (!state.rules) return;
  if (state.timerId) clearInterval(state.timerId);
  state.pos = [...state.initialPos];
  state.moves = 0; state.selected = null; state.legal = []; state.hintMove = null;
  state.history = []; state.redo = []; state.moveLog = [];
  state.startedAt = null; state.elapsed = 0; state.hints = 0; state.mistakes = 0; state.timeLeft = state.timeLimit;
  state.assisted = false; state.finished = false; state.solving = false;
  $('#moveCount').textContent = '0';
  $('#timerValue').textContent = state.mode === 'timeattack' ? formatTime(state.timeLimit) : '00:00';
  $('#boardStatus').textContent = 'PUZZLE IN PROGRESS';
  $('#winOverlay').classList.add('hidden');
  setFeedback('New attempt started.', '');
  renderBoard(); updateControls(); renderHistory();
}

bindEvents();
updateMusicButton();
updateSoundButton();
updateDiskOutput();
setMode('classic');
checkEngine();
// Retry automatically if the page was opened before SWI-Prolog finished starting.
window.setInterval(() => {
  if (!engineOnline) checkEngine({ quiet: true });
}, 4000);
