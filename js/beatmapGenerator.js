/**
 * Runs an offline Radix-2 Cooley-Tukey FFT over overlapping Hann-windowed frames
 * across 4 frequency bands and enforces single-tile Piano Tiles spacing.
 */
export class BeatmapGenerator {
  static fftRadix2(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }

    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const angle = (-2 * Math.PI) / len;
      const wLenRe = Math.cos(angle);
      const wLenIm = Math.sin(angle);

      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let k = 0; k < halfLen; k++) {
          const uRe = re[i + k];
          const uIm = im[i + k];
          const vRe = re[i + k + halfLen] * wRe - im[i + k + halfLen] * wIm;
          const vIm = re[i + k + halfLen] * wIm + im[i + k + halfLen] * wRe;

          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + halfLen] = uRe - vRe;
          im[i + k + halfLen] = uIm - vIm;

          const nextWRe = wRe * wLenRe - wIm * wLenIm;
          wIm = wRe * wLenIm + wIm * wLenRe;
          wRe = nextWRe;
        }
      }
    }
  }

  static analyzeAndGenerate(audioBuffer, options = {}) {
    const sensitivity = options.sensitivity ?? 1.40;
    const minSpacingSec = (options.minSpacingMs ?? 180) / 1000;

    const sampleRate = audioBuffer.sampleRate;
    const rawLeft = audioBuffer.getChannelData(0);
    const rawRight = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : rawLeft;

    const length = rawLeft.length;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      mono[i] = (rawLeft[i] + rawRight[i]) * 0.5;
    }

    const frameSize = 1024;
    const hopSize = 512;
    const numFrames = Math.floor((length - frameSize) / hopSize);
    if (numFrames <= 0) return { notes: [], bpm: 120 };

    const hann = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
    }

    const binHz = sampleRate / frameSize;
    const bands = [
      { minBin: Math.max(1, Math.floor(30 / binHz)),  maxBin: Math.floor(170 / binHz) },
      { minBin: Math.floor(170 / binHz),              maxBin: Math.floor(700 / binHz) },
      { minBin: Math.floor(700 / binHz),              maxBin: Math.floor(2800 / binHz) },
      { minBin: Math.floor(2800 / binHz),             maxBin: Math.min(frameSize / 2 - 1, Math.floor(12000 / binHz)) }
    ];

    const prevMag = new Float32Array(frameSize / 2);
    const fluxPerBand = [
      new Float32Array(numFrames),
      new Float32Array(numFrames),
      new Float32Array(numFrames),
      new Float32Array(numFrames)
    ];

    const re = new Float32Array(frameSize);
    const im = new Float32Array(frameSize);

    for (let f = 0; f < numFrames; f++) {
      const offset = f * hopSize;
      for (let i = 0; i < frameSize; i++) {
        re[i] = mono[offset + i] * hann[i];
        im[i] = 0;
      }

      BeatmapGenerator.fftRadix2(re, im);

      for (let b = 0; b < 4; b++) {
        let bandFlux = 0;
        for (let k = bands[b].minBin; k <= bands[b].maxBin; k++) {
          const mag = Math.hypot(re[k], im[k]);
          const diff = mag - prevMag[k];
          if (diff > 0) bandFlux += diff;
          if (b === 3 || k === bands[b].maxBin || k < bands[b + 1]?.minBin) {
            prevMag[k] = mag;
          }
        }
        fluxPerBand[b][f] = bandFlux;
      }
    }

    const windowFrames = Math.floor(0.45 * (sampleRate / hopSize));
    const candidateNotes = [];
    const lastNoteTimeByLane = [-999, -999, -999, -999];

    for (let b = 0; b < 4; b++) {
      const flux = fluxPerBand[b];
      for (let f = 2; f < numFrames - 2; f++) {
        const val = flux[f];
        if (val <= flux[f - 1] || val < flux[f + 1]) continue;

        const startW = Math.max(0, f - windowFrames);
        const endW = Math.min(numFrames - 1, f + windowFrames);
        const count = endW - startW + 1;

        let sum = 0;
        for (let w = startW; w <= endW; w++) sum += flux[w];
        const mean = sum / count;

        let varianceSum = 0;
        for (let w = startW; w <= endW; w++) {
          const d = flux[w] - mean;
          varianceSum += d * d;
        }
        const stdDev = Math.sqrt(varianceSum / count);
        const threshold = mean + sensitivity * stdDev;

        if (val > threshold && val > 1.2) {
          const timeSec = (f * hopSize) / sampleRate;
          if (timeSec < 0.45) continue;

          if (timeSec - lastNoteTimeByLane[b] >= Math.max(0.18, minSpacingSec)) {
            const zScore = stdDev > 0 ? (val - mean) / stdDev : 1;
            candidateNotes.push({
              time: Number(timeSec.toFixed(4)),
              lane: b,
              strength: zScore
            });
            lastNoteTimeByLane[b] = timeSec;
          }
        }
      }
    }

    candidateNotes.sort((a, b) => a.time - b.time);

    const filteredNotes = [];
    let cluster = [];
    const lastEmittedInLane = [-999, -999, -999, -999];

    const flushCluster = () => {
      if (cluster.length === 0) return;
      cluster.sort((a, b) => b.strength - a.strength);
      const chosen = cluster[0];
      if (chosen.time - lastEmittedInLane[chosen.lane] >= Math.max(0.18, minSpacingSec)) {
        filteredNotes.push({
          time: chosen.time,
          lane: chosen.lane,
          hit: false,
          missed: false
        });
        lastEmittedInLane[chosen.lane] = chosen.time;
      }
      cluster = [];
    };

    const globalClusterWindow = Math.max(0.08, minSpacingSec * 0.65);
    for (const note of candidateNotes) {
      if (cluster.length === 0 || note.time - cluster[0].time <= globalClusterWindow) {
        cluster.push(note);
      } else {
        flushCluster();
        cluster.push(note);
      }
    }
    flushCluster();

    const kickTimes = candidateNotes.filter(n => n.lane === 0).map(n => n.time);
    const bpm = BeatmapGenerator.estimateBpm(kickTimes);

    return { notes: filteredNotes, bpm };
  }

  static estimateBpm(onsetTimes) {
    if (onsetTimes.length < 4) return 120;
    const histogram = new Map();
    for (let i = 1; i < onsetTimes.length; i++) {
      const ioi = onsetTimes[i] - onsetTimes[i - 1];
      if (ioi < 0.22 || ioi > 1.2) continue;
      let bpm = 60 / ioi;
      while (bpm < 85) bpm *= 2;
      while (bpm > 175) bpm /= 2;
      const rounded = Math.round(bpm / 2) * 2;
      histogram.set(rounded, (histogram.get(rounded) || 0) + 1);
    }
    let bestBpm = 120;
    let bestCount = 0;
    for (const [bpm, count] of histogram.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestBpm = bpm;
      }
    }
    return bestBpm;
  }
}