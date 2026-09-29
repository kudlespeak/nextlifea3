// Дроны: детальные кэшированные спрайты (вид сверху, нос по +x) и живые детали —
// вращающиеся винты, тень на земле со сдвигом по высоте, покачивание при зависании.
// Варианты: FPV 7" с выстрелом ПГ-7, FPV 10" на оптоволокне (катушка), FPV 8" с термобарическим зарядом;
// разведчик — складной квадрокоптер или самолёт с толкающим винтом; сбросчик — тяжёлый гексакоптер.

const SIDE_TAPE = { blue: '#3d7fe0', red: '#d8443a' };
const cache = new Map();

// Геометрия вариантов (метры): размах, масштаб спрайта, винты [x, y, r], высота полёта
export const DRONE_ART = {
  fpv7: { name: 'FPV 7″ (ПГ-7)', span: 0.62, ppm: 190, alt: 12, props: quad(0.13, 0.115, 0.085), min: 15 },
  fpv10: { name: 'FPV 10″ (оптоволокно)', span: 0.78, ppm: 160, alt: 14, props: quad(0.18, 0.16, 0.125), min: 17 },
  fpv8: { name: 'FPV 8″ (термобар.)', span: 0.66, ppm: 180, alt: 12, props: quad(0.15, 0.13, 0.1), min: 16 },
  mavic: { name: 'квадрокоптер-разведчик', span: 0.56, ppm: 200, alt: 110, props: [[0.12, -0.15, 0.12], [0.12, 0.15, 0.12], [-0.13, -0.13, 0.12], [-0.13, 0.13, 0.12]], min: 17 },
  wing: { name: 'БПЛА самолётного типа', span: 2.5, ppm: 56, alt: 350, props: [[-0.78, 0, 0.19]], min: 30, fixed: true },
  hexa: { name: 'тяжёлый гексакоптер', span: 1.9, ppm: 70, alt: 70, props: hexProps(0.62, 0.3), min: 26 },
};

function quad(fx, fy, r) {
  // «растянутый X»: передние лучи чуть шире — как на гоночных рамах
  return [[fx, -fy, r], [fx, fy, r], [-fx, -fy, r], [-fx, fy, r]];
}
function hexProps(R, r) {
  const out = [];
  for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; out.push([Math.cos(a) * R, Math.sin(a) * R, r]); }
  return out;
}

export function droneVariant(d) {
  const id = d.id || 0;
  if (d.kind === 'fpv') return ['fpv7', 'fpv10', 'fpv8'][id % 3];
  if (d.kind === 'recon') return (id + (d.side === 'red' ? 1 : 0)) % 2 ? 'wing' : 'mavic';
  return 'hexa';
}

function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Спрайт и силуэт тени
function sprite(variant, side) {
  const key = variant + side;
  let s = cache.get(key);
  if (s) return s;
  const A = DRONE_ART[variant];
  const size = Math.ceil(A.span * A.ppm) + 6;
  const c = mkCanvas(size, size);
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  g.scale(A.ppm, A.ppm);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  ART[variant](g, side, A);
  // Тень: тот же силуэт, чёрный
  const sh = mkCanvas(size, size);
  const sg = sh.getContext('2d');
  sg.drawImage(c, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = '#000';
  sg.fillRect(0, 0, size, size);
  s = { c, sh, size, A };
  cache.set(key, s);
  return s;
}

// ——— общие детали ———
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
function grad(g, x0, y0, x1, y1, a, b) {
  const q = g.createLinearGradient(x0, y0, x1, y1);
  q.addColorStop(0, a); q.addColorStop(1, b);
  return q;
}
// Бесколлекторный мотор: колокол с прорезями, ось
function motor(g, x, y, r) {
  g.fillStyle = '#1b1c1e';
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  const q = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  q.addColorStop(0, '#9aa0a6'); q.addColorStop(0.6, '#4a4e53'); q.addColorStop(1, '#232527');
  g.fillStyle = q;
  g.beginPath(); g.arc(x, y, r * 0.86, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = r * 0.12;
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.35, y + Math.sin(a) * r * 0.35); g.lineTo(x + Math.cos(a) * r * 0.75, y + Math.sin(a) * r * 0.75); g.stroke();
  }
  g.fillStyle = '#c9ccd0';
  g.beginPath(); g.arc(x, y, r * 0.22, 0, Math.PI * 2); g.fill();
}
// Размытый диск винта (сами лопасти крутятся вживую)
function propDisc(g, x, y, r, tint = 'rgba(30,32,36,') {
  const q = g.createRadialGradient(x, y, r * 0.2, x, y, r);
  q.addColorStop(0, tint + '0.22)'); q.addColorStop(0.85, tint + '0.14)'); q.addColorStop(1, tint + '0.02)');
  g.fillStyle = q;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
// Карбоновый луч рамы
function arm(g, x0, y0, x1, y1, w) {
  g.strokeStyle = '#141517';
  g.lineWidth = w;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  g.strokeStyle = 'rgba(120,125,135,0.35)'; // блик карбона
  g.lineWidth = w * 0.25;
  g.beginPath(); g.moveTo(x0, y0 - w * 0.18); g.lineTo(x1, y1 - w * 0.18); g.stroke();
}
// Li-Po аккумулятор с ремнём и опознавательной лентой стороны
function lipo(g, x, y, L, W, side) {
  rr(g, x - L / 2, y - W / 2, L, W, W * 0.15);
  g.fillStyle = grad(g, x, y - W / 2, x, y + W / 2, '#3a3d44', '#1d1f24');
  g.fill();
  g.fillStyle = '#e8c23a'; // этикетка
  g.fillRect(x - L * 0.3, y - W * 0.36, L * 0.34, W * 0.72);
  g.fillStyle = '#222';
  g.fillRect(x - L * 0.24, y - W * 0.12, L * 0.2, W * 0.08);
  g.fillStyle = '#b3261e'; // ремень
  g.fillRect(x + L * 0.12, y - W / 2 - 0.004, L * 0.09, W + 0.008);
  g.fillStyle = SIDE_TAPE[side]; // опознавательная изолента
  g.fillRect(x - L * 0.46, y - W / 2 - 0.003, L * 0.1, W + 0.006);
  // силовые провода с разъёмом
  g.strokeStyle = '#8b1a14'; g.lineWidth = 0.008;
  g.beginPath(); g.moveTo(x - L / 2, y - 0.006); g.quadraticCurveTo(x - L / 2 - 0.03, y - 0.02, x - L / 2 - 0.045, y + 0.01); g.stroke();
  g.fillStyle = '#d9b43a';
  g.fillRect(x - L / 2 - 0.058, y, 0.022, 0.018);
}
// FPV-камера в клетке, на носу
function fpvCam(g, x, y, s = 1) {
  rr(g, x - 0.018 * s, y - 0.02 * s, 0.036 * s, 0.04 * s, 0.006 * s);
  g.fillStyle = '#26282c'; g.fill();
  g.fillStyle = '#0b0d12';
  g.beginPath(); g.arc(x + 0.02 * s, y, 0.013 * s, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(120,170,255,0.8)';
  g.beginPath(); g.arc(x + 0.023 * s, y - 0.004 * s, 0.004 * s, 0, Math.PI * 2); g.fill();
}
// Антенна видеопередатчика («гриб»)
function vtxAntenna(g, x, y, side) {
  g.strokeStyle = '#111'; g.lineWidth = 0.008;
  g.beginPath(); g.moveTo(x + 0.02, y); g.lineTo(x, y); g.stroke();
  g.fillStyle = side === 'red' ? '#7a2a24' : '#2a3f6a';
  g.beginPath(); g.arc(x - 0.006, y, 0.014, 0, Math.PI * 2); g.fill();
}

// ——— варианты ———
const ART = {
  // 7": рама-«икс», сверху выстрел ПГ-7 носом вперёд, пьезовзрыватель торчит далеко перед рамой
  fpv7(g, side, A) {
    for (const [x, y, r] of A.props) propDisc(g, x, y, r);
    for (const [x, y] of A.props) arm(g, 0, 0, x, y, 0.024);
    for (const [x, y] of A.props) motor(g, x, y, 0.021);
    rr(g, -0.075, -0.035, 0.15, 0.07, 0.012); g.fillStyle = '#1d1e21'; g.fill(); // пластина стека
    g.fillStyle = '#2e6b3a'; g.fillRect(-0.05, -0.024, 0.05, 0.048); // полётный контроллер
    lipo(g, -0.035, 0, 0.1, 0.045, side);
    // ПГ-7: цилиндрическая часть + конус + взрыватель
    const bx = 0.02;
    g.fillStyle = grad(g, 0, -0.035, 0, 0.035, '#7d8c55', '#454f2c');
    rr(g, bx, -0.034, 0.11, 0.068, 0.01); g.fill();
    g.beginPath(); g.moveTo(bx + 0.11, -0.034); g.lineTo(bx + 0.2, -0.008); g.lineTo(bx + 0.2, 0.008); g.lineTo(bx + 0.11, 0.034); g.closePath();
    g.fillStyle = grad(g, 0, -0.03, 0, 0.03, '#8a9960', '#4e5a31'); g.fill();
    g.fillStyle = '#b9a24e'; g.fillRect(bx + 0.2, -0.006, 0.03, 0.012); // взрыватель
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.004;
    g.beginPath(); g.moveTo(bx + 0.02, -0.034); g.lineTo(bx + 0.02, 0.034); g.moveTo(bx + 0.06, -0.034); g.lineTo(bx + 0.06, 0.034); g.stroke(); // хомуты
    g.fillStyle = '#d8d0b8'; g.fillRect(bx + 0.02, -0.036, 0.008, 0.072); g.fillRect(bx + 0.06, -0.036, 0.008, 0.072);
    fpvCam(g, 0.085, 0.045, 0.9);
    vtxAntenna(g, -0.085, 0, side);
  },
  // 10" на оптоволокне: крупная рама, сзади катушка с белой нитью, снизу — кумулятивный заряд
  fpv10(g, side, A) {
    for (const [x, y, r] of A.props) propDisc(g, x, y, r);
    for (const [x, y] of A.props) arm(g, 0, 0, x, y, 0.03);
    for (const [x, y] of A.props) motor(g, x, y, 0.027);
    rr(g, -0.1, -0.045, 0.2, 0.09, 0.015); g.fillStyle = '#1b1c1f'; g.fill();
    // заряд (виден по бокам рамы)
    g.fillStyle = grad(g, 0, -0.05, 0, 0.05, '#6b6f4a', '#3b3e27');
    rr(g, -0.02, -0.05, 0.17, 0.1, 0.03); g.fill();
    g.fillStyle = '#9c8a44'; g.beginPath(); g.arc(0.16, 0, 0.012, 0, Math.PI * 2); g.fill();
    lipo(g, -0.01, 0, 0.12, 0.055, side);
    // катушка оптоволокна: белый барабан с витками
    const cx = -0.14;
    g.fillStyle = '#e9e7e1'; g.beginPath(); g.arc(cx, 0, 0.055, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(150,150,145,0.6)'; g.lineWidth = 0.003;
    for (let r = 0.018; r < 0.055; r += 0.008) { g.beginPath(); g.arc(cx, 0, r, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = '#35373b'; g.beginPath(); g.arc(cx, 0, 0.016, 0, Math.PI * 2); g.fill();
    fpvCam(g, 0.1, 0.05, 1.1);
  },
  // 8": на рамe под батареей — термобарический цилиндр поперёк
  fpv8(g, side, A) {
    for (const [x, y, r] of A.props) propDisc(g, x, y, r);
    for (const [x, y] of A.props) arm(g, 0, 0, x, y, 0.026);
    for (const [x, y] of A.props) motor(g, x, y, 0.023);
    g.fillStyle = grad(g, 0, -0.09, 0, 0.09, '#5d6a3e', '#2f3620'); // термобарический цилиндр поперёк рамы
    rr(g, -0.03, -0.09, 0.07, 0.18, 0.03); g.fill();
    g.fillStyle = '#c2b47a'; g.fillRect(-0.03, -0.012, 0.07, 0.024); // маркировка
    rr(g, -0.08, -0.03, 0.16, 0.06, 0.012); g.fillStyle = '#202125'; g.fill();
    lipo(g, -0.02, 0, 0.1, 0.045, side);
    fpvCam(g, 0.085, 0, 1);
    vtxAntenna(g, -0.09, 0.02, side);
    g.strokeStyle = '#111'; g.lineWidth = 0.006; // антенны приёмника
    g.beginPath(); g.moveTo(-0.08, -0.02); g.lineTo(-0.13, -0.05); g.moveTo(-0.08, 0.02); g.lineTo(-0.12, 0.06); g.stroke();
  },
  // Складной квадрокоптер: серый обтекаемый корпус, лучи вперёд/назад, подвес камеры на носу
  mavic(g, side, A) {
    for (const [x, y, r] of A.props) propDisc(g, x, y, r, 'rgba(60,62,66,');
    g.fillStyle = '#5d6166';
    for (const [x, y] of A.props) {
      g.save(); g.translate(x / 2, y / 2); g.rotate(Math.atan2(y, x));
      rr(g, -Math.hypot(x, y) / 2, -0.012, Math.hypot(x, y), 0.024, 0.01); g.fill();
      g.restore();
    }
    for (const [x, y] of A.props) motor(g, x, y, 0.017);
    // корпус
    g.beginPath();
    g.moveTo(0.13, 0); g.bezierCurveTo(0.12, -0.05, 0.02, -0.055, -0.1, -0.045);
    g.bezierCurveTo(-0.14, -0.04, -0.15, 0.04, -0.1, 0.045);
    g.bezierCurveTo(0.02, 0.055, 0.12, 0.05, 0.13, 0);
    g.fillStyle = grad(g, 0, -0.05, 0, 0.05, '#9da1a6', '#5b5f64'); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 0.004; g.stroke();
    g.fillStyle = '#3c3f44'; rr(g, -0.1, -0.03, 0.1, 0.06, 0.01); g.fill(); // батарея
    g.fillStyle = SIDE_TAPE[side]; g.fillRect(-0.06, -0.032, 0.016, 0.064); // изолента
    // подвес с камерой
    g.fillStyle = '#2a2c30'; g.beginPath(); g.arc(0.14, 0, 0.022, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0a0c10'; g.beginPath(); g.arc(0.155, 0, 0.011, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(130,180,255,0.8)'; g.beginPath(); g.arc(0.158, -0.004, 0.003, 0, Math.PI * 2); g.fill();
    // датчики препятствий
    g.fillStyle = '#111'; g.fillRect(0.1, -0.03, 0.012, 0.01); g.fillRect(0.1, 0.02, 0.012, 0.01);
  },
  // Самолёт: прямое крыло, V-хвост на балке, толкающий винт, шар камеры снизу (виден сбоку фюзеляжа)
  wing(g, side, A) {
    const body = side === 'red' ? ['#b7b39f', '#7f7b69'] : ['#a9afa6', '#6f766c'];
    // крыло
    g.beginPath();
    g.moveTo(0.1, -1.2); g.lineTo(0.22, -1.2); g.lineTo(0.3, -0.1); g.lineTo(0.3, 0.1); g.lineTo(0.22, 1.2); g.lineTo(0.1, 1.2); g.lineTo(0.06, 0.1); g.lineTo(0.06, -0.1); g.closePath();
    g.fillStyle = grad(g, 0.06, 0, 0.3, 0, body[1], body[0]); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.012; g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.008; // элероны
    g.beginPath(); g.moveTo(0.11, -1.15); g.lineTo(0.1, -0.6); g.moveTo(0.11, 1.15); g.lineTo(0.1, 0.6); g.stroke();
    // хвостовая балка и V-хвост
    g.strokeStyle = '#3a3c38'; g.lineWidth = 0.035;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(-0.72, 0); g.stroke();
    g.beginPath();
    g.moveTo(-0.6, 0); g.lineTo(-0.74, -0.34); g.lineTo(-0.82, -0.34); g.lineTo(-0.74, 0); g.lineTo(-0.82, 0.34); g.lineTo(-0.74, 0.34); g.closePath();
    g.fillStyle = body[1]; g.fill(); g.stroke();
    // фюзеляж
    g.beginPath();
    g.moveTo(0.62, 0); g.bezierCurveTo(0.6, -0.08, 0.4, -0.11, 0.1, -0.1);
    g.lineTo(-0.4, -0.06); g.quadraticCurveTo(-0.48, 0, -0.4, 0.06); g.lineTo(0.1, 0.1);
    g.bezierCurveTo(0.4, 0.11, 0.6, 0.08, 0.62, 0);
    g.fillStyle = grad(g, 0, -0.11, 0, 0.11, body[0], body[1]); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 0.012; g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(-0.3, -0.05, 0.8, 0.025); // блик
    g.fillStyle = '#2b2e30'; g.beginPath(); g.arc(0.35, 0.1, 0.05, 0, Math.PI * 2); g.fill(); // шар камеры
    g.fillStyle = '#0b0d10'; g.beginPath(); g.arc(0.37, 0.12, 0.02, 0, Math.PI * 2); g.fill();
    g.fillStyle = SIDE_TAPE[side]; // опознавательные полосы на крыле
    g.fillRect(0.12, -0.95, 0.14, 0.06); g.fillRect(0.12, 0.89, 0.14, 0.06);
    g.fillStyle = '#222'; g.fillRect(-0.42, -0.03, 0.05, 0.06); // мотор
  },
  // Тяжёлый гексакоптер-сбросчик: шесть лучей, большие винты, короб батарей, держатели боеприпасов
  hexa(g, side, A) {
    for (const [x, y, r] of A.props) propDisc(g, x, y, r);
    for (const [x, y] of A.props) arm(g, 0, 0, x, y, 0.05);
    for (const [x, y] of A.props) motor(g, x, y, 0.05);
    // центральная плата
    g.beginPath();
    for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 0.2, Math.sin(a) * 0.2); }
    g.closePath(); g.fillStyle = '#1c1d20'; g.fill();
    g.strokeStyle = 'rgba(140,145,150,0.4)'; g.lineWidth = 0.01; g.stroke();
    // две батареи
    lipo(g, -0.02, -0.06, 0.2, 0.09, side);
    lipo(g, -0.02, 0.06, 0.2, 0.09, side);
    // курсовая камера и тепловизор
    rr(g, 0.15, -0.035, 0.06, 0.07, 0.01); g.fillStyle = '#2a2c2f'; g.fill();
    g.fillStyle = '#0b0d10'; g.beginPath(); g.arc(0.2, -0.013, 0.012, 0, Math.PI * 2); g.arc(0.2, 0.017, 0.012, 0, Math.PI * 2); g.fill();
    // GPS-«шайба»
    g.fillStyle = '#e4e4e0'; g.beginPath(); g.arc(-0.14, 0, 0.035, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#9aa'; g.beginPath(); g.arc(-0.14, 0, 0.012, 0, Math.PI * 2); g.fill();
  },
};

// Боеприпасы сбросчика (сколько осталось) — рисуются поверх, их число меняется
function hexaBombs(ctx, n, k) {
  const pos = [[0.02, -0.26], [0.02, 0.26], [-0.2, 0.2]];
  for (let i = 0; i < Math.min(3, n); i++) {
    const [x, y] = pos[i];
    ctx.fillStyle = '#5a6340';
    ctx.beginPath(); ctx.ellipse(x * k, y * k, 0.09 * k, 0.035 * k, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c8a64a';
    ctx.fillRect((x + 0.07) * k, (y - 0.012) * k, 0.03 * k, 0.024 * k); // взрыватель
    ctx.fillStyle = '#e25b2d'; // стабилизатор (оранжевый, печатный)
    ctx.fillRect((x - 0.12) * k, (y - 0.03) * k, 0.03 * k, 0.06 * k);
  }
}

// Отрисовка одного дрона. x, y — экранная точка над землёй; z — пикселей на метр
export function drawDrone(ctx, d, x, y, z, dpr, now, alpha = 1) {
  const variant = droneVariant(d);
  const S = sprite(variant, d.side);
  const A = S.A;
  // Масштаб: реальный размер, но не мельче читаемого минимума
  const px = Math.max(A.span * z * 1.3, A.min * 1.3 * dpr); // чуть крупнее реального — чтобы читались
  const k = px / A.span; // экранных пикселей на метр дрона
  const draw = (S.size * px) / (A.span * A.ppm);
  // Высота: FPV прижимается к земле у цели, разведчик высоко
  let alt = A.alt;
  if (d.kind === 'fpv') alt = Math.min(A.alt, Math.max(0.5, Math.hypot(d.tx - d.x, d.ty - d.y) * 0.25));
  if (d.kind === 'bomber' && d.state === 'hover') alt = 45;
  const off = Math.min(60 * dpr, Math.max(4 * dpr, alt * 0.35 * z)) * (A.fixed ? 1 : 1);
  const bob = A.fixed ? 0 : Math.sin(now / 260 + (d.id || 0)) * 0.6 * dpr; // покачивание
  const bank = A.fixed && d.state === 'loiter' ? 0.9 : 1; // крен в вираже — крыло «короче»
  const head = d.heading || 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Тень на земле (смещена от солнца, мягкая)
  ctx.save();
  ctx.translate(x + off * 0.55, y + off);
  ctx.rotate(head);
  ctx.globalAlpha = alpha * Math.max(0.12, 0.38 - alt / 1500);
  ctx.drawImage(S.sh, -draw / 2, (-draw / 2) * bank, draw, draw * bank);
  ctx.restore();
  // Сам дрон
  ctx.translate(x, y + bob);
  ctx.rotate(head);
  ctx.drawImage(S.c, -draw / 2, (-draw / 2) * bank, draw, draw * bank);
  // Вращающиеся лопасти: две полупрозрачные полосы на каждом винте
  if (px > 12 * dpr) {
    const t = now / 1000;
    ctx.lineCap = 'round';
    for (let i = 0; i < A.props.length; i++) {
      const [pxm, pym, r] = A.props[i];
      const cx = pxm * k, cy = pym * k * bank, R = r * k;
      const a = t * (A.fixed ? 55 : 70) * (i % 2 ? 1 : -1) + i;
      ctx.strokeStyle = 'rgba(20,20,22,0.45)';
      ctx.lineWidth = Math.max(1, R * 0.16);
      ctx.beginPath();
      if (A.fixed) { ctx.moveTo(cx, cy - R * Math.cos(a)); ctx.lineTo(cx, cy + R * Math.cos(a)); } // винт сбоку — видна «полоса»
      else { ctx.moveTo(cx - Math.cos(a) * R, cy - Math.sin(a) * R); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); }
      ctx.stroke();
      if (!A.fixed) {
        ctx.strokeStyle = 'rgba(200,205,210,0.18)'; // отблеск второй лопасти
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.8, a + 1.2, a + 1.9); ctx.stroke();
      }
    }
  }
  if (variant === 'hexa') hexaBombs(ctx, d.drops ?? 3, k);
  // Огни: у FPV — крошечный статусный светодиод, у самолёта — ничего (маскировка)
  if (variant.startsWith('fpv') && Math.floor(now / 180) % 2) {
    ctx.fillStyle = 'rgba(80,255,120,0.9)';
    ctx.beginPath(); ctx.arc(-0.05 * k, 0.03 * k, Math.max(0.8 * dpr, 0.008 * k), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
