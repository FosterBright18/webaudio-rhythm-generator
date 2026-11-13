/**
 * Handles Web Audio API decoding, procedural OfflineAudioContext synthesis,
 * real-time AnalyserNode FFT extraction, and drift-free hardware clock tracking.
 */
export class AudioAnalyzer {
  constructor() {
    this.ctx = null;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.analyser = null;
    this.gainNode = null;

    this.isPlaying = false;
    this.startCtxTime = 0;
    this.pauseOffset = 0;
    this.trackTitle = "None";

    this.fftSize = 1024;
    this.freqData = new Uint8Array(this.fftSize / 2);
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = 0.82;

      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 0.85;
      this.analyser.connect(this.gainNode);
      this.gainNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  async decodeFile(file) {
    this.ensureContext();
    this.stop();
    const arrayBuffer = await file.arrayBuffer();
    this.audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.trackTitle = file.name.replace(/\.[^/.]+$/, "");
    this.pauseOffset = 0;
    return this.audioBuffer;
  }

  async generateProceduralDemoTrack() {
    this.ensureContext();
    this.stop();

    const sampleRate = 44100;
    const bpm = 120;
    const duration = 28.0;
    const offline = new OfflineAudioContext(2, sampleRate * duration, sampleRate);

    const beatSec = 60 / bpm;
    const sixteenth = beatSec / 4;
    const totalSixteenths = Math.floor(duration / sixteenth);

    const noiseBuf = offline.createBuffer(1, sampleRate * 0.5, sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) {
      noiseData[i] = Math.random() * 2 - 1;
    }

    const chords = [
      [174.61, 220.00, 261.63, 329.63],
      [196.00, 246.94, 293.66, 329.63],
      [164.81, 196.00, 246.94, 293.66],
      [220.00, 261.63, 329.63, 392.00]
    ];

    for (let step = 0; step < totalSixteenths; step++) {
      const t = step * sixteenth;
      const barStep = step % 16;
      const barIndex = Math.floor(step / 16);
      const chord = chords[barIndex % 4];

      // Lane 1: Warm Sub/Bass Pulse
      if (barStep === 0 || barStep === 8) {
        const osc = offline.createOscillator();
        const gain = offline.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(125, t);
        osc.frequency.exponentialRampToValueAtTime(48, t + 0.16);
        gain.gain.setValueAtTime(0.85, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        osc.connect(gain);
        gain.connect(offline.destination);
        osc.start(t);
        osc.stop(t + 0.25);
      }

      // Lane 2: Warm Low-Mid Chord
      if (barStep === 4 || barStep === 12) {
        const osc = offline.createOscillator();
        const gain = offline.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(chord[1] * 1.5, t);
        gain.gain.setValueAtTime(0.65, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
        osc.connect(gain);
        gain.connect(offline.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      }

      // Lane 3: Piano Melody Notes
      if (barStep === 2 || barStep === 6 || barStep === 10 || barStep === 14) {
        const osc = offline.createOscillator();
        const gain = offline.createGain();
        const noteFreq = chord[(step + barIndex) % 4] * 4;
        osc.type = "sine";
        osc.frequency.setValueAtTime(noteFreq, t);
        gain.gain.setValueAtTime(0.5, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.connect(gain);
        gain.connect(offline.destination);
        osc.start(t);
        osc.stop(t + 0.16);
      }

      // Lane 4: Crisp High Accent
      if (barStep === 15 || (barIndex % 2 === 1 && barStep === 7)) {
        const hSrc = offline.createBufferSource();
        hSrc.buffer = noiseBuf;
        const hp = offline.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(5200, t);
        const hGain = offline.createGain();
        hGain.gain.setValueAtTime(0.42, t);
        hGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
        hSrc.connect(hp);
        hp.connect(hGain);
        hGain.connect(offline.destination);
        hSrc.start(t);
        hSrc.stop(t + 0.07);
      }
    }

    this.audioBuffer = await offline.startRendering();
    this.trackTitle = "Daylight Piano Etude (120 BPM)";
    this.pauseOffset = 0;
    return this.audioBuffer;
  }

  play(onEndedCallback) {
    if (!this.audioBuffer) return;
    this.ensureContext();
    if (this.isPlaying) return;

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.analyser);

    this.startCtxTime = this.ctx.currentTime - this.pauseOffset;
    this.sourceNode.start(0, this.pauseOffset);
    this.isPlaying = true;

    this.sourceNode.onended = () => {
      if (this.isPlaying && this.getSongTime() >= this.audioBuffer.duration - 0.05) {
        this.isPlaying = false;
        this.pauseOffset = 0;
        if (onEndedCallback) onEndedCallback();
      }
    };
  }

  pause() {
    if (!this.isPlaying || !this.sourceNode) return;
    this.pauseOffset = this.ctx.currentTime - this.startCtxTime;
    this.sourceNode.onended = null;
    try {
      this.sourceNode.stop();
    } catch (e) {}
    this.sourceNode.disconnect();
    this.sourceNode = null;
    this.isPlaying = false;
  }

  stop() {
    this.pause();
    this.pauseOffset = 0;
  }

  getSongTime() {
    if (!this.audioBuffer) return 0;
    if (this.isPlaying && this.ctx) {
      return Math.min(this.audioBuffer.duration, this.ctx.currentTime - this.startCtxTime);
    }
    return this.pauseOffset;
  }

  getFrequencyData() {
    if (this.analyser && this.isPlaying) {
      this.analyser.getByteFrequencyData(this.freqData);
    } else {
      this.freqData.fill(0);
    }
    return this.freqData;
  }
}