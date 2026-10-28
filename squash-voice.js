'use strict';
// разбор речи (ru-RU) в команды судьи и применение к счёту
// \b в JS не работает с кириллицей, поэтому слова ищем по токенам или по строке с пробелами по краям
(function () {
const root = typeof window !== 'undefined' ? window : globalThis;
const Q = root.Squash = root.Squash || {};
const V = Q.Voice = {};
if (typeof module !== 'undefined') module.exports = Q;

const NUM = new Map(Object.entries({
  ноль: 0, нуль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20
}));
const numOf = t => /^\d{1,2}$/.test(t) ? +t : NUM.has(t) ? NUM.get(t) : null;

V.norm = text => String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

const WIN = /^(выиграл[а-я]*|выйграл[а-я]*|взял[а-я]*|забил[а-я]*|выигр[а-я]*)$/;
const LET = /^(лет|лэт|лед|лэд|let|переигров[а-я]*|переигр[а-я]*)$/;
const STROKE = /^(строк[а-я]*|строук[а-я]*|stroke|страйк[а-я]*|штраф[а-я]*)$/;
const ME = /^(я|мне|мое|моя|мои|мой|меня|мною|моему)$/;
const OPP = /^(соперник[а-я]*|противник[а-я]*|ему|его|ей|он|она)$/;
const LEFT = /^(слева|левая|левой|налево|лево)$/;
const RIGHT = /^(справа|правая|правой|направо|право)$/;

// кто назван этим токеном (0 — я / первый, 1 — соперник / второй) или null
const whoOf = (t, names) => {
  if (ME.test(t) || /^перв[а-я]*$/.test(t)) return 0;
  if (OPP.test(t) || /^втор[а-я]*$/.test(t)) return 1;
  for (let p = 0; p < names.length; p++) {
    const n = V.norm(names[p]);
    if (n && (t === n || (n.length >= 4 && t.startsWith(n.slice(0, -1))))) return p;
  }
  return null;
};

// text → { cmd, ... }
//   point {who, claim?, handOut}, stroke {who}, noLet, let, score {claim:[a,b]} | {byPlayer:[a,b]},
//   undo, query, next, box {box}, handOut, unknown
V.parse = (text, ctx = {}) => {
  const names = ctx.names || ['Я', 'Соперник'];
  const t = V.norm(text), tok = t ? t.split(' ') : [];
  const padded = ' ' + t + ' ';
  const out = { cmd: 'unknown', norm: t };

  // кто назван и какие числа произнесены
  const used = new Set();
  let who = null;
  for (let i = 0; i < tok.length && who === null; i++) {
    const n = numOf(tok[i]);
    if ((n === 1 || n === 2) && i + 1 < tok.length && WIN.test(tok[i + 1])) { who = n - 1; used.add(i); }
    else { const w = whoOf(tok[i], names); if (w !== null) who = w; }
  }
  const nums = [];
  tok.forEach((x, i) => {
    if (used.has(i)) return;
    if (x === '00') { nums.push(0, 0); return; }
    const n = numOf(x);
    if (n !== null) nums.push(n);
  });
  const hasWin = tok.some(x => WIN.test(x));
  // «мне семь, ему пять» — счёт по игрокам
  const pairs = [];
  tok.forEach((x, i) => { const w = whoOf(x, names); if (w !== null && i + 1 < tok.length && numOf(tok[i + 1]) !== null && !WIN.test(tok[i + 1])) pairs.push([w, numOf(tok[i + 1])]); });
  const byPlayer = pairs.length >= 2 && pairs[0][0] !== pairs[1][0] ? (pairs[0][0] === 0 ? [pairs[0][1], pairs[1][1]] : [pairs[1][1], pairs[0][1]]) : null;

  const box = tok.some(x => LEFT.test(x)) ? 'L' : tok.some(x => RIGHT.test(x)) ? 'R' : null;
  const handOut = / (переход[а-я]*|смена подачи|подача перешла) /.test(padded);
  if (box) out.box = box;

  if (/ (отмена|отмени[а-я]*|назад|верни[а-я]*|ошибся|ошиблись|ошибка|не то) /.test(padded)) { out.cmd = 'undo'; return out; }
  if (byPlayer) { out.cmd = 'score'; out.byPlayer = byPlayer; return out; }
  if (/ (ноу лет|ноулет|ноу лэт|но лет|но лэт|нет лет|no let|ноу лед) /.test(padded)) { out.cmd = 'noLet'; out.who = who; return out; }
  if (tok.some(x => STROKE.test(x))) { out.cmd = 'stroke'; out.who = who; return out; }
  if (tok.some(x => LET.test(x))) { out.cmd = 'let'; return out; }
  if (who !== null) {
    if (nums.length === 1 && !hasWin) return out; // «мне семь» — непонятно, очко это или счёт
    out.cmd = 'point'; out.who = who; out.handOut = handOut;
    if (nums.length >= 2) out.claim = [nums[0], nums[1]];
    return out;
  }
  if (nums.length >= 2) { out.cmd = 'score'; out.claim = [nums[0], nums[1]]; return out; }
  if (/ (повтори[а-я]*|какой счет|скажи счет|кто подает|счет) /.test(padded)) { out.cmd = 'query'; return out; }
  if (/ (следующий|дальше|продолжаем|продолжить|поехали|начали|начинаем|старт) /.test(padded)) { out.cmd = 'next'; return out; }
  if (handOut) { out.cmd = 'handOut'; return out; }
  if (box) { out.cmd = 'box'; return out; }
  return out;
};

// claim = [x, y]; порядок задаёт o.order: 'server' — подающий первым (как говорит судья), 'fixed' — я : соперник
const toScore = (claim, server, order) => order === 'fixed' ? [claim[0], claim[1]] : (server === 0 ? [claim[0], claim[1]] : [claim[1], claim[0]]);
// совпадает ли названный счёт с тем, что в приложении (в любом из двух порядков — это проверка, а не исправление)
const matches = (s, claim) => (claim[0] === s.score[0] && claim[1] === s.score[1]) || (claim[0] === s.score[s.server] && claim[1] === s.score[1 - s.server]);

// применить сказанное к счёту: { state, cmd, say }
V.apply = (s, text, o = {}) => {
  const c = V.parse(text, { names: s.names }), order = o.order || 'server';
  const none = why => Object.assign(Q.query(s), { last: { a: 'none', why } });
  let n;
  switch (c.cmd) {
    case 'undo': n = Q.undo(s); break;
    case 'query': n = Q.query(s); break;
    case 'let': n = Q.let(s); break;
    case 'stroke': n = c.who === null ? none('Кому stroke? Скажите: stroke мне, или stroke ему.') : Q.stroke(s, c.who); break;
    case 'noLet': n = Q.noLet(s); break;
    case 'point': {
      n = Q.point(s, c.who);
      if (c.claim && !matches(n, c.claim)) {
        // названный счёт не сходится — верим сказанному: очко засчитано победителю, он же подаёт
        n = Q.setScore(s, ...toScore(c.claim, c.who, order), { server: c.who });
      }
      break;
    }
    case 'score': {
      if (s.status === 'between' && c.claim && c.claim[0] === 0 && c.claim[1] === 0) { n = Q.nextGame(s); break; }
      const sc = c.byPlayer ? c.byPlayer : toScore(c.claim, s.server, order);
      n = sc[0] === s.score[0] && sc[1] === s.score[1] && s.status === 'playing' ? Q.confirm(s) : Q.setScore(s, sc[0], sc[1]);
      break;
    }
    case 'next': n = Q.nextGame(s); break;
    case 'handOut': n = Q.setServer(s, 1 - s.server); break;
    case 'box': n = Q.setBox(s, c.box); break;
    default: n = none('Не разобрал. Повторите.');
  }
  // «справа/слева» вместе с очком: новый подающий выбирает сторону
  if (c.box && ['point', 'stroke', 'noLet'].includes(c.cmd) && n.boxFree && n.status === 'playing') {
    const last = n.last;
    n = Q.setBox(n, c.box);
    n.last = last;
  }
  return { state: n, cmd: c, say: Q.say(n) };
};
})();
