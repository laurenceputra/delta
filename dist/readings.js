// Presentation only: exact tracker values remain untouched.
export function formatDelta(value) {
  if (!Number.isFinite(value)) return '—';
  if (value > 60) return '>60';
  if (value < -60) return '<−60';
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}`;
}
export function speedTone(speed, limit, fresh = true) {
  if (!fresh || !Number.isFinite(speed) || !Number.isFinite(limit) || limit <= 0) return 'neutral';
  return speed > limit * 1.1 ? 'danger' : speed > limit ? 'caution' : 'good';
}
export function deltaTone(delta, speed, reliable = true) {
  if (!reliable || !Number.isFinite(delta) || speed === 'neutral') return 'neutral';
  return speed === 'danger' ? 'danger' : speed === 'caution' || delta < -0.05 ? 'caution' : 'good';
}
// Raise warnings immediately; require two seconds of continuous lower severity to clear.
export class SpeedWarning {
  reset() { this.tone = 'neutral'; this.pending = null; }
  constructor() { this.reset(); }
  update(tone, time, limit) {
    const rank = { neutral: -1, good: 0, caution: 1, danger: 2 };
    if (tone === 'neutral' || limit !== this.limit || rank[tone] >= rank[this.tone]) {
      this.tone = tone; this.pending = null;
    } else if (this.pending?.tone !== tone) this.pending = { tone, since: time };
    else if (time - this.pending.since >= 2000) { this.tone = tone; this.pending = null; }
    this.limit = limit;
    return this.tone;
  }
}
