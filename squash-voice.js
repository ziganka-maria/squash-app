'use strict';
// разбор речи (ru-RU) в команды судьи и применение к счёту
// \b в JS не работает с кириллицей, поэтому слова ищем по токенам или по строке с пробелами по краям.
// Правило безопасности: в постоянном режиме приложение слышит всё, что говорят на корте, поэтому
//   — очко даёт только слово-триггер («очко», «выиграл»…) или фраза из одного-двух слов («мне», «ему»);
//   — любую неясность (две команды сразу, «не мне», два имени) переспрашиваем, ничего не меняя;
//   — непонятное молча игнорируем;
//   — опасное исправление счёта (меньше, чем есть; скачок больше чем на 2 очка; конец гейма) сначала подтверждаем словом «да».
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
const TRIG = /^(очко|очка|очку|выиграл[а-я]*|выйграл[а-я]*|взял[а-я]*|забил[а-я]*|выигр[а-я]*)$/; // слова, после которых «мне/ему» — это очко
const STOP = /^(гейм[а-я]*|подач[а-я]*|подаю|подает|подаем|счет[а-я]*|мяч[а-я]*|корт[а-я]*|сторон[а-я]*|квадрат[а-я]*)$/; // о чём-то другом: «второй гейм», «моя подача»
const LET = /^(лет|лэт|лед|лэд|let|летт|переигров[а-я]*|переигр[а-я]*)$/;
const NEG = /^(ноу|но|нет|no)$/;
const NOLET = /^(ноулет|нолет|ноулэт|нолэт|ноулед|нолед|ноулэд|нолэд)$/;
// «stroke» в русском распознавании: строк, острог, строг, стро, стрик…
const STROKE = /^(строк[а-я]*|строук[а-я]*|stroke|страйк[а-я]*|штраф[а-я]*|острог[а-я]*|строг[а-я]*|стро|стрэк[а-я]*|стрик[а-я]*|strike)$/;
const ME = /^(я|мне|мое|моя|мои|мой|меня|мною|мной|моему)$/;
// «ты/тебе/твоё» — это соперник, если командует первый игрок (так и считаем)
const OPP = /^(соперник[а-я]*|противник[а-я]*|ему|его|ей|он|она|ты|тебе|тебя|твой|твоя|твое|твои|твоему)$/;
const LEFT = /^(слева|левая|левой|налево|лево)$/;
const RIGHT = /^(справа|правая|правой|направо|право)$/;
const BOXFILL = /^(подача|подаю|подает|сторона|стороны|с|со|из|квадрат|квадрата|в)$/;
const SCOREFILL = /^(счет|на|из|равно|ровно|в|пользу)$/;
const FILL = /^(это|вот|ну|да|ой|так)$/;
const YES = /^(да|верно|точно|подтверждаю|давай|ага|угу)( да)?$/;
const NO = /^(нет|не надо|не нужно|отбой|стоп|отмена)$/;

// формы имени: Мария → мария, марии, марию, марией… Совпадает только полная форма, а не начало слова
const forms = name => {
  const w = V.norm(name).split(' ')[0];
  if (w.length < 2 || /^(я|соперник|противник)$/.test(w)) return []; // «Я» дала бы форму «и», «е» — союзы

  const last = w.slice(-1), stem = w.slice(0, -1);
  if (last === 'а') return [w, stem + 'ы', stem + 'и', stem + 'е', stem + 'у', stem + 'ой', stem + 'ою'];
  if (last === 'я') return [w, stem + 'и', stem + 'е', stem + 'ю', stem + 'ей', stem + 'ею'];
  if (last === 'й' || last === 'ь') return [w, stem + 'я', stem + 'ю', stem + 'ем', stem + 'е', stem + 'и'];
  return [w, w + 'а', w + 'у', w + 'ом', w + 'е', w + 'ем'];
};
const nameOf = (t, names) => {
  for (let p = 0; p < names.length; p++) if (forms(names[p]).includes(t)) return p;
  return null;
};

// text → { cmd, ... }
//   point {who, claim?, handOut}, stroke {who}, noLet {who — кто просил}, fault (ошибка подачи), let, score {claim:[a,b]} | {byPlayer:[a,b]}, undo, query, serve (вопрос «откуда подача»),
//   server {who} («подаёт Катя»), next, box {box}, ambig (две команды или два игрока сразу), unknown
V.parse = (text, ctx = {}) => {
  const names = ctx.names || ['Я', 'Соперник'];
  const t = V.norm(text), tok = t ? t.split(' ') : [];
  const padded = ' ' + t + ' ';
  const out = { cmd: 'unknown', norm: t };

  // кто назван: местоимение, имя, «первый/второй», «один/два выиграл»
  const used = new Set(), whos = [];
  tok.forEach((x, i) => {
    const n = numOf(x);
    if ((n === 1 || n === 2) && i + 1 < tok.length && WIN.test(tok[i + 1])) { whos.push({ i, p: n - 1, k: 'num' }); used.add(i); return; }
    if (ME.test(x)) whos.push({ i, p: 0, k: 'pron' });
    else if (OPP.test(x)) whos.push({ i, p: 1, k: 'pron' });
    else if (/^перв[а-я]*$/.test(x)) whos.push({ i, p: 0, k: 'ord' });
    else if (/^втор[а-я]*$/.test(x)) whos.push({ i, p: 1, k: 'ord' });
    else { const p = nameOf(x, names); if (p !== null) whos.push({ i, p, k: 'name' }); }
  });
  const trig = tok.some(x => TRIG.test(x)), stop = tok.some(x => STOP.test(x));
  // фраза целиком из имени игрока: «мне», «ему», «моё», «Маша», «первый»
  const pure = tok.length <= 3 && tok.every((x, i) => whos.some(w => w.i === i) || FILL.test(x));
  // «мне/ему/первый» — игрок только после триггера или в такой короткой фразе; «второй гейм», «ему тяжело», «моя подача» — не очко
  const valid = whos.filter(w => w.k === 'num' || trig || (pure && !stop));
  const negated = valid.some(w => w.i > 0 && tok[w.i - 1] === 'не');
  const players = [...new Set(valid.map(w => w.p))], anyPlayers = [...new Set(whos.map(w => w.p))];

  const nums = [];
  tok.forEach((x, i) => {
    if (used.has(i)) return;
    if (x === '00') { nums.push(0, 0); return; }
    const n = numOf(x);
    if (n !== null) nums.push(n);
  });
  // «мне семь, ему пять» — счёт по игрокам
  const pairs = whos.filter(w => w.i + 1 < tok.length && numOf(tok[w.i + 1]) !== null && !WIN.test(tok[w.i + 1])).map(w => [w.p, numOf(tok[w.i + 1])]);
  const byPlayer = pairs.length >= 2 && pairs[0][0] !== pairs[1][0] ? (pairs[0][0] === 0 ? [pairs[0][1], pairs[1][1]] : [pairs[1][1], pairs[0][1]]) : null;

  const box = tok.some(x => LEFT.test(x)) ? 'L' : tok.some(x => RIGHT.test(x)) ? 'R' : null;
  const handOut = / (переход[а-я]*|смена подачи|подача перешла) /.test(padded);
  if (box) out.box = box;

  if (/ (отмен[а-я]*|ошиблись|верни очко|вернуть очко|убери очко) /.test(padded)) { out.cmd = 'undo'; return out; }
  // ошибка подачи (fault): очко принимающему. Слово «ошибка» само по себе — не команда
  if (/ (ошибка подачи|ошибка при подаче|фол|фолт|фаул|fault) /.test(padded)) { out.cmd = 'fault'; return out; }
  if (byPlayer) { out.cmd = 'score'; out.byPlayer = byPlayer; return out; }
  // «откуда подача», «с какой стороны подавать», «кто подаёт», «чья подача» — спрашиваем у приложения
  if ((tok.includes('откуда') && tok.some(x => /^пода/.test(x))) || / (с какой стороны|какая сторона|чья подача|чья очередь|кто подает|где подача) /.test(padded)) { out.cmd = 'serve'; return out; }
  // «подаёт Катя», «я подаю» — назвать подающего
  if (tok.some(x => /^(подает|подаю|подаем)$/.test(x)) && anyPlayers.length === 1) { out.cmd = 'server'; out.who = anyPlayers[0]; return out; }

  // решения судьи и очко — не больше одной команды за раз
  const noLet = tok.some(x => NOLET.test(x)) || tok.some((x, i) => NEG.test(x) && i + 1 < tok.length && LET.test(tok[i + 1]));
  const isLet = !noLet && tok.some(x => LET.test(x));
  const isStroke = tok.some(x => STROKE.test(x));
  const pointByTrig = trig && valid.length > 0 && !isStroke;
  const pointShort = !trig && valid.length > 0 && !isLet && !noLet && !isStroke;
  const classes = [noLet ? 'noLet' : isLet ? 'let' : null, isStroke ? 'stroke' : null, pointByTrig || pointShort ? 'point' : null].filter(Boolean);
  if (classes.length > 1) { out.cmd = 'ambig'; return out; }

  if (classes[0] === 'noLet') { // «no let мне» — просил я, «no let ему» — просил он
    out.cmd = 'noLet'; out.who = anyPlayers.length === 1 && !whos.some(w => w.i > 0 && tok[w.i - 1] === 'не') ? anyPlayers[0] : null;
    return out;
  }
  if (classes[0] === 'let') { out.cmd = 'let'; return out; }
  if (classes[0] === 'stroke') {
    out.cmd = 'stroke'; out.who = anyPlayers.length === 1 && !whos.some(w => w.i > 0 && tok[w.i - 1] === 'не') ? anyPlayers[0] : null;
    return out;
  }
  if (classes[0] === 'point') {
    if (negated || players.length > 1) { out.cmd = 'ambig'; return out; }
    if (nums.length === 1 && !trig) return out; // «мне семь» — непонятно, очко это или счёт
    out.cmd = 'point'; out.who = players[0]; out.handOut = handOut;
    if (nums.length >= 2) out.claim = [nums[0], nums[1]];
    return out;
  }
  // счёт без «кто»: только числа и слова «счёт/на/из» — «два раза по пять минут» счётом не считаем
  if (nums.length >= 2 && tok.every(x => numOf(x) !== null || x === '00' || SCOREFILL.test(x))) { out.cmd = 'score'; out.claim = [nums[0], nums[1]]; return out; }
  if (nums.length < 2 && / (повтори[а-я]*|какой счет|скажи счет|счет) /.test(padded)) { out.cmd = 'query'; return out; }
  if (/ (следующий гейм|новый гейм|продолжаем|продолжить|поехали|начали|начинаем|старт) /.test(padded)) { out.cmd = 'next'; return out; }
  // «справа», «подача слева» — только если в фразе больше ничего нет
  if (box && tok.every(x => LEFT.test(x) || RIGHT.test(x) || BOXFILL.test(x))) { out.cmd = 'box'; return out; }
  return out;
};

// claim = [x, y]; порядок задаёт o.order: 'server' — подающий первым (как говорит судья), 'fixed' — я : соперник
const toScore = (claim, server, order) => order === 'fixed' ? [claim[0], claim[1]] : (server === 0 ? [claim[0], claim[1]] : [claim[1], claim[0]]);
// совпадает ли названный счёт с тем, что в приложении (в любом из двух порядков — это проверка, а не исправление)
const matches = (s, claim) => (claim[0] === s.score[0] && claim[1] === s.score[1]) || (claim[0] === s.score[s.server] && claim[1] === s.score[1 - s.server]);
// опасное исправление: счёт уменьшается, скачок больше чем на 2 очка или гейм закончится
const risky = (s, t) => t[0] < s.score[0] || t[1] < s.score[1] || (t[0] + t[1]) - (s.score[0] + s.score[1]) > 2 || Q.gameWinner(t) !== null;

// применить сказанное к счёту: { state, cmd, say, pending }.
// pending — исправление, которое ждёт «да» или «нет»; следующую фразу передавайте в o.pending
V.apply = (s, text, o = {}) => {
  const c = V.parse(text, { names: s.names }), order = o.order || 'server';
  const none = why => Object.assign(Q.query(s), { last: { a: 'none', why } });
  const done = (n, pending = null) => ({ state: n, cmd: c, say: Q.say(n), pending });
  const ask = (target, server) => {
    const w = (a, b) => Q.word(a) + ', ' + Q.word(b);
    return done(Q.ask(s, 'Исправить счёт на ' + (server === null ? w(target[s.server], target[1 - s.server]) : w(target[server], target[1 - server])) + '? Скажи да или нет.'), { kind: 'fix', score: target, server });
  };

  if (o.pending) {
    if (YES.test(c.norm)) {
      const p = o.pending, n = Q.setScore(s, p.score[0], p.score[1], p.server === null ? {} : { server: p.server });
      return Object.assign(done(n), { cmd: { cmd: 'yes', norm: c.norm } });
    }
    if (NO.test(c.norm)) return Object.assign(done(Q.cancelled(s)), { cmd: { cmd: 'no', norm: c.norm } });
  }

  let n;
  switch (c.cmd) {
    case 'undo': n = Q.undo(s); break;
    case 'query': n = Q.query(s); break;
    case 'serve': n = Q.queryServe(s); break;
    case 'let': n = Q.let(s); break;
    case 'noLet': n = c.who === null ? none('Кто просил let? Скажите: no let мне, или no let ему.') : Q.noLet(s, c.who); break;
    case 'fault': n = s.status === 'playing' ? Q.fault(s) : Q.ignore(s); break;
    case 'stroke': n = c.who === null ? none('Кому stroke? Скажите: stroke мне, или stroke ему.') : Q.stroke(s, c.who); break;
    case 'point': {
      n = Q.point(s, c.who);
      if (c.claim && !matches(n, c.claim)) {
        // названный счёт не сходится — верим сказанному: очко засчитано победителю, он же подаёт
        const target = toScore(c.claim, c.who, order);
        if (!Q.validScore(target[0], target[1])) break; // такого счёта не бывает — очко засчитано, названное игнорируем
        if (risky(s, target)) return ask(target, c.who);
        n = Q.setScore(s, target[0], target[1], { server: c.who });
      }
      break;
    }
    case 'score': {
      if (s.status === 'between' && c.claim && c.claim[0] === 0 && c.claim[1] === 0) { n = Q.nextGame(s); break; }
      if (s.status !== 'playing') { n = Q.ignore(s); break; }
      const sc = c.byPlayer ? c.byPlayer : toScore(c.claim, s.server, order);
      if (sc[0] === s.score[0] && sc[1] === s.score[1]) n = Q.confirm(s);
      else if (!Q.validScore(sc[0], sc[1])) n = none('Такого счёта в гейме не бывает. Повторите.');
      else if (risky(s, sc)) return ask(sc, null);
      else n = Q.setScore(s, sc[0], sc[1]);
      break;
    }
    case 'next': n = s.status === 'between' ? Q.nextGame(s) : Q.ignore(s); break;
    case 'box': n = s.status === 'playing' ? Q.setBox(s, c.box) : Q.ignore(s); break;
    case 'server': n = s.status === 'playing' ? Q.setServer(s, c.who) : Q.ignore(s); break;
    case 'ambig': n = none('Не понял. Скажите одну команду.'); break;
    default: n = Q.ignore(s); // шум и разговор на корте — молчим
  }
  // «справа/слева» вместе с очком: новый подающий выбирает сторону
  if (c.box && ['point', 'stroke', 'server'].includes(c.cmd) && n.boxFree && n.status === 'playing') {
    const last = n.last;
    n = Q.setBox(n, c.box);
    n.last = last;
  }
  return done(n);
};
})();
