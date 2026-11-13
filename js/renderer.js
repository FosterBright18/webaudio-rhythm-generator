/**
 * Renders the 60FPS Piano Tiles highway, dynamic anti-overlap tile clamping,
 * ambient FFT spectrum bars, hit ripples, and Futura typography.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.laneKeys = ["1", "2", "3", "4"];
    this.laneAccents = ["#6366f1", "#ec4899", "#8b5cf6", "#14b8a6"];
    this.laneFlashes = [0, 0, 0, 0];
    this.ripples = [];
    this.judgmentBanner = { text: "", subtext: "", color: "#1e293b", alpha: 0, yOffset: 0 };
    this.fontStack = "'Futura', 'Futura PT', 'Avenir Next', 'Avenir', 'Century Gothic', sans-serif";

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  triggerLaneFlash(lane, spawnRipple = false) {
    this.laneFlashes[lane] = 1.0;
    if (spawnRipple) {
      const hwWidth = Math.min(440, this.width * 0.86);
      const hwLeft = (this.width - hwWidth) / 2;
      const laneW = hwWidth / 4;
      const cx = hwLeft + lane * laneW + laneW / 2;
      const cy = this.height * 0.83;

      this.ripples.push({
        x: cx,
        y: cy,
        radius: 12,
        maxRadius: laneW * 0.82,
        alpha: 0.6,
        color: this.laneAccents[lane]
      });
    }
  }

  triggerJudgment(text, offsetMs, color) {
    const sign = offsetMs > 0 ? "+" : "";
    const subtext = offsetMs !== null ? `${sign}${Math.round(offsetMs)} ms` : "";
    this.judgmentBanner = { text, subtext, color, alpha: 1.0, yOffset: 8 };
  }

  render(state) {
    const {
      freqData,
      notes,
      songTime,
      scrollSpeed,
      lanePressed,
      combo,
      hitErrors,
      activeNoteCountOut
    } = state;

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    // 1. Soft Ambient Spectrum
    this.drawSoftSpectrum(ctx, w, h, freqData);

    // 2. Piano Tiles 4-Column Board
    const hwWidth = Math.min(440, this.width * 0.86);
    const hwLeft = (w - hwWidth) / 2;
    const laneW = hwWidth / 4;
    const receptorY = h * 0.83;

    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.fillRect(hwLeft, 0, hwWidth, h);

    ctx.strokeStyle = "rgba(30, 41, 59, 0.11)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hwLeft, 0);
    ctx.lineTo(hwLeft, h);
    ctx.moveTo(hwLeft + hwWidth, 0);
    ctx.lineTo(hwLeft + hwWidth, h);
    ctx.stroke();

    for (let i = 0; i < 4; i++) {
      const lx = hwLeft + i * laneW;
      if (i > 0) {
        ctx.strokeStyle = "rgba(30, 41, 59, 0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx, h);
        ctx.stroke();
      }

      if (this.laneFlashes[i] > 0.01 || lanePressed[i]) {
        const intensity = Math.max(this.laneFlashes[i], lanePressed[i] ? 0.45 : 0);
        const grad = ctx.createLinearGradient(0, h, 0, receptorY - 260);
        grad.addColorStop(0, this.hexToRgba(this.laneAccents[i], intensity * 0.22));
        grad.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(lx, 0, laneW, h);
        this.laneFlashes[i] *= 0.88;
      }
    }

    // 3. Strike Line & 1, 2, 3, 4 Labels
    ctx.strokeStyle = "rgba(30, 41, 59, 0.24)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hwLeft, receptorY);
    ctx.lineTo(hwLeft + hwWidth, receptorY);
    ctx.stroke();

    for (let i = 0; i < 4; i++) {
      const lx = hwLeft + i * laneW;
      const active = lanePressed[i];

      ctx.fillStyle = active ? this.laneAccents[i] : "rgba(100, 116, 139, 0.55)";
      ctx.font = `700 15px ${this.fontStack}`;
      ctx.textAlign = "center";
      ctx.fillText(this.laneKeys[i], lx + laneW / 2, receptorY + 36);
    }

    // 4. Rounded Piano Tiles with Automatic Anti-Overlap Height Clamping
    let activeNotes = 0;
    const defaultTileHeight = 76;
    const minVerticalGapPx = 14;
    const tilePadX = 8;

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      if (note.hit) continue;

      const timeDiff = note.time - songTime;
      const bottomY = receptorY - timeDiff * scrollSpeed;

      let tileHeight = defaultTileHeight;
      if (i + 1 < notes.length) {
        const nextDt = notes[i + 1].time - note.time;
        const pixelDistToNext = nextDt * scrollSpeed;
        tileHeight = Math.max(28, Math.min(defaultTileHeight, pixelDistToNext - minVerticalGapPx));
      }

      const topY = bottomY - tileHeight;
      if (bottomY < -20 || topY > h + 20) continue;
      activeNotes++;

      const lx = hwLeft + note.lane * laneW;

      ctx.save();
      if (note.missed) {
        ctx.fillStyle = "rgba(239, 68, 68, 0.35)";
      } else {
        ctx.fillStyle = "#1e293b";
        ctx.shadowColor = "rgba(15, 23, 42, 0.14)";
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 3;
      }

      ctx.beginPath();
      ctx.roundRect(lx + tilePadX, topY, laneW - tilePadX * 2, tileHeight, 12);
      ctx.fill();

      if (!note.missed) {
        ctx.fillStyle = this.laneAccents[note.lane];
        ctx.beginPath();
        ctx.roundRect(lx + tilePadX + 12, bottomY - 7, laneW - (tilePadX + 12) * 2, 3.5, 2);
        ctx.fill();
      }
      ctx.restore();
    }
    activeNoteCountOut(activeNotes);

    // 5. Hit Ripples
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.radius += (r.maxRadius - r.radius) * 0.18;
      r.alpha *= 0.88;
      if (r.alpha < 0.02) {
        this.ripples.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = this.hexToRgba(r.color, r.alpha);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 6. Combo & Judgment Text in Futura
    if (combo > 1) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.font = `700 46px ${this.fontStack}`;
      ctx.fillStyle = "rgba(30, 41, 59, 0.11)";
      ctx.fillText(combo, w / 2, h * 0.28);
      ctx.restore();
    }

    if (this.judgmentBanner.alpha > 0.02) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.globalAlpha = this.judgmentBanner.alpha;
      ctx.font = `700 22px ${this.fontStack}`;
      ctx.fillStyle = this.judgmentBanner.color;
      ctx.fillText(this.judgmentBanner.text, w / 2, h * 0.36 - this.judgmentBanner.yOffset);

      if (this.judgmentBanner.subtext) {
        ctx.font = `500 12px ${this.fontStack}`;
        ctx.fillStyle = "#64748b";
        ctx.fillText(this.judgmentBanner.subtext, w / 2, h * 0.36 + 18 - this.judgmentBanner.yOffset);
      }
      ctx.restore();

      this.judgmentBanner.alpha *= 0.92;
      this.judgmentBanner.yOffset *= 0.85;
    }

    // 7. Minimal Hit Error Bar
    this.drawMinimalErrorBar(ctx, w / 2, receptorY + 62, hitErrors);
  }

  drawSoftSpectrum(ctx, w, h, freqData) {
    const numBars = 48;
    const barW = w / numBars;
    const maxBarH = h * 0.14;

    for (let i = 0; i < numBars; i++) {
      const val = freqData[i * 2] / 255.0;
      const barH = val * maxBarH;
      if (barH < 2) continue;

      ctx.fillStyle = "rgba(99, 102, 241, 0.09)";
      ctx.fillRect(i * barW + 2, h - barH, barW - 4, barH);
    }
  }

  drawMinimalErrorBar(ctx, cx, cy, hitErrors) {
    const meterW = 160;
    const halfW = meterW / 2;

    ctx.fillStyle = "rgba(30, 41, 59, 0.08)";
    ctx.fillRect(cx - halfW, cy - 2, meterW, 4);

    ctx.fillStyle = "rgba(30, 41, 59, 0.35)";
    ctx.fillRect(cx - 1, cy - 5, 2, 10);

    for (let i = 0; i < hitErrors.length; i++) {
      const item = hitErrors[i];
      const clamped = Math.max(-120, Math.min(120, item.offsetMs));
      const x = cx + (clamped / 120) * halfW;
      const ageAlpha = (i + 1) / hitErrors.length;

      ctx.fillStyle = this.hexToRgba(item.color, ageAlpha);
      ctx.fillRect(x - 1.5, cy - 4, 3, 8);
    }
  }

  hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}