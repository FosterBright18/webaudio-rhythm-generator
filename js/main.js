import { AudioAnalyzer } from "./audioAnalyzer.js";
import { BeatmapGenerator } from "./beatmapGenerator.js";
import { InputHandler } from "./inputHandler.js";
import { Renderer } from "./renderer.js";

/**
 * Coordinates AudioAnalyzer, BeatmapGenerator, Hit Windows, JSON I/O, and HUD.
 */
export class GameEngine {
  constructor() {
    this.audio = new AudioAnalyzer();
    this.renderer = new Renderer(document.getElementById("gameCanvas"));
    this.input = new InputHandler(
      (lane) => this.handleLaneHit(lane),
      () => {},
      () => this.togglePlayPause(),
      () => this.restartChart()
    );

    this.WINDOWS = {
      PERFECT: 0.035,
      GREAT: 0.075,
      GOOD: 0.120
    };

    this.notes = [];
    this.bpm = 120;
    this.scrollSpeed = 640;
    this.audioOffsetMs = 0;
    this.autoplay = false;

    this.resetStats();
    this.bindUI();

    this.lastFrameTime = performance.now();
    this.fpsSmooth = 60;
    this.activeNoteCount = 0;

    requestAnimationFrame((t) => this.loop(t));
  }

  resetStats() {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
    this.hitOffsetsMs = [];
    this.recentErrorTicks = [];
    this.updateScoreboardDOM();
  }

  bindUI() {
    const btnDemo = document.getElementById("btnDemoTrack");
    const audioInput = document.getElementById("audioFileInput");
    const dropZone = document.getElementById("dropZone");
    const btnPlayPause = document.getElementById("btnPlayPause");
    const btnRestart = document.getElementById("btnRestart");
    const btnAutoplay = document.getElementById("btnAutoplay");
    const btnRegen = document.getElementById("btnRegenerate");
    const btnExport = document.getElementById("btnExportJson");
    const jsonInput = document.getElementById("jsonFileInput");

    const drawer = document.getElementById("settingsDrawer");
    const backdrop = document.getElementById("drawerBackdrop");
    const toggleDrawer = (open) => {
      drawer.classList.toggle("open", open);
      backdrop.classList.toggle("open", open);
    };
    document.getElementById("btnOpenSettings").addEventListener("click", () => toggleDrawer(true));
    document.getElementById("btnCloseSettings").addEventListener("click", () => toggleDrawer(false));
    backdrop.addEventListener("click", () => toggleDrawer(false));

    const canvas = document.getElementById("gameCanvas");
    canvas.addEventListener("pointerdown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const hwWidth = Math.min(440, rect.width * 0.86);
      const hwLeft = (rect.width - hwWidth) / 2;
      if (x >= hwLeft && x <= hwLeft + hwWidth) {
        const lane = Math.min(3, Math.floor(((x - hwLeft) / hwWidth) * 4));
        this.handleLaneHit(lane);
      }
    });

    btnDemo.addEventListener("click", async () => {
      btnDemo.disabled = true;
      btnDemo.textContent = "Loading...";
      await this.audio.generateProceduralDemoTrack();
      this.rebuildBeatmap();
      btnDemo.textContent = "Demo Song";
      btnDemo.disabled = false;
      this.restartChart(true);
    });

    audioInput.addEventListener("change", async (e) => {
      if (e.target.files[0]) {
        await this.loadAudioFile(e.target.files[0]);
        toggleDrawer(false);
      }
    });

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      if (e.dataTransfer.files[0]) {
        await this.loadAudioFile(e.dataTransfer.files[0]);
        toggleDrawer(false);
      }
    });

    btnPlayPause.addEventListener("click", () => this.togglePlayPause());
    btnRestart.addEventListener("click", () => this.restartChart(true));

    btnAutoplay.addEventListener("click", () => {
      this.autoplay = !this.autoplay;
      btnAutoplay.textContent = this.autoplay ? "Autoplay: On" : "Autoplay: Off";
      btnAutoplay.classList.toggle("btn-primary", this.autoplay);
    });

    const sSens = document.getElementById("sliderSensitivity");
    const sSpace = document.getElementById("sliderSpacing");
    const sScroll = document.getElementById("sliderScroll");
    const sOffset = document.getElementById("sliderOffset");

    sSens.addEventListener("input", () => {
      document.getElementById("valSensitivity").textContent = Number(sSens.value).toFixed(2);
    });
    sSpace.addEventListener("input", () => {
      document.getElementById("valSpacing").textContent = `${sSpace.value} ms`;
    });
    sScroll.addEventListener("input", () => {
      this.scrollSpeed = Number(sScroll.value);
      document.getElementById("valScroll").textContent = `${sScroll.value} px/s`;
    });
    sOffset.addEventListener("input", () => {
      this.audioOffsetMs = Number(sOffset.value);
      document.getElementById("valOffset").textContent = `${sOffset.value} ms`;
    });

    document.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const preset = btn.dataset.preset;
        if (preset === "easy") {
          sSens.value = "1.75"; sSpace.value = "240";
        } else if (preset === "normal") {
          sSens.value = "1.40"; sSpace.value = "180";
        } else if (preset === "hard") {
          sSens.value = "1.05"; sSpace.value = "130";
        }
        sSens.dispatchEvent(new Event("input"));
        sSpace.dispatchEvent(new Event("input"));
        if (this.audio.audioBuffer) this.rebuildBeatmap();
      });
    });

    btnRegen.addEventListener("click", () => {
      if (this.audio.audioBuffer) this.rebuildBeatmap();
    });

    btnExport.addEventListener("click", () => this.exportBeatmapJson());
    jsonInput.addEventListener("change", (e) => {
      if (e.target.files[0]) this.importBeatmapJson(e.target.files[0]);
    });
  }

  async loadAudioFile(file) {
    document.getElementById("trackStatus").textContent = `Loading ${file.name}...`;
    try {
      await this.audio.decodeFile(file);
      this.rebuildBeatmap();
      this.restartChart(true);
    } catch (err) {
      document.getElementById("trackStatus").textContent = "Could not load audio file.";
    }
  }

  rebuildBeatmap() {
    if (!this.audio.audioBuffer) return;
    const sensitivity = Number(document.getElementById("sliderSensitivity").value);
    const minSpacingMs = Number(document.getElementById("sliderSpacing").value);

    const result = BeatmapGenerator.analyzeAndGenerate(this.audio.audioBuffer, {
      sensitivity,
      minSpacingMs
    });

    this.notes = result.notes;
    this.bpm = result.bpm;
    this.resetStats();

    document.getElementById("trackStatus").textContent = this.audio.trackTitle;
    document.getElementById("bpmBadge").textContent = `~${this.bpm} BPM`;
    document.getElementById("hudTotalNotes").textContent = this.notes.length;
    document.getElementById("btnPlayPause").disabled = false;
    document.getElementById("btnRestart").disabled = false;
    document.getElementById("btnRegenerate").disabled = false;
    document.getElementById("btnExportJson").disabled = false;
  }

  togglePlayPause() {
    if (!this.audio.audioBuffer) return;
    const btn = document.getElementById("btnPlayPause");
    if (this.audio.isPlaying) {
      this.audio.pause();
      btn.textContent = "Play";
    } else {
      this.audio.play(() => {
        btn.textContent = "Play";
      });
      btn.textContent = "Pause";
    }
  }

  restartChart(autoPlay = false) {
    if (!this.audio.audioBuffer) return;
    this.audio.stop();
    for (const n of this.notes) {
      n.hit = false;
      n.missed = false;
    }
    this.resetStats();
    const btn = document.getElementById("btnPlayPause");
    if (autoPlay) {
      this.audio.play(() => {
        btn.textContent = "Play";
      });
      btn.textContent = "Pause";
    } else {
      btn.textContent = "Play";
    }
  }

  getCalibratedSongTime() {
    return this.audio.getSongTime() + this.audioOffsetMs / 1000;
  }

  handleLaneHit(lane) {
    this.renderer.triggerLaneFlash(lane, false);
    if (!this.audio.isPlaying) return;

    const now = this.getCalibratedSongTime();
    let bestNote = null;
    let bestAbsDiff = Infinity;

    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.lane !== lane || note.hit || note.missed) continue;
      const diff = now - note.time;
      const absDiff = Math.abs(diff);
      if (absDiff <= this.WINDOWS.GOOD && absDiff < bestAbsDiff) {
        bestAbsDiff = absDiff;
        bestNote = note;
      }
    }

    if (!bestNote) return;

    bestNote.hit = true;
    const offsetMs = (now - bestNote.time) * 1000;
    this.hitOffsetsMs.push(offsetMs);

    let judgment = "Good";
    let jColor = "#f59e0b";
    let points = 100;

    if (bestAbsDiff <= this.WINDOWS.PERFECT) {
      judgment = "Perfect";
      jColor = "#6366f1";
      points = 300;
    } else if (bestAbsDiff <= this.WINDOWS.GREAT) {
      judgment = "Great";
      jColor = "#10b981";
      points = 200;
    }

    const key = judgment.toUpperCase();
    this.counts[key]++;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    this.score += points * (1 + Math.floor(this.combo / 10) * 0.1);

    this.recentErrorTicks.push({ offsetMs, color: jColor });
    if (this.recentErrorTicks.length > 20) this.recentErrorTicks.shift();

    this.renderer.triggerLaneFlash(lane, true);
    this.renderer.triggerJudgment(judgment, offsetMs, jColor);
    this.updateScoreboardDOM();
  }

  updateGameplayLogic() {
    if (!this.audio.isPlaying) return;
    const now = this.getCalibratedSongTime();

    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.hit || note.missed) continue;

      if (this.autoplay && now >= note.time) {
        this.handleAutoplayNote(note);
        continue;
      }

      if (now - note.time > this.WINDOWS.GOOD) {
        note.missed = true;
        this.counts.MISS++;
        this.combo = 0;
        this.renderer.triggerJudgment("Miss", null, "#ef4444");
        this.updateScoreboardDOM();
      }
    }
  }

  handleAutoplayNote(note) {
    note.hit = true;
    this.counts.PERFECT++;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    this.score += 300 * (1 + Math.floor(this.combo / 10) * 0.1);
    this.hitOffsetsMs.push(0);
    this.recentErrorTicks.push({ offsetMs: 0, color: "#6366f1" });
    if (this.recentErrorTicks.length > 20) this.recentErrorTicks.shift();

    this.renderer.triggerLaneFlash(note.lane, true);
    this.renderer.triggerJudgment("Perfect", 0, "#6366f1");
    this.updateScoreboardDOM();
  }

  updateScoreboardDOM() {
    const totalEvaluated =
      this.counts.PERFECT + this.counts.GREAT + this.counts.GOOD + this.counts.MISS;

    const weighted =
      this.counts.PERFECT * 1.0 +
      this.counts.GREAT * 0.7 +
      this.counts.GOOD * 0.35;

    const acc = totalEvaluated > 0 ? (weighted / totalEvaluated) * 100 : 100;

    let rank = "S+";
    if (acc < 98) rank = "S";
    if (acc < 94) rank = "A";
    if (acc < 86) rank = "B";
    if (acc < 75) rank = "C";

    const meanErr =
      this.hitOffsetsMs.length > 0
        ? this.hitOffsetsMs.reduce((a, b) => a + b, 0) / this.hitOffsetsMs.length
        : 0;

    document.getElementById("statScore").textContent = Math.round(this.score).toLocaleString();
    document.getElementById("statAccuracy").innerHTML = `${acc.toFixed(1)}% · <span id="gradeBadge">${rank}</span>`;
    document.getElementById("statCombo").textContent = this.maxCombo;

    document.getElementById("countPerfect").textContent = this.counts.PERFECT;
    document.getElementById("countGreat").textContent = this.counts.GREAT;
    document.getElementById("countGood").textContent = this.counts.GOOD;
    document.getElementById("countMiss").textContent = this.counts.MISS;
    document.getElementById("hudMeanOffset").textContent = `${meanErr >= 0 ? "+" : ""}${meanErr.toFixed(1)} ms`;
  }

  exportBeatmapJson() {
    if (!this.notes.length) return;
    const payload = {
      schemaVersion: "1.0",
      title: this.audio.trackTitle,
      estimatedBpm: this.bpm,
      audioOffsetMs: this.audioOffsetMs,
      generatedAt: new Date().toISOString(),
      noteCount: this.notes.length,
      notes: this.notes.map(n => ({ time: n.time, lane: n.lane }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.audio.trackTitle.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_beatmap.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async importBeatmapJson(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.notes)) throw new Error("Invalid schema");
      this.notes = data.notes.map(n => ({
        time: Number(n.time),
        lane: Number(n.lane) % 4,
        hit: false,
        missed: false
      }));
      if (data.estimatedBpm) {
        this.bpm = data.estimatedBpm;
        document.getElementById("bpmBadge").textContent = `~${this.bpm} BPM`;
      }
      document.getElementById("hudTotalNotes").textContent = this.notes.length;
      this.resetStats();
    } catch (err) {
      alert("Could not parse Beatmap JSON file.");
    }
  }

  loop(nowPerf) {
    const dt = Math.max(1, nowPerf - this.lastFrameTime);
    this.lastFrameTime = nowPerf;
    const instFps = 1000 / dt;
    this.fpsSmooth = this.fpsSmooth * 0.92 + instFps * 0.08;

    this.updateGameplayLogic();

    const songTime = this.getCalibratedSongTime();
    const freqData = this.audio.getFrequencyData();

    this.renderer.render({
      freqData,
      notes: this.notes,
      songTime,
      scrollSpeed: this.scrollSpeed,
      lanePressed: this.input.lanePressed,
      combo: this.combo,
      hitErrors: this.recentErrorTicks,
      activeNoteCountOut: (count) => {
        this.activeNoteCount = count;
      }
    });

    document.getElementById("hudFps").textContent = `${Math.round(this.fpsSmooth)} FPS`;
    document.getElementById("hudAudioClock").textContent =
      `${(this.audio.ctx ? this.audio.ctx.currentTime : 0).toFixed(2)} s`;
    const totalDur = this.audio.audioBuffer ? this.audio.audioBuffer.duration : 0;
    document.getElementById("hudSongTime").textContent =
      `${Math.max(0, songTime).toFixed(1)} / ${totalDur.toFixed(1)} s`;
    document.getElementById("hudActiveNotes").textContent = this.activeNoteCount;

    requestAnimationFrame((t) => this.loop(t));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new GameEngine();
});