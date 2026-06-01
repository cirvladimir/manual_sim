/*
 * physics.js — the game engine.
 *
 * The world is 1-D: the car only ever moves *along the road surface*. Its
 * position is an arc-length `s` measured along the ground, and `v` is its
 * speed along that direction (positive = forward / left-to-right).
 *
 * Every frame we sum the forces acting along the road:
 *   - gravity component along the slope        (rolls you back uphill)
 *   - drive force from the engine via the clutch + gearbox
 *   - rolling resistance and braking
 * ...and the equal-and-opposite reaction torque the car puts back on the
 * engine through the clutch is what drags engine RPM down and stalls it.
 *
 * The clutch is the heart of the model. It's a friction coupling whose
 * torque capacity scales with how far it's engaged. Whenever the engine and
 * the gearbox input are spinning at different speeds (slip), the clutch
 * transmits torque to close that gap — accelerating the car and decelerating
 * the engine (or vice-versa). Dump the clutch at idle in gear and the car's
 * inertia drags the engine below stall speed: you stall. Feed it gas while
 * slipping the clutch and you pull away. Hill starts, stalling, and biting-
 * point control all fall out of this naturally rather than being scripted.
 */

const RPM_PER_RAD = 60 / (2 * Math.PI); // rad/s -> rev/min
const RAD_PER_RPM = (2 * Math.PI) / 60; // rev/min -> rad/s

const GEARS = [
  { name: 'R', ratio: -3.2 },
  { name: 'N', ratio: 0.0 },
  { name: '1', ratio: 3.5 },
  { name: '2', ratio: 2.2 },
  { name: '3', ratio: 1.5 },
  { name: '4', ratio: 1.1 },
  { name: '5', ratio: 0.9 },
];

class Car {
  constructor() {
    // --- tunable constants ---
    this.mass = 1100;          // kg
    this.wheelRadius = 0.30;   // m
    this.finalDrive = 3.7;     // axle ratio (multiplies the gear ratio)
    this.engineInertia = 0.25; // kg·m² of all the spinning engine parts

    this.idleRPM = 850;
    this.stallRPM = 450;       // below this, a running engine dies
    this.maxRPM = 6800;        // rev limiter
    this.maxTorque = 200;      // N·m, peak of the torque curve

    // Engine drag is throttle-dependent: with the throttle closed, pumping
    // losses are high so the revs drop quickly (~1 s from 5k to idle); at full
    // throttle the loss is small so the engine can pull to the redline.
    this.engFricOpen = 0.03;   // viscous coeff at full throttle (per rad/s)
    this.engFricClosed = 0.32; // viscous coeff off-throttle (per rad/s)
    this.engFricB = 8.0;       // constant friction loss (N·m)
    this.idleK = 0.9;          // idle governor gain (N·m per rpm below idle)
    this.idleMaxTorque = 80;   // governor can't add more than this

    this.clutchMaxTorque = 380; // friction capacity at full engagement (N·m)
    this.slipScale = 4.0;       // how sharply torque ramps with slip (rad/s)
    // Clutch pedal deadzones (fraction of travel, 0 = released, 1 = floored):
    // below `low` the clutch is fully engaged, above `high` fully disengaged,
    // and it grips progressively in between (the "bite" zone).
    this.clutchDeadLow = 0.25;
    this.clutchDeadHigh = 0.75;

    this.rollK = 12;            // rolling resistance (N per m/s)
    this.brakeMaxForce = 14000; // N at full brake

    this.g = 9.81;

    // --- state ---
    this.s = 0;            // arc-length position along the road (m)
    this.v = 0;            // speed along the road (m/s)
    this.engineOmega = 0;  // engine angular speed (rad/s)
    this.engineOn = false;
    this.gearIndex = 1;    // index into GEARS; start in Neutral

    // --- read-only telemetry, refreshed each step for the HUD ---
    this.clutchTorque = 0;
    this.driveForce = 0;
    this.justStalled = false;
  }

  get rpm() { return this.engineOmega * RPM_PER_RAD; }
  get gearName() { return GEARS[this.gearIndex].name; }
  get inGear() { return GEARS[this.gearIndex].ratio !== 0; }
  get speedKmh() { return this.v * 3.6; }

  startEngine(clutchPedal) {
    // You can only crank it with the clutch in or in neutral — otherwise the
    // drivetrain would fight the starter.
    if (this.engineOn) return false;
    if (this.inGear && clutchPedal < 0.5) return false;
    this.engineOn = true;
    this.engineOmega = this.idleRPM * RAD_PER_RPM;
    return true;
  }

  shiftUp() {
    if (this.gearIndex < GEARS.length - 1) this.gearIndex++;
  }
  shiftDown() {
    if (this.gearIndex > 0) this.gearIndex--;
  }

  // Naturally-aspirated-ish torque curve: peaks around 3500 rpm, falls off
  // toward idle and redline.
  torqueAtRPM(rpm) {
    if (rpm <= 0) return 0;
    const f = 1.05 - Math.pow((rpm - 3500) / 3500, 2);
    return this.maxTorque * Math.max(0.2, Math.min(1, f));
  }

  // Map raw clutch pedal travel (0..1) to actual coupling (0..1) with the
  // engaged/bite/disengaged deadzones of a real pedal.
  clutchEngagement(pedal) {
    const t = (this.clutchDeadHigh - pedal) / (this.clutchDeadHigh - this.clutchDeadLow);
    return clamp01(t);
  }

  /*
   * Advance the simulation.
   *   dt          — frame time (s)
   *   inputs      — { clutch:0..1 (1=pedal fully in/disengaged),
   *                   throttle:0..1, brake:0..1 }
   *   slopeAngle  — road angle in radians (positive = uphill ahead)
   *
   * We sub-step internally so the stiff clutch coupling stays stable
   * regardless of frame rate.
   */
  update(dt, inputs, slopeAngle) {
    this.justStalled = false;
    const sub = 1 / 600;
    let remaining = Math.min(dt, 0.05);
    while (remaining > 1e-6) {
      const h = Math.min(sub, remaining);
      this.step(h, inputs, slopeAngle);
      remaining -= h;
    }
  }

  step(dt, inputs, slopeAngle) {
    const clutchPedal = clamp01(inputs.clutch);
    const throttle = clamp01(inputs.throttle);
    const brake = clamp01(inputs.brake);

    const ratio = GEARS[this.gearIndex].ratio * this.finalDrive;
    const inGear = this.inGear;
    const wheelOmega = this.v / this.wheelRadius;
    const rpm = this.engineOmega * RPM_PER_RAD;

    // --- engine torque sources ---
    let throttleTorque = 0;
    if (this.engineOn && rpm < this.maxRPM) {
      throttleTorque = throttle * this.torqueAtRPM(rpm);
    }
    let idleGov = 0;
    if (this.engineOn && rpm < this.idleRPM) {
      idleGov = Math.min(this.idleMaxTorque, (this.idleRPM - rpm) * this.idleK);
    }
    const aCoef = this.engineOn
      ? this.engFricOpen + (this.engFricClosed - this.engFricOpen) * (1 - throttle)
      : this.engFricClosed * 0.6; // coasting down, no combustion
    let friction = aCoef * this.engineOmega + (this.engineOn ? this.engFricB : 4);

    // --- clutch coupling (only matters when a gear is selected) ---
    let clutchTorque = 0;
    if (inGear) {
      const engagement = this.clutchEngagement(clutchPedal);
      const capacity = this.clutchMaxTorque * engagement;
      const engineSideWheelOmega = wheelOmega * ratio; // engine speed the wheels "want"
      const slip = this.engineOmega - engineSideWheelOmega;
      clutchTorque = capacity * Math.tanh(slip / this.slipScale);
    }

    // --- integrate engine speed ---
    const netEngineTorque = throttleTorque + idleGov - friction - clutchTorque;
    this.engineOmega += (netEngineTorque / this.engineInertia) * dt;
    if (this.engineOmega < 0) this.engineOmega = 0;

    // stall: a running engine pulled below stall speed dies
    if (this.engineOn && this.engineOmega * RPM_PER_RAD < this.stallRPM) {
      this.engineOn = false;
      this.justStalled = true;
    }

    // --- vehicle forces along the road ---
    let driveForce = 0;
    if (inGear) {
      driveForce = (clutchTorque * ratio) / this.wheelRadius;
    }
    const gravityForce = -this.mass * this.g * Math.sin(slopeAngle);
    const rolling = -this.rollK * this.v;
    const F = driveForce + gravityForce + rolling;

    this.v += (F / this.mass) * dt;

    // brake: a force opposing motion, with a static hold when nearly stopped
    const brakeForceMax = brake * this.brakeMaxForce;
    if (brakeForceMax > 0) {
      const bdv = (brakeForceMax / this.mass) * dt;
      if (Math.abs(this.v) < bdv && brakeForceMax >= Math.abs(F)) {
        this.v = 0; // held by the brakes
      } else {
        this.v -= Math.sign(this.v) * Math.min(bdv, Math.abs(this.v));
      }
    }

    this.s += this.v * dt;

    // telemetry
    this.clutchTorque = clutchTorque;
    this.driveForce = driveForce;
  }
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
