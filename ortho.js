
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize3(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }

// orthographic project vertices: drop z of camera-space coords
function projectOrtho(verts, viewVec, up = [0, 1, 0]) {
   const fwd = normalize3(viewVec);
   let r = normalize3(cross3(fwd, up));
   if (Math.hypot(...r) < 0.001) r = normalize3(cross3(fwd, [0, 0, 1]));
   const u2 = normalize3(cross3(r, fwd));
   return verts.map(v => [dot3(v, r), dot3(v, u2)]);
}

function gearRingStep(gear) {
   for (let d = 5; d <= gear; d++) {
      if (gear % d === 0) return d;
   }
   return 5; // fallback: label every vertex
}

function drawGearIndices(ctx, gear, cx, cy, radius) {
   let pts = [];
   const step = gearRingStep(gear);
   for (let i = 0; i < gear; i += step) {
      const angle = (i / gear) * 2 * Math.PI;
      const name = i === 0 ? gear : i; // label 0 as gear count for easier reading
      pts.push({ index: name, x: Math.sin(angle), y: -Math.cos(angle) });
   }

   // console.log(`Drawing gear indices at radius ${radius} with step ${step}...`, pts);

   ctx.font = `12px sans-serif`;
   ctx.textAlign = 'center';
   ctx.textBaseline = 'middle';

   pts.forEach(p => {
      const lx = cx + p.x * radius;
      const ly = cy - p.y * radius;

      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.lineJoin = 'round';
      ctx.strokeText(p.index, lx, ly);
      ctx.fillStyle = '#000000';
      ctx.fillText(p.index, lx, ly);
   });
}

function drawDimension(ctx, x1, y1, x2, y2, label, { offset = 0, color = '#000', fontSize = 11 } = {}) {
   const dx = x2 - x1, dy = y2 - y1;
   const len = Math.hypot(dx, dy);
   const nx = -dy / len, ny = dx / len; // normal (perpendicular)

   // offset positions
   const ax = x1 + nx * offset, ay = y1 + ny * offset;
   const bx = x2 + nx * offset, by = y2 + ny * offset;

   const barSize = 10;

   ctx.save();
   ctx.strokeStyle = color;
   ctx.fillStyle = color;
   ctx.lineWidth = 2;

   // main dimension line
   ctx.beginPath();
   ctx.moveTo(ax, ay);
   ctx.lineTo(bx, by);
   ctx.stroke();

   // end bars (perpendicular ticks)
   [[ax, ay], [bx, by]].forEach(([px, py]) => {
      ctx.beginPath();
      ctx.moveTo(px - nx * barSize, py - ny * barSize);
      ctx.lineTo(px + nx * barSize, py + ny * barSize);
      ctx.stroke();
   });

   // leader lines from original points to offset line
   // ctx.setLineDash([2, 3]);
   // ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ax, ay); ctx.stroke();
   // ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(bx, by); ctx.stroke();
   // ctx.setLineDash([]);

   // label in the middle
   const mx = (ax + bx) / 2, my = (ay + by) / 2;

   ctx.font = `${fontSize}px var(--font-sans)`;
   ctx.textAlign = 'center';
   ctx.textBaseline = 'middle';

   // white knockout
   ctx.lineWidth = 6;
   ctx.strokeStyle = '#ffffff';
   ctx.lineJoin = 'round';
   ctx.save();
   ctx.translate(mx, my);
   // ctx.rotate(angle);
   // ctx.strokeText(label, 0, 0);
   // draw a white box behind the text for better visibility
   const metrics = ctx.measureText(label);
   const padding = 4;
   const boxWidth = metrics.width + padding * 2;
   const boxHeight = fontSize + padding * 2;
   ctx.fillStyle = '#ffffff';
   ctx.fillRect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);

   // actual text
   ctx.fillStyle = color;
   ctx.fillText(label, 0, 0);
   ctx.restore();

   ctx.restore();
}

function drawBottomGirdleLabels(ctx, faces, view, cx, cy, scaled) {
   const labels = [];
   const seen = new Set();

   for (const face of faces) {
      const isGirdle = Number.isFinite(face?.angleDeg) && face.angleDeg > 89 && face.angleDeg < 91;
      if (!isGirdle) continue;

      const name = String(face?.name || '').trim();
      if (!name || seen.has(name)) continue;

      const pts = projectOrtho(face.vertices, view);
      if (!pts.length) continue;

      const x = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
      const y = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
      labels.push({ name, x, y });
      seen.add(name);
   }

   if (!labels.length) return;

   const leaderLen = 28;
   const gapFromGirdle = 2;
   const gapFromLabel = 8;
   const fontSize = 11;

   ctx.save();
   ctx.font = `${fontSize}px sans-serif`;
   ctx.textBaseline = 'middle';

   for (const label of labels) {
      const px = cx + label.x * scaled;
      const py = cy - label.y * scaled;

      let vx = px - cx;
      let vy = py - cy;
      const vlen = Math.hypot(vx, vy) || 1;
      vx /= vlen;
      vy /= vlen;

      const tx = px + vx * leaderLen;
      const ty = py + vy * leaderLen;
      const lx0 = tx - vx * gapFromLabel;
      const ly0 = ty - vy * gapFromLabel;
      const lx1 = px + vx * gapFromGirdle;
      const ly1 = py + vy * gapFromGirdle;

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#000000';
      ctx.beginPath();
      ctx.moveTo(lx0, ly0);
      ctx.lineTo(lx1, ly1);
      ctx.stroke();

      const arrowSize = 5;
      const nx = -vy;
      const ny = vx;
      ctx.beginPath();
      ctx.moveTo(lx1, ly1);
      ctx.lineTo(lx1 + vx * arrowSize + nx * arrowSize * 0.7, ly1 + vy * arrowSize + ny * arrowSize * 0.7);
      ctx.lineTo(lx1 + vx * arrowSize - nx * arrowSize * 0.7, ly1 + vy * arrowSize - ny * arrowSize * 0.7);
      ctx.closePath();
      ctx.fillStyle = '#000000';
      ctx.fill();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(label.name, tx, ty);
      ctx.fillStyle = '#000000';
      ctx.fillText(label.name, tx, ty);
   }

   ctx.restore();
}

function getStoneDimensions(faces, view) {
   let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
   let girdleMin = Infinity, girdleMax = -Infinity;
   let tableMinX = Infinity, tableMaxX = -Infinity, tableMinY = Infinity, tableMaxY = -Infinity;
   faces.forEach(f => {
      const pts = projectOrtho(f.vertices, view);
      pts.forEach(p => {
         if (p[0] < minX) minX = p[0];
         if (p[0] > maxX) maxX = p[0];
         if (p[1] < minY) minY = p[1];
         if (p[1] > maxY) maxY = p[1];
      });
      if (f.angleDeg > 89 && f.angleDeg < 91) { // girdle facets are ~90 degrees to view
         pts.forEach(p => {
            if (p[1] < girdleMin) girdleMin = p[1];
            if (p[1] > girdleMax) girdleMax = p[1];
         });
      }

      const isTable = f.signedAngleDeg > -1 && f.signedAngleDeg < 1;
      if (isTable) {
         pts.forEach((p) => {
            if (p[0] < tableMinX) tableMinX = p[0];
            if (p[0] > tableMaxX) tableMaxX = p[0];
            if (p[1] < tableMinY) tableMinY = p[1];
            if (p[1] > tableMaxY) tableMaxY = p[1];
         });
      }
   });

   return {
      minX, maxX, minY, maxY,
      girdleMin,
      girdleMax,
      tableMinX,
      tableMaxX,
      tableMinY,
      tableMaxY,
   };
}

function getFacetTierKey(face) {
   const signedAngleDeg = Number.isFinite(face?.signedAngleDeg)
      ? Number(face.signedAngleDeg)
      : 0;
   const is90Deg = Math.abs(signedAngleDeg) > 89.999;
   const angleKey = is90Deg
      ? Math.abs(signedAngleDeg).toFixed(2)
      : signedAngleDeg.toFixed(2);
   const name = String(face?.name || '').trim();
   const dKey = Number.isFinite(face?.d) ? Math.abs(face.d).toFixed(4) : 'NaN';
   return `${name}\u0000${angleKey}\u0000${dKey}`;
}

function renderOrtho(faces, view, canvas, scale = 1.0, gear, summary = {}, options = {}) {
   const tierColorByKey = options?.tierColorByKey instanceof Map ? options.tierColorByKey : null;
   const enableTierColors = Boolean(options?.enableTierColors && tierColorByKey);

   const visible = faces.filter(f => dot3(f.normal, view) > 0.01);

   const visibleArea = new Map();
   for (const f of visible) {
      const key = `${f.name}:${f.signedAngleDeg.toFixed(2)}`;
      const proj = projectOrtho(f.vertices, view);
      // calculate area of projected face using shoelace formula
      const area = Math.abs(proj.reduce((sum, p, i) => {
         const next = proj[(i + 1) % proj.length];
         return sum + (p[0] * next[1] - next[0] * p[1]);
      }, 0) / 2);

      if (!visibleArea.has(key) || (area * 0.99) > visibleArea.get(key).area) {
         visibleArea.set(key, { area, f });
      }
   }
   const labels = Array.from(visibleArea.values()).map(v => v.f);

   let viewIndex = '';
   if (view[0] === 0 && view[1] === 0 && view[2] === 1) viewIndex = 'top';
   else if (view[0] === -1 && view[1] === 0 && view[2] === 0) viewIndex = 'right';
   else if (view[0] === 0 && view[1] === 0 && view[2] === -1) viewIndex = 'bottom';
   else if (view[0] === 0 && view[1] === -1 && view[2] === 0) viewIndex = 'front';

   const ctx = canvas.getContext('2d');
   const W = canvas.width, H = canvas.height;
   // ctx.scale(dpr, dpr);
   ctx.clearRect(0, 0, W, H);
   // ctx.fillStyle = '#ff0000';
   // ctx.fillRect(0, 0, W, H);

   const edgeCol = `#000000`;

   const scaled = Math.min(W, H) / 2 * scale * 0.8;
   const cx = W / 2, cy = H / 2;

   ctx.lineJoin = 'round';

   function drawFace(face, strokeStyle, fillStyle, lw = 1) {
      const pts = projectOrtho(face.vertices, view);
      ctx.beginPath();
      ctx.moveTo(cx + pts[0][0] * scaled, cy - pts[0][1] * scaled);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(cx + pts[i][0] * scaled, cy - pts[i][1] * scaled);
      ctx.closePath();
      if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lw;
      ctx.stroke();
   }

   // draw visible faces
   visible.forEach(f => {
      const tierColor = enableTierColors ? tierColorByKey.get(getFacetTierKey(f)) : null;
      const fill = tierColor || '#ffffff';
      drawFace(f, edgeCol, fill, 1.5);
   });

   // face labels
   const fontSize = 12;
   ctx.font = `${fontSize}px sans-serif`;
   ctx.textAlign = 'center';
   ctx.textBaseline = 'middle';
   ctx.strokeStyle = '#ffffff';
   ctx.fillStyle = '#000000';
   ctx.lineWidth = 3;
   labels.forEach(f => {
      const pts = projectOrtho(f.vertices, view);
      const cx2 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy2 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      ctx.lineJoin = 'round'; // prevents spiky corners on sharp letters
      const [x, y] = [cx + cx2 * scaled, cy - cy2 * scaled];
      ctx.strokeText(f.name, x, y);
      ctx.fillText(f.name, x, y);
   });

   if (viewIndex === 'bottom') {
      drawBottomGirdleLabels(ctx, faces, view, cx, cy, scaled);
   }

   ctx.textAlign = 'left';
   ctx.textBaseline = 'alphabetic';

   const dimensions = getStoneDimensions(faces, view);
   const vertRight = [
      cx + dimensions.maxX * scaled,
      cy - dimensions.minY * scaled,
      cx + dimensions.maxX * scaled,
      cy - dimensions.maxY * scaled
   ];
   const vertLeft = [
      cx + dimensions.minX * scaled,
      cy - dimensions.minY * scaled,
      cx + dimensions.minX * scaled,
      cy - dimensions.maxY * scaled
   ];
   const horizTop = [
      cx + dimensions.minX * scaled,
      cy - dimensions.maxY * scaled,
      cx + dimensions.maxX * scaled,
      cy - dimensions.maxY * scaled
   ];
   const horizBottom = [
      cx + dimensions.minX * scaled,
      cy - dimensions.minY * scaled,
      cx + dimensions.maxX * scaled,
      cy - dimensions.minY * scaled,
   ];
   const vertBottom = [
      cx + dimensions.minX * scaled,
      cy - dimensions.minY * scaled,
      cx + dimensions.minX * scaled,
      cy - dimensions.girdleMin * scaled
   ];
   const vertTop = [
      cx + dimensions.minX * scaled,
      cy - dimensions.girdleMax * scaled,
      cx + dimensions.minX * scaled,
      cy - dimensions.maxY * scaled
   ];
   const tableHoriz = [
      cx + dimensions.tableMinX * scaled,
      cy - dimensions.maxY * scaled,
      cx + dimensions.tableMaxX * scaled,
      cy - dimensions.maxY * scaled
   ];
   const tableVert = [
      cx + dimensions.minX * scaled,
      cy - dimensions.tableMinY * scaled,
      cx + dimensions.minX * scaled,
      cy - dimensions.tableMaxY * scaled
   ];

   const labelOffset = 20;

   const lenghtLabels = ['L', 'U'];
   const widthLabels = ['W', 'T'];

   if (viewIndex === 'top') {
      drawGearIndices(ctx, gear, cx, cy, Math.min(W, H) / 2 - 12);
   }
   else if (viewIndex === 'right') {
      const dimName = summary.lHoriz ? widthLabels : lenghtLabels;
      drawDimension(ctx, ...vertRight, dimName[0], { offset: labelOffset });
      drawDimension(ctx, ...tableVert, dimName[1], { offset: -labelOffset });
   } else if (viewIndex === 'front') {
      const dimName = summary.lHoriz ? lenghtLabels : widthLabels;
      drawDimension(ctx, ...horizBottom, dimName[0], { offset: labelOffset });
      drawDimension(ctx, ...tableHoriz, dimName[1], { offset: -labelOffset });
      // drawDimension(ctx, ...horizTop, 'W', { offset: -labelOffset });
      drawDimension(ctx, ...vertTop, 'C', { offset: -labelOffset });
      drawDimension(ctx, ...vertBottom, 'P', { offset: -labelOffset });
   }
}

export {
   renderOrtho,
};
