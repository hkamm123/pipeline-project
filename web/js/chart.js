// The tide chart (canvas). One y-axis: meters above mean sea level.
//   observed: solid    predicted: dashed    nowcast: dotted
//   residual: shaded between observed and predicted (red = sea higher than the tables, blue = lower)
//   band: this month's typical residual range (p10-p90) around the prediction
//   playhead: the moment the music is playing

import { sample } from "./data.js";

const C = {
  obs: "#3987e5", pred: "#c3c2b7", grid: "#2c2c2a", axis: "#8f8e86", text: "#f0efec",
  up: "rgba(230,103,103,0.38)", down: "rgba(57,135,229,0.30)", band: "rgba(240,239,236,0.07)",
  now: "#8f8e86", play: "#fab219", gap: "#fab219",
};

export class Chart {
  constructor(canvas, tooltip, onSeek) {
    this.cv = canvas;
    this.tip = tooltip;
    this.hoverX = null;
    canvas.addEventListener("mousemove", (e) => { this.hoverX = e.offsetX; });
    canvas.addEventListener("mouseleave", () => { this.hoverX = null; this.tip.hidden = true; });
    canvas.addEventListener("click", (e) => onSeek?.(this.tOf(e.offsetX)));
  }

  layout(D) {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (this.cv.width !== w * dpr || this.cv.height !== h * dpr) { this.cv.width = w * dpr; this.cv.height = h * dpr; }
    const ctx = this.cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let lo = Infinity, hi = -Infinity;
    for (const s of D.series) for (const v of [s.obs, s.pred]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo = Math.floor(lo - 0.6); hi = Math.ceil(hi + 0.6);
    this.m = { l: 44, r: 12, t: 22, b: 26, w, h, lo, hi, t0: D.t0, t1: D.t1 };
    return ctx;
  }

  x(t) { const m = this.m; return m.l + ((t - m.t0) / (m.t1 - m.t0)) * (m.w - m.l - m.r); }
  y(v) { const m = this.m; return m.t + ((m.hi - v) / (m.hi - m.lo)) * (m.h - m.t - m.b); }
  tOf(px) { const m = this.m; return m.t0 + ((px - m.l) / (m.w - m.l - m.r)) * (m.t1 - m.t0); }

  draw(D, playT, now) {
    const ctx = this.layout(D), m = this.m, S = D.series;
    ctx.clearRect(0, 0, m.w, m.h);
    ctx.font = "11px system-ui, sans-serif";

    // grid + y labels (every 2 m)
    ctx.strokeStyle = C.grid; ctx.fillStyle = C.axis; ctx.lineWidth = 1; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = Math.ceil(m.lo / 2) * 2; v <= m.hi; v += 2) {
      ctx.beginPath(); ctx.moveTo(m.l, this.y(v)); ctx.lineTo(m.w - m.r, this.y(v)); ctx.stroke();
      ctx.fillText(`${v > 0 ? "+" : ""}${v} m`, m.l - 6, this.y(v));
    }
    // x labels: every 12 h at local midnight/noon
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const d = new Date(m.t0); d.setMinutes(0, 0, 0); d.setHours(d.getHours() < 12 ? 12 : 24);
    for (let t = d.getTime(); t < m.t1; t += 12 * 3600e3) {
      const dt = new Date(t);
      const label = dt.getHours() === 0 ? dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "noon";
      ctx.fillText(label, this.x(t), m.h - m.b + 7);
      ctx.beginPath(); ctx.moveTo(this.x(t), m.t); ctx.lineTo(this.x(t), m.h - m.b); ctx.stroke();
    }

    // typical band around the prediction
    const rq = D.normals?.residual_q;
    if (rq) {
      ctx.fillStyle = C.band; ctx.beginPath();
      S.forEach((s, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, this.x(s.t), this.y(s.pred + rq[90])));
      for (let i = S.length - 1; i >= 0; i--) ctx.lineTo(this.x(S[i].t), this.y(S[i].pred + rq[10]));
      ctx.fill();
    }

    // residual shading
    for (let i = 0; i < S.length - 1; i++) {
      const a = S[i], b = S[i + 1];
      if (a.obs == null || b.obs == null) continue;
      ctx.fillStyle = a.resid + b.resid >= 0 ? C.up : C.down;
      ctx.beginPath();
      ctx.moveTo(this.x(a.t), this.y(a.obs)); ctx.lineTo(this.x(b.t), this.y(b.obs));
      ctx.lineTo(this.x(b.t), this.y(b.pred)); ctx.lineTo(this.x(a.t), this.y(a.pred)); ctx.fill();
    }

    // predicted (dashed)
    this.line(ctx, S.map((s) => [s.t, s.pred]), C.pred, 1.5, [5, 4]);
    // observed (solid); breaks at failed-QC readings
    this.line(ctx, S.map((s) => [s.t, s.obs]), C.obs, 2, []);
    // nowcast (dotted): prediction + latest residual, from the newest reading onward
    if (D.lastObs) {
      const pts = S.filter((s) => s.t >= D.lastObs.t).map((s) => [s.t, s.pred + D.lastObs.resid]);
      this.line(ctx, pts, C.obs, 2, [1.5, 4]);
    }
    // failed-QC readings: ticks on the axis
    ctx.strokeStyle = C.gap; ctx.lineWidth = 2;
    for (const s of S) if (s.status === "failed_qc") { ctx.beginPath(); ctx.moveTo(this.x(s.t), m.h - m.b); ctx.lineTo(this.x(s.t), m.h - m.b - 6); ctx.stroke(); }

    // high/low tide labels
    ctx.fillStyle = C.axis; ctx.textAlign = "center";
    for (const tr of D.turns) {
      const up = tr.type === "high";
      ctx.textBaseline = up ? "bottom" : "top";
      ctx.fillText(up ? "H" : "L", this.x(tr.t), this.y(tr.v) + (up ? -4 : 4));
    }

    // now
    this.vline(ctx, now, C.now, [2, 3], "now");
    // playhead
    this.vline(ctx, playT, C.play, [], "♪");
    const ps = sample(D, playT);
    ctx.fillStyle = C.play; ctx.strokeStyle = "#1a1a19"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(this.x(playT), this.y(ps.level), 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();

    this.hover(ctx, D);
  }

  line(ctx, pts, color, width, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.lineJoin = "round";
    ctx.beginPath();
    let pen = false;
    for (const [t, v] of pts) {
      if (v == null) { pen = false; continue; }
      if (pen) ctx.lineTo(this.x(t), this.y(v)); else { ctx.moveTo(this.x(t), this.y(v)); pen = true; }
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  vline(ctx, t, color, dash, label) {
    const m = this.m;
    if (t < m.t0 || t > m.t1) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(this.x(t), m.t); ctx.lineTo(this.x(t), m.h - m.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(label, this.x(t), m.t - 3);
  }

  hover(ctx, D) {
    const m = this.m;
    if (this.hoverX == null || this.hoverX < m.l || this.hoverX > m.w - m.r) { this.tip.hidden = true; return; }
    const t = this.tOf(this.hoverX);
    const s = D.series.reduce((best, r) => (Math.abs(r.t - t) < Math.abs(best.t - t) ? r : best));
    const X = this.x(s.t);
    ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X, m.t); ctx.lineTo(X, m.h - m.b); ctx.stroke();
    for (const [v, c] of [[s.obs, C.obs], [s.pred, C.pred]]) {
      if (v == null) continue;
      ctx.fillStyle = c; ctx.strokeStyle = "#1a1a19"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X, this.y(v), 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
    const f = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)} m`);
    const kind = s.status === "observed" ? `measured (${s.q === "v" ? "verified" : "preliminary"})` : s.status === "failed_qc" ? "failed QC (blank)" : "prediction only";
    this.tip.innerHTML = `<b>${new Date(s.t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</b>
      <div>Observed <span>${f(s.obs)}</span></div><div>Predicted <span>${f(s.pred)}</span></div>
      <div>Residual <span>${f(s.resid)}</span></div><div class="muted">${kind}</div>`;
    this.tip.hidden = false;
    const left = X + 14 + 170 > m.w ? X - 184 : X + 14;
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${m.t + 6}px`;
  }
}
