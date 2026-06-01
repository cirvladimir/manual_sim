/*
 * main.js — input, rendering, and the main loop.
 *
 * Controls (Xbox controller, primary):
 *   Left trigger  ........ clutch (analog: in = disengaged)
 *   Right trigger ........ gas (analog)
 *   Right bumper  ........ brake
 *   Right stick up/down .. sequential shift (up = next gear, down = previous)
 *   A button ............. start engine (clutch in or in neutral)
 *
 * Keyboard fallback (when no controller is detected):
 *   C = clutch, ↑/W = gas, Space = brake, E = shift up, Q = shift down,
 *   Enter = start engine.
 */

const car = new Car();
const track = buildDefaultTrack();

/*
 * EngineSound — a tiny Web Audio synth. A sawtooth (plus an octave) runs
 * through a low-pass filter; the pitch tracks RPM and the filter opens and
 * the volume rises with revs/throttle, so it growls under load and settles to
 * a low idle. Audio can only start after a user gesture, so init() is called
 * from the first keypress/click/engine-start.
 */
class EngineSound {
  constructor() { this.ready = false; this.ctx = null; }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.osc = this.ctx.createOscillator(); this.osc.type = 'sawtooth';
    this.osc2 = this.ctx.createOscillator(); this.osc2.type = 'square';
    this.gain2 = this.ctx.createGain(); this.gain2.gain.value = 0;
    this.filter = this.ctx.createBiquadFilter(); this.filter.type = 'lowpass';
    this.filter.frequency.value = 500;
    this.gain = this.ctx.createGain(); this.gain.gain.value = 0;
    this.osc.connect(this.filter);
    this.osc2.connect(this.gain2); this.gain2.connect(this.filter);
    this.filter.connect(this.gain); this.gain.connect(this.ctx.destination);
    this.osc.start(); this.osc2.start();
    this.ready = true;
  }
  update(rpm, throttle, on) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const f = Math.max(20, rpm / 15); // engine fundamental, scaled to be audible
    this.osc.frequency.setTargetAtTime(f, now, 0.03);
    this.osc2.frequency.setTargetAtTime(f * 2, now, 0.03);
    const lp = 300 + (rpm / car.maxRPM) * 2600 + throttle * 1400;
    this.filter.frequency.setTargetAtTime(lp, now, 0.05);
    const g = on ? (0.05 + 0.10 * throttle + 0.05 * (rpm / car.maxRPM)) : 0;
    this.gain.gain.setTargetAtTime(g, now, 0.04);
    this.gain2.gain.setTargetAtTime(on ? 0.035 : 0, now, 0.04);
  }
}
const engineSound = new EngineSound();
window.addEventListener('pointerdown', () => engineSound.init());

const gameCanvas = document.getElementById('game');
const gctx = gameCanvas.getContext('2d');
const gaugeCanvas = document.getElementById('gauges');
const ggctx = gaugeCanvas.getContext('2d');
const elGear = document.getElementById('gear');
const elInput = document.getElementById('inputmode');
const elClutch = document.getElementById('clutchbar');
const elGas = document.getElementById('gasbar');
const elBrake = document.getElementById('brakebar');
const elStatus = document.getElementById('status');

const PPM = 8; // pixels per metre

// ---------- keyboard state ----------
const keys = {};
window.addEventListener('keydown', (e) => {
  if ([' ', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
  engineSound.init();
  if (!keys[e.key]) {
    // edge-triggered keys
    if (e.key === 'e' || e.key === 'E') car.shiftUp();
    if (e.key === 'q' || e.key === 'Q') car.shiftDown();
    if (e.key === 'Enter') tryStart();
  }
  keys[e.key] = true;
});
window.addEventListener('keyup', (e) => { keys[e.key] = false; });

// ---------- gamepad edge tracking ----------
let stickNeutral = true; // right stick returned to centre since last shift
let aWasDown = false;

function readInputs() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const p of pads) { if (p) { gp = p; break; } }

  let clutch = 0, throttle = 0, brake = 0;

  if (gp) {
    elInput.textContent = 'Xbox controller';
    clutch = gp.buttons[6] ? gp.buttons[6].value : 0;   // LT
    throttle = gp.buttons[7] ? gp.buttons[7].value : 0; // RT
    brake = gp.buttons[5] && gp.buttons[5].pressed ? 1 : 0; // RB

    // right stick vertical = axes[3], up is negative
    const sy = gp.axes[3] || 0;
    if (stickNeutral) {
      if (sy < -0.6) { car.shiftUp(); stickNeutral = false; }
      else if (sy > 0.6) { car.shiftDown(); stickNeutral = false; }
    } else if (Math.abs(sy) < 0.3) {
      stickNeutral = true;
    }

    // A button = start
    const aDown = gp.buttons[0] && gp.buttons[0].pressed;
    if (aDown && !aWasDown) tryStart();
    aWasDown = aDown;
  } else {
    elInput.textContent = 'Keyboard (no controller)';
    clutch = (keys['c'] || keys['C']) ? 1 : 0;
    throttle = (keys['ArrowUp'] || keys['w'] || keys['W']) ? 1 : 0;
    brake = keys[' '] ? 1 : 0;
  }

  return { clutch, throttle, brake };
}

function tryStart() {
  engineSound.init();
  const inp = lastInputs || { clutch: 0 };
  car.startEngine(inp.clutch);
}

// ---------- main loop ----------
let lastT = performance.now();
let lastInputs = { clutch: 0, throttle: 0, brake: 0 };

function frame(now) {
  const dt = (now - lastT) / 1000;
  lastT = now;

  const inputs = readInputs();
  lastInputs = inputs;

  const slope = track.slopeAt(car.s);
  car.update(dt, inputs, slope);

  // keep the car on the track
  if (car.s < 0) { car.s = 0; if (car.v < 0) car.v = 0; }
  if (car.s > track.length) { car.s = track.length; if (car.v > 0) car.v = 0; }

  engineSound.update(car.rpm, inputs.throttle, car.engineOn);

  drawGame();
  drawGauges();
  updateHUD(inputs);

  requestAnimationFrame(frame);
}

// ---------- world rendering ----------
function drawGame() {
  const W = gameCanvas.width, H = gameCanvas.height;
  gctx.clearRect(0, 0, W, H);

  // sky
  gctx.fillStyle = '#cfe8ff';
  gctx.fillRect(0, 0, W, H);

  const carPos = track.posAt(car.s);
  const anchorX = W * 0.35;     // car's fixed screen x
  const anchorY = H * 0.6;      // car's fixed screen y

  // world -> screen (camera follows the car; y is up in world)
  const toScreen = (wx, wy) => ({
    x: anchorX + (wx - carPos.x) * PPM,
    y: anchorY - (wy - carPos.y) * PPM,
  });

  // ground polyline across the visible x range
  const leftWX = carPos.x - anchorX / PPM;
  const rightWX = carPos.x + (W - anchorX) / PPM;

  gctx.beginPath();
  let started = false;
  for (let wx = leftWX; wx <= rightWX; wx += 2) {
    const wy = track.heightAtX(wx);
    const p = toScreen(wx, wy);
    if (!started) { gctx.moveTo(p.x, p.y); started = true; }
    else gctx.lineTo(p.x, p.y);
  }
  const endp = toScreen(rightWX, track.heightAtX(rightWX));
  gctx.lineTo(endp.x, H);
  gctx.lineTo(toScreen(leftWX, track.heightAtX(leftWX)).x, H);
  gctx.closePath();
  gctx.fillStyle = '#5a7d3c';
  gctx.fill();
  gctx.strokeStyle = '#3c5627';
  gctx.lineWidth = 3;
  gctx.stroke();

  // distance markers every 10 m of world x
  gctx.fillStyle = 'rgba(255,255,255,0.5)';
  const firstMark = Math.ceil(leftWX / 10) * 10;
  for (let mx = firstMark; mx <= rightWX; mx += 10) {
    const p = toScreen(mx, track.heightAtX(mx));
    gctx.fillRect(p.x - 1, p.y - 2, 2, 6);
  }

  // the car: a rectangle on two wheels, rotated to the local slope
  const slope = track.slopeAt(car.s);
  const cp = toScreen(carPos.x, carPos.y);
  gctx.save();
  gctx.translate(cp.x, cp.y);
  gctx.rotate(-slope); // screen y is down, world slope is up
  const bodyW = 4.0 * PPM, bodyH = 1.4 * PPM, wheelR = 0.4 * PPM;
  // wheels
  gctx.fillStyle = '#222';
  gctx.beginPath(); gctx.arc(-bodyW * 0.32, -wheelR, wheelR, 0, Math.PI * 2); gctx.fill();
  gctx.beginPath(); gctx.arc(bodyW * 0.32, -wheelR, wheelR, 0, Math.PI * 2); gctx.fill();
  // body
  gctx.fillStyle = car.engineOn ? '#c0392b' : '#7f8c8d';
  gctx.fillRect(-bodyW / 2, -wheelR * 2 - bodyH, bodyW, bodyH);
  // cabin
  gctx.fillStyle = '#2c3e50';
  gctx.fillRect(-bodyW * 0.15, -wheelR * 2 - bodyH - bodyH * 0.6, bodyW * 0.5, bodyH * 0.6);
  gctx.restore();

  // stall flash
  if (!car.engineOn) {
    gctx.fillStyle = 'rgba(200,0,0,0.85)';
    gctx.font = 'bold 22px sans-serif';
    gctx.fillText('ENGINE OFF — press A / Enter (clutch in or N)', 20, 34);
  }
}

// ---------- gauges ----------
function drawGauges() {
  const W = gaugeCanvas.width, H = gaugeCanvas.height;
  ggctx.clearRect(0, 0, W, H);
  ggctx.fillStyle = '#111';
  ggctx.fillRect(0, 0, W, H);

  drawDial(ggctx, W * 0.25, H * 0.55, H * 0.4, car.rpm, 0, car.maxRPM, 'RPM',
    car.rpm / 1000, 1, car.maxRPM * 0.78);
  drawDial(ggctx, W * 0.75, H * 0.55, H * 0.4, Math.abs(car.speedKmh), 0, 200, 'km/h',
    Math.abs(car.speedKmh), 0, 9999);
}

function drawDial(ctx, cx, cy, r, value, min, max, label, readout, decimals, redzone) {
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25; // sweep
  // arc background
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#333';
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
  // redzone
  if (redzone < max) {
    const rz = a0 + (a1 - a0) * (redzone - min) / (max - min);
    ctx.strokeStyle = '#b00';
    ctx.beginPath(); ctx.arc(cx, cy, r, rz, a1); ctx.stroke();
  }
  // needle
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const a = a0 + (a1 - a0) * t;
  ctx.strokeStyle = '#0f0';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
  ctx.stroke();
  // readout text
  ctx.fillStyle = '#eee';
  ctx.textAlign = 'center';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(readout.toFixed(decimals), cx, cy + r * 0.55);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#aaa';
  ctx.fillText(label, cx, cy + r * 0.8);
  ctx.textAlign = 'start';
}

// ---------- HUD ----------
function updateHUD(inputs) {
  elGear.textContent = car.gearName;
  elGear.style.color = car.engineOn ? '#2ecc71' : '#e74c3c';
  elClutch.style.width = (inputs.clutch * 100) + '%';
  elGas.style.width = (inputs.throttle * 100) + '%';
  elBrake.style.width = (inputs.brake * 100) + '%';

  let s = car.engineOn ? 'Engine running' : 'Engine OFF';
  if (car.justStalled) s = 'STALLED!';
  elStatus.textContent = s;
}

requestAnimationFrame(frame);
