// ==UserScript==
// @name         Slow Parcours
// @namespace    http://tampermonkey.net/
// @version      8.6
// @description  Controls Smart Trainers via FTMS Sim Mode (Incline). Physics update loop synchronized with Game Input polling.
// @author       Gemini
// @match        https://slowroads.io/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function() {

    // --- Configuration ---
    const CONFIG = {
        MAX_STEER_ANGLE: 20,
        STEERING_DEADBAND: 0.0, // The game handles this internally, but keep the logic around
        SMOOTHING: 0.15,
        SPEED_SMOOTHING: 0.1,
        GRADE_FACTOR: 10,
        BASE_RESISTANCE: 30,
        CDA: 0.3,
        RESISTANCE_UPDATE_RATE: 500, // ms
        // Hardware UUIDs
        FTMS_SERVICE: 0x1826,
        FTMS_DATA: 0x2AD2,
        FTMS_CONTROL: 0x2AD9,
        CPS_SERVICE: 0x1818,
        CPS_MEASUREMENT: 0x2A63,
        SYSTEM_MASS: 85, // Mass of rider + bike (kg)
        SCALING_FACTOR: 1.0, // Multiplier. 1.0 = Realistic. 2.0 = E-Bike/Arcade feel.
        STERZO_SERVICE:   '347b0001-7635-408b-8918-8ff3949ce592',
        STERZO_STEERING:  '347b0030-7635-408b-8918-8ff3949ce592',
        STERZO_CP:        '347b0031-7635-408b-8918-8ff3949ce592',
        STERZO_CHALLENGE: '347b0032-7635-408b-8918-8ff3949ce592',
        // Sterzo Opcodes
        STERZO_OP_CHALLENGE: 0x1003,
        STERZO_OP_RESPONSE: 0x1103,
    };

    // --- 1. Web Component (UI) ---
    class BleHud extends HTMLElement {
        static get observedAttributes() {
            return ['watts', 'speed', 'grade', 'angle', 'resistance', 'game-status', 'trainer-status', 'sterzo-status'];
        }
        constructor() { super(); this.attachShadow({ mode: 'open' }); }
        connectedCallback() { this.render(); this.cacheElements(); this.addListeners(); if (!this.hasAttribute('view-mode')) this.setAttribute('view-mode', 'power'); }
        cacheElements() {
            this.els = {
                watts: this.shadowRoot.getElementById('val-watts'),
                speed: this.shadowRoot.getElementById('val-speed'),
                grade: this.shadowRoot.getElementById('val-grade'),
                angle: this.shadowRoot.getElementById('val-angle'),
                bar: this.shadowRoot.getElementById('res-fill')
            };
        }
        addListeners() {
            this.shadowRoot.getElementById('btn-trainer').onclick = (e) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent('pair-trainer', { bubbles: true, composed: true })); };
            this.shadowRoot.getElementById('btn-sterzo').onclick = (e) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent('pair-sterzo', { bubbles: true, composed: true })); };
            this.shadowRoot.querySelector('.metrics-row').onclick = () => {
                const next = this.getAttribute('view-mode') === 'speed' ? 'power' : 'speed';
                this.setAttribute('view-mode', next);
            };
        }
        attributeChangedCallback(name, oldValue, newValue) {
            if (!this.els) return;
            switch (name) {
                case 'watts': this.els.watts.dataset.value = newValue; break;
                case 'speed': this.els.speed.dataset.value = newValue; break;
                case 'grade': this.els.grade.dataset.value = newValue + '%'; break;
                case 'angle': this.els.angle.dataset.value = newValue + '°'; break;
                case 'resistance': this.style.setProperty('--res-percent', `${(parseInt(newValue) / 200) * 100}%`); break;
            }
        }
        render() {
            const css = `
                :host { font-family: 'Sono', monospace; position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 99999; pointer-events: none; --res-percent: 0%; }
                .hud-panel { background: rgba(15, 23, 42, 0.4); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 12px 16px; color: #f8fafc; display: flex; flex-direction: column; gap: 12px; pointer-events: auto; transition: background 0.3s ease; min-width: 260px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); user-select: none; }
                .hud-panel:hover { background: rgba(15, 23, 42, 0.7); }
                .hud-header { display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem; font-weight: 400; letter-spacing: 0.05em; color: rgba(255, 255, 255, 0.5); }
                .status-icons { display: flex; gap: 8px; }
                .icon-btn { background: transparent; border: none; color: rgba(255, 255, 255, 0.2); width: 24px; height: 24px; padding: 0; cursor: pointer; transition: all 0.3s; display: flex; align-items: center; justify-content: center; border-radius: 6px; }
                .icon-btn svg { width: 16px; height: 16px; stroke: currentColor; stroke-width: 2.5; fill: none; pointer-events: none; }
                .icon-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
                .icon-btn:focus-visible { outline: 2px solid #3b82f6; color: #fff; }
                :host([game-status*="Linked"]) #btn-game { color: #3b82f6; filter: drop-shadow(0 0 4px rgba(59, 130, 246, 0.5)); }
                :host([game-status="Searching..."]) #btn-game { color: #d97706; animation: pulse 1.5s infinite; }
                :host([trainer-status="connected"]) #btn-trainer { color: #10b981; filter: drop-shadow(0 0 4px rgba(16, 185, 129, 0.5)); }
                :host([trainer-status="connecting"]) #btn-trainer { color: #d97706; animation: pulse 1s infinite; }
                :host([sterzo-status="connected"]) #btn-sterzo { color: #10b981; filter: drop-shadow(0 0 4px rgba(16, 185, 129, 0.5)); }
                :host([sterzo-status="connecting"]) #btn-sterzo { color: #d97706; animation: pulse 1s infinite; }
                .metrics-row { display: flex; justify-content: space-between; align-items: baseline; cursor: pointer; border-radius: 8px; padding: 4px 0; transition: background 0.2s; }
                .metrics-row:hover { background: rgba(255, 255, 255, 0.05); }
                .metric { display: flex; flex-direction: column; }
                .metric-val::after { content: attr(data-value); font-size: 1.75rem; font-weight: 300; line-height: 1; font-feature-settings: "tnum"; text-shadow: 0 2px 10px rgba(0,0,0,0.5); }
                .metric-lbl { font-size: 0.65rem; font-weight: 500; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); margin-top: 2px; }
                :host(:not([view-mode="speed"])) #metric-speed { display: none; }
                :host(:not([view-mode="speed"])) #metric-watts { display: flex; }
                :host([view-mode="speed"]) #metric-watts { display: none; }
                :host([view-mode="speed"]) #metric-speed { display: flex; }
                .metric-small .metric-val::after { font-size: 1rem; }
                .metric-small { align-items: flex-end; }
                .res-container { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
                .res-lbl { font-size: 0.6rem; font-weight: 500; color: rgba(255, 255, 255, 0.4); letter-spacing: 0.05em; }
                .res-track { flex-grow: 1; height: 4px; background: rgba(255, 255, 255, 0.1); border-radius: 2px; overflow: hidden; }
                .res-fill { height: 100%; width: var(--res-percent); background: linear-gradient(90deg, #3b82f6, #a855f7); transition: width 0.3s ease-out; }
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
            `;
            const iconLink = `<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>`;
            const iconBolt = `<svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>`;
            const iconWheel = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 2v8"/><path d="m12 12 7 7"/><path d="m12 12-7 7"/></svg>`;

            this.shadowRoot.innerHTML = `<style>${css}</style><div class="hud-panel"><div class="hud-header"><span>TELEMETRY</span><div class="status-icons"><button class="icon-btn" id="btn-game" title="Game Hook" type="button">${iconLink}</button><button class="icon-btn" id="btn-trainer" title="Trainer" type="button">${iconBolt}</button><button class="icon-btn" id="btn-sterzo" title="Steering" type="button">${iconWheel}</button></div></div><div class="metrics-row" title="Click to toggle Speed/Power"><div class="metric" id="metric-watts"><span class="metric-val" id="val-watts" data-value="0"></span><span class="metric-lbl">Watts</span></div><div class="metric" id="metric-speed"><span class="metric-val" id="val-speed" data-value="0.0"></span><span class="metric-lbl">KM/H</span></div><div class="metric"><span class="metric-val" id="val-grade" data-value="0.0%"></span><span class="metric-lbl">Grade</span></div><div class="metric metric-small"><span class="metric-val" id="val-angle" data-value="0.0°"></span><span class="metric-lbl">Steer</span></div></div><div class="res-container"><span class="res-lbl">LOAD</span><div class="res-track"><div class="res-fill" id="res-fill"></div></div></div></div>`;
        }
    }
    customElements.define('ble-hud', BleHud);

    // --- State & Globals ---
    // --- State & Globals ---

    class StateManager {
        constructor() {
            this._state = {
                watts: 0, smoothWatts: 0, angle: 0,
                trainerStatus: 'disconnected', sterzoStatus: 'disconnected', isControllable: false,
                trainerReportsResistance: false,
                gameStatus: 'Searching...',
                realGrade: 0, realSpeed: 0, smoothSpeed: 0,
                resistanceLevel: 0
            };
            this.hudElement = null;
        }

        initUI() {
            if (!document.querySelector('ble-hud')) {
                this.hudElement = document.createElement('ble-hud');
                document.body.appendChild(this.hudElement);
            } else {
                this.hudElement = document.querySelector('ble-hud');
            }
        }

        // Getters and Setters
        get watts() { return this._state.watts; }
        set watts(val) { this._state.watts = val; this.render(); }

        get smoothWatts() { return this._state.smoothWatts; }
        set smoothWatts(val) { this._state.smoothWatts = val; this.render(); }

        get angle() { return this._state.angle; }
        set angle(val) { this._state.angle = val; this.render(); }

        get trainerStatus() { return this._state.trainerStatus; }
        set trainerStatus(val) { this._state.trainerStatus = val; this.render(); }

        get sterzoStatus() { return this._state.sterzoStatus; }
        set sterzoStatus(val) { this._state.sterzoStatus = val; this.render(); }

        get gameStatus() { return this._state.gameStatus; }
        set gameStatus(val) { this._state.gameStatus = val; this.render(); }

        get isControllable() { return this._state.isControllable; }
        set isControllable(val) { this._state.isControllable = val; this.render(); }

        get trainerReportsResistance() { return this._state.trainerReportsResistance; }
        set trainerReportsResistance(val) { this._state.trainerReportsResistance = val; }

        get resistanceLevel() { return this._state.resistanceLevel; }
        set resistanceLevel(val) { this._state.resistanceLevel = val; this.render(); }

        get realGrade() { return this._state.realGrade; }
        set realGrade(val) { this._state.realGrade = val; this.render(); }

        get realSpeed() { return this._state.realSpeed; }
        set realSpeed(val) {
            this._state.realSpeed = val;
            this._state.smoothSpeed += (val - this._state.smoothSpeed) * CONFIG.SPEED_SMOOTHING;
            this.render();
        }

        get smoothSpeed() { return this._state.smoothSpeed; }

        render() {
            if (!this.hudElement) return;
            const s = this._state;
            const kph = s.smoothSpeed * 3.6;
            this.hudElement.setAttribute('watts', Math.round(s.smoothWatts));
            this.hudElement.setAttribute('speed', kph.toFixed(1));
            this.hudElement.setAttribute('grade', s.realGrade.toFixed(1));
            this.hudElement.setAttribute('angle', s.angle.toFixed(1));
            this.hudElement.setAttribute('resistance', Math.round(s.resistanceLevel));
            this.hudElement.setAttribute('game-status', s.gameStatus);
            this.hudElement.setAttribute('trainer-status', s.trainerStatus);
            this.hudElement.setAttribute('sterzo-status', s.sterzoStatus);
        }
    }

    // --- 2. Physics Engine (Output Logic) ---

    class PhysicsEngine {
        constructor(stateManager, trainer) {
            this.lastUpdate = 0;
            this.sm = stateManager;
            this.trainer = trainer;
        }

        /**
         * Calculates the simulation drag constant based on real physics metrics.
         * @param {number} cda - The CdA of the cyclist (m^2).
         * @param {number} massKg - Total mass of rider + bike (kg).
         * @param {number} airDensity - Air density (kg/m^3), default 1.225.
         * @returns {number} The value to assign to 'tuning.drag'.
         */
        calculateGameDrag(cda, massKg, airDensity = 1.225) {
            // tuning.drag = (0.5 * rho * CdA) / mass
            return (0.5 * airDensity * cda) / massKg;
        }

        updateTuning(player) {
            player.tuning.rollResistance = 0.02;
            player.tuning.drag = this.calculateGameDrag(CONFIG.CDA, CONFIG.SYSTEM_MASS);
            player.tuning.reverse = 0;            // Disable engine reverse force
            player.tuning.tyreFriction = 10;
            player.metrics.wheelMass = 1.5;       // Light bicycle wheels
        }

        update(timestamp) {
            if (!gameHook || !gameHook.player) return;

            this.updateTuning(gameHook.player);

            const state = this.sm;

            // 1. Calculate Grade + copy over Speed
            const pitchRadians = gameHook.player.rotation.z;
            const gradePercent = Math.tan(pitchRadians) * 100;

            // Update State
            this.sm.realGrade = gradePercent;
            this.sm.realSpeed = gameHook.player.speed;

            // Visual Estimation for UI Load Bar
            let estimatedRes = CONFIG.BASE_RESISTANCE + (gradePercent * CONFIG.GRADE_FACTOR);
            estimatedRes = Math.max(0, Math.min(200, estimatedRes));

            if (!state.trainerReportsResistance) {
                 this.sm.resistanceLevel = estimatedRes;
            }

            // Only update trainer if connected and controllable
            if (!state.isControllable) return;

            // Rate limit to prevent BLE congestion
            if (timestamp - this.lastUpdate < CONFIG.RESISTANCE_UPDATE_RATE) return;

            this.trainer.sendIncline(gradePercent);
            this.lastUpdate = timestamp;
        }
    }

    // --- 3. Virtual Gamepad (Input Logic) ---

    class VirtualGamepad {
        constructor(stateManager) {
            this.sm = stateManager;
            this.index = 0;
            this.connected = true;
            this.timestamp = 0;
            this.mapping = "standard";
            this.axes = [0, 0, 0, 0];
            this.buttons = Array(17).fill(0).map(() => ({ pressed: false, value: 0 }));
        }

        /**
         * Converts Human Wattage to Game Input Signal.
         * @param {number} humanWatts - The rider's power output (e.g., 150W to 1000W).
         * @param {number} currentSpeed - Current bike speed in m/s.
         * @param {number} riderMassKg - Total mass (Bike + Rider), usually 75-85kg.
         * @param {number} scalingFactor - Multiplier. 1.0 = Realistic. 2.0 = E-Bike/Arcade feel.
         * @returns {number} The throttle signal (0.0 to 1.0) to feed into inputs.accel.
         */
        mapWattsToThrottle(humanWatts, currentSpeed, riderMassKg = 80, scalingFactor = 1.0) {
            // 1. The Game's Physics Constraints (Must match your vehicle 'tuning')
            const GAME_MAX_ACCEL = 10;      // tuning.accel (m/s^2)
            const GAME_EASE_SPEED = 66.67;  // tuning.accelEaseSpeed
            const GAME_EASE_FACTOR = 0.75;  // tuning.accelEaseFactor

            // 2. Physical Force Calculation (F = P / v)
            // This simulates a 34T/34T gear ratio.
            // Below 2 m/s, we assume constant torque.
            const effectiveSpeed = Math.max(0.5, currentSpeed);

            // Force (Newtons) = (Watts * Scaling) / Speed
            const drivingForceNewtons = (humanWatts * scalingFactor) / effectiveSpeed;

            // 3. Convert Force to Acceleration (a = F / m)
            const requiredAccel = drivingForceNewtons / riderMassKg;

            // 4. Game Engine Efficiency Check
            // The engine dampens inputs at low speeds; we calculate this efficiency
            // so we can normalize against it.
            let speedRatio = currentSpeed / GAME_EASE_SPEED;
            if (speedRatio > 1) speedRatio = 1;
            const efficiency = GAME_EASE_FACTOR + (speedRatio * (1 - GAME_EASE_FACTOR));

            // 5. Map Acceleration to Input Signal (0.0 - 1.0)
            // Signal = TargetAccel / (MaxPossibleAccel * Efficiency)
            const signal = requiredAccel / (GAME_MAX_ACCEL * efficiency);

            return Math.max(0, Math.min(1, signal));
        }

        update() {
            this.timestamp = performance.now();
            const state = this.sm;

            // 1. Steering Mapping
            let rawAngle = state.angle;
            let absAngle = Math.abs(rawAngle);
            let steerOutput = 0;

            if (absAngle > CONFIG.STEERING_DEADBAND) {
                const activeRange = CONFIG.MAX_STEER_ANGLE - CONFIG.STEERING_DEADBAND;
                const adjustedAngle = absAngle - CONFIG.STEERING_DEADBAND;
                const ratio = adjustedAngle / activeRange;
                steerOutput = Math.max(-1, Math.min(1, ratio)) * Math.sign(rawAngle);
            }
            this.axes[0] = steerOutput;

            // 2. Throttle Mapping
            state.smoothWatts += (state.watts - state.smoothWatts) * CONFIG.SMOOTHING;

            const throttleNorm = this.mapWattsToThrottle(state.smoothWatts, state.realSpeed, CONFIG.SYSTEM_MASS, CONFIG.SCALING_FACTOR)

            this.buttons[7].value = throttleNorm > 0.05 ? throttleNorm : 0;
            this.buttons[7].pressed = throttleNorm > 0.05;

            // 3. Update Physics Engine
            physicsEngine.update(this.timestamp);
        }
    }

    // --- 4. Scene Graph & Loop Coordinator ---

    class GameHook {
        constructor(stateManager) {
            this.sm = stateManager;
            this.scene = null;
            this.player = null;
            this.lastPos = null;
            this.lastTime = 0;
            this.knownNames = new Set(['coupe', 'bike', 'coach', 'bus', 'truck']);
        }

        init() {
            console.log("🕵️ Scene Sniffer: Initializing...");
            this.hookDevTools();
            this.hijackRAF();
        }

        hookDevTools() {
            if (typeof unsafeWindow.__THREE_DEVTOOLS__ !== 'undefined') {
                try {
                    const { objects } = unsafeWindow.__THREE_DEVTOOLS__;
                    const sceneDef = [...(objects?.values() ?? [])].find((obj) => obj.isScene);
                    if (sceneDef && sceneDef.uuid) {
                        const scene = unsafeWindow.__THREE_DEVTOOLS__.utils.findObjectInScenes(sceneDef.uuid);
                        this.foundScene(scene);
                        return;
                    }
                } catch(e) { console.warn("DevTools scan fail", e); }
            }
            setTimeout(() => this.hookDevTools(), 1000);
        }

        hijackRAF() {
            const originalRAF = unsafeWindow.requestAnimationFrame;
            unsafeWindow.requestAnimationFrame = (callback) => {

                // 1. Maintain Link
                if (this.scene && !this.player) this.findPlayer();

                return originalRAF(callback);
            };
        }

        foundScene(scene) {
            this.scene = scene;
            this.sm.gameStatus = "Linked";
        }

        traverseObjectTree( rootObject, callback, skipDuplicates = false ) {
            const processedUUIDs = skipDuplicates ? new Set() : null;
            function traverse( object ) {
                if ( ! object || ! object.uuid ) return;
                if ( object.name === '__THREE_DEVTOOLS_HIGHLIGHT__' ) return;
                if ( processedUUIDs && processedUUIDs.has( object.uuid ) ) return;
                if ( processedUUIDs ) processedUUIDs.add( object.uuid );
                callback( object );
                if ( object.children && Array.isArray( object.children ) ) {
                    object.children.forEach( child => traverse( child ) );
                }
            }
            traverse( rootObject );
        }

        findPlayer() {
            if (!this.scene) return;
            this.traverseObjectTree(this.scene, (obj) => {
                if (this.knownNames.has(obj.type)) {
                    this.player = obj;
                    this.sm.gameStatus = `Linked: ${obj.type}`;
                }
            });
        }
    }
    // --- 5. BLE Logic ---

    class TrainerController {
        constructor(stateManager) {
            this.sm = stateManager;
            this.controlChar = null;
        }

        async connect() {
            try {
                this.sm.trainerStatus = 'connecting';
                const device = await navigator.bluetooth.requestDevice({
                    filters: [{ services: [CONFIG.FTMS_SERVICE] }],
                    optionalServices: [CONFIG.CPS_SERVICE]
                });
                const server = await device.gatt.connect();

                try {
                    const service = await server.getPrimaryService(CONFIG.FTMS_SERVICE);

                    const [controlChar, dataChar] = await Promise.all([
                        service.getCharacteristic(CONFIG.FTMS_CONTROL),
                        service.getCharacteristic(CONFIG.FTMS_DATA)
                    ]);

                    this.controlChar = controlChar;
                    try {
                        await this.controlChar.writeValue(new Uint8Array([0x00])); // Request Control
                        this.sm.isControllable = true;
                    } catch(e) { console.log("Control Point fail", e); }

                    await dataChar.startNotifications();
                    dataChar.addEventListener('characteristicvaluechanged', (e) => this.handleFtmsData(e.target.value));

                } catch (e) {
                    console.log("Falling back to CPS");
                    const service = await server.getPrimaryService(CONFIG.CPS_SERVICE);
                    const char = await service.getCharacteristic(CONFIG.CPS_MEASUREMENT);
                    await char.startNotifications();
                    char.addEventListener('characteristicvaluechanged', (e) => {
                        this.sm.watts = e.target.value.getInt16(2, true);
                    });
                }

                device.addEventListener('gattserverdisconnected', () => {
                    this.sm.trainerStatus = 'disconnected';
                    this.sm.isControllable = false;
                });
                this.sm.trainerStatus = 'connected';
            } catch (e) {
                console.error(e);
                this.sm.trainerStatus = 'disconnected';
            }
        }

        handleFtmsData(val) {
             const flags = val.getUint16(0, true);
             let offset = 2; // Flags is 2 bytes

             // Flag 0: Inst Speed (uint16)
             if (flags & (1 << 0)) offset += 2;
             // Flag 1: Avg Speed (uint16)
             if (flags & (1 << 1)) offset += 2;
             // Flag 2: Inst Cadence (uint16)
             if (flags & (1 << 2)) offset += 2;
             // Flag 3: Avg Cadence (uint16)
             if (flags & (1 << 3)) offset += 2;
             // Flag 4: Total Distance (uint24)
             if (flags & (1 << 4)) offset += 3;
             // Flag 5: Resistance Level (sint16)
             if (flags & (1 << 5)) {
                 this.sm.resistanceLevel = val.getInt16(offset, true);
                 this.sm.trainerReportsResistance = true;
                 offset += 2;
             }
             // Flag 6: Inst Power (sint16)
             if (flags & (1 << 6)) {
                 this.sm.watts = val.getInt16(offset, true);
             }
        }

        async sendIncline(grade) {
            if (!this.controlChar) return;
            try {
                const clamped = Math.max(-25, Math.min(40, grade));
                const value = Math.round(clamped * 10);
                const buffer = new ArrayBuffer(3);
                const view = new DataView(buffer);
                view.setUint8(0, 0x11);
                view.setInt16(1, value, true);
                await this.controlChar.writeValue(buffer);
            } catch (e) { console.warn("BLE Write Fail", e); }
        }
    }

    class SterzoController {
        constructor(stateManager) {
            this.sm = stateManager;
        }

        calculateResponseCode(challenge) {
            const n = challenge % 11;
            const m = ((challenge << n) | (challenge >> (16 - n))) % 65536;
            const x = ((challenge + 38550) ^ m) % 65536;
            return x % 65336;
        }

        async connect() {
             try {
                this.sm.sterzoStatus = 'connecting';
                const device = await navigator.bluetooth.requestDevice({
                    filters: [{ services: [CONFIG.STERZO_SERVICE] }]
                });
                const server = await device.gatt.connect();
                const service = await server.getPrimaryService(CONFIG.STERZO_SERVICE);

                const [cpChar, challengeChar, steeringChar] = await Promise.all([
                     service.getCharacteristic(CONFIG.STERZO_CP),
                     service.getCharacteristic(CONFIG.STERZO_CHALLENGE),
                     service.getCharacteristic(CONFIG.STERZO_STEERING)
                ]);

                console.log("Sterzo: Characteristics found. Starting Handshake...");

                await this.performHandshake(cpChar, challengeChar);

                console.log("Sterzo: Handshake complete. Subscribing to Steering...");

                await steeringChar.startNotifications();
                steeringChar.addEventListener('characteristicvaluechanged', (e) => {
                    if (e.target.value.byteLength >= 4) {
                         this.sm.angle = e.target.value.getFloat32(0, true);
                    }
                });

                device.addEventListener('gattserverdisconnected', () => {
                    this.sm.sterzoStatus = 'disconnected';
                });

                this.sm.sterzoStatus = 'connected';
            } catch(e) {
                console.error("Sterzo Connection Failed", e);
                this.sm.sterzoStatus = 'disconnected';
            }
        }

        async performHandshake(cpChar, challengeChar) {
            return new Promise((resolve, reject) => {
                let stage = 'challenge';
                const onValue = async (e) => {
                    const val = e.target.value;
                    if (val.byteLength < 2) return;
                    const opCode = val.getUint16(0, true);

                    if (stage === 'challenge') {
                        if (opCode === CONFIG.STERZO_OP_CHALLENGE && val.byteLength >= 4) {
                             const challenge = val.getUint16(2, true);
                             console.log(`Sterzo: Challenge Received. Op: ${opCode.toString(16)}, Ch: ${challenge}`);

                             const response = this.calculateResponseCode(challenge);
                             await new Promise(r => setTimeout(r, 500));

                             console.log(`Sterzo: Sending Response: ${response}`);
                             const buffer = new ArrayBuffer(4);
                             const view = new DataView(buffer);
                             view.setUint8(0, 0x03);
                             view.setUint8(1, 0x11);
                             view.setUint16(2, response, true);
                             await cpChar.writeValue(buffer);
                             stage = 'finished';
                        }
                    } else if (stage === 'finished') {
                        if (opCode === CONFIG.STERZO_OP_RESPONSE && val.byteLength >= 3) {
                             const status = val.getUint8(2);
                             console.log(`Sterzo: Finished Received. Status: ${status.toString(16)}`);

                             if (status === 0xFF || status === 0xFE) {
                                 if (status === 0xFE) {
                                     reject(new Error("Sterzo Handshake Rejected"));
                                 }
                                 challengeChar.stopNotifications();
                                 challengeChar.removeEventListener('characteristicvaluechanged', onValue);
                                 if (status === 0xFF) resolve();
                             }
                        }
                    }
                };

                challengeChar.startNotifications().then(async () => {
                    challengeChar.addEventListener('characteristicvaluechanged', onValue);
                    await new Promise(r => setTimeout(r, 500));
                    return cpChar.writeValue(new Uint8Array([0x03, 0x10]));
                }).catch(reject);
            });
        }
    }

    // --- 6. Initialization ---

    const originalGetGamepads = navigator.getGamepads.bind(navigator);
    const stateManager = new StateManager();
    const vPad = new VirtualGamepad(stateManager);
    let isActive = false;

    // Instantiate classes
    const gameHook = new GameHook(stateManager);

    // Create Controllers
    const trainerController = new TrainerController(stateManager);
    const sterzoController = new SterzoController(stateManager);
    const physicsEngine = new PhysicsEngine(stateManager, trainerController);

    // Update Init Logic to use classes
    function initUI() {
        stateManager.initUI();
        if (stateManager.hudElement) {
             const el = stateManager.hudElement;
             el.addEventListener('pair-trainer', () => trainerController.connect());
             el.addEventListener('pair-sterzo', () => sterzoController.connect());
        }
        window.addEventListener('keydown', handleDebugInput);
    }

    function handleDebugInput(e) {
        // Only allow manual overrides if no trainer is connected
         const s = stateManager;
        if (s.trainerStatus === 'connected') return;

        if (e.key === '=' || e.key === '+') {
            stateManager.watts = s.watts + 20;
        } else if (e.key === '-' || e.key === '_') {
            stateManager.watts = Math.max(0, s.watts - 20);
        }
    }

    navigator.getGamepads = function() {
        if (!isActive) return originalGetGamepads();
        vPad.update();
        const pads = Array.from(originalGetGamepads());
        pads[0] = vPad;
        return pads;
    };

    function enableProxy() {
        if (isActive) return;
        isActive = true;
        initUI();

        if (typeof THREE === 'undefined') {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.155.0/three.min.js';
            script.onload = () => gameHook.init();
            document.head.appendChild(script);
        } else {
            gameHook.init();
        }
        window.dispatchEvent(new Event('gamepadconnected'));
    }

    enableProxy();

})();
