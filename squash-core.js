'use strict';
// движок счёта сквоша: PAR до 11 с разницей в 2. Без DOM — состояние обычный JSON, его можно хранить в localStorage
(function () {
const root = typeof window !== 'undefined' ? window : globalThis;
const Q = root.Squash = root.Squash || {};
if (typeof module !== 'undefined') module.exports = Q;

const POINTS = 11, WIN_BY = 2;

const clone = s => JSON.parse(JSON.stringify(s));
// снимок для отмены: только то, что меняется от очка к очку
const snap = s => ({
  score: s.score.slice(), results: s.results.map(r => ({ score: r.score.slice(), winner: r.winner, first: r.first })),
  first: s.first, server: s.server, box: s.box, boxFree: s.boxFree, status: s.status, winner: s.winner, logLen: s.log.length
});
const log = (s, e) => {
  s.past.push(snap(s));
  s.log.push(Object.assign({ n: s.log.length + 1, ts: Date.now() }, e));
};
const noop = (s0, why) => { const s = clone(s0); s.last = { a: 'none', why }; return s; };

// Сторона подачи (box: 'R' | 'L') известна только если её назвали: в начале гейма и после перехода подачи её выбирает
// сам подающий, приложение этого не видит. Пока сторона не названа, box = null и boxFree = true;
// «другую половину» после очка можно назвать только от известной стороны.
// o: names [я, соперник], gamesToWin 1|2|3, firstServer 0|1, box 'R'|'L' (если сторона уже известна)
Q.newMatch = (o = {}) => {
  const first = o.firstServer === 1 ? 1 : 0, box = o.box === 'L' || o.box === 'R' ? o.box : null;
  return {
    v: 1, names: o.names || ['Я', 'Соперник'], gamesToWin: o.gamesToWin || 2,
    score: [0, 0], results: [], first, server: first, box, boxFree: box === null,
    status: 'playing', // playing — идёт гейм, between — гейм закончен, ждём следующий, finished — матч закончен
    winner: null, last: null, log: [], past: []
  };
};

Q.games = s => s.results.reduce((g, r) => { g[r.winner]++; return g; }, [0, 0]);

// кто выиграл гейм при таком счёте (null — ещё идёт)
Q.gameWinner = sc => {
  const hi = sc[0] > sc[1] ? 0 : 1, a = sc[hi], b = sc[1 - hi];
  return a >= POINTS && a - b >= WIN_BY ? hi : null;
};

// бывает ли такой счёт в гейме: до 11 — любой; после 11 разница только 1 или 2
Q.validScore = (a, b) => {
  if (![a, b].every(n => Number.isInteger(n) && n >= 0 && n <= 99)) return false;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return hi <= POINTS || hi - lo <= WIN_BY;
};

// у кого сейчас гейм-бол / матч-бол
Q.balls = s => {
  const r = { game: null, match: null };
  if (s.status !== 'playing') return r;
  for (const p of [0, 1]) {
    const sc = s.score.slice(); sc[p]++;
    if (Q.gameWinner(sc) === p) {
      r.game = p;
      if (Q.games(s)[p] + 1 >= s.gamesToWin) r.match = p;
    }
  }
  return r;
};

const endGame = (s, w) => {
  s.results.push({ score: s.score.slice(), winner: w, first: s.first });
  s.server = w;
  const over = Q.games(s)[w] >= s.gamesToWin;
  s.status = over ? 'finished' : 'between';
  if (over) s.winner = w;
  s.last.gameEnded = { winner: w, score: s.score.slice() };
  s.last.matchEnded = over;
};

// очко: выиграл розыгрыш (rally) или stroke
Q.point = (s0, who, kind = 'rally') => {
  if (s0.status !== 'playing') return noop(s0, 'Сейчас гейм не идёт');
  const s = clone(s0), wasServer = s.server === who;
  log(s, { a: 'point', who, kind });
  s.score[who]++;
  s.last = { a: 'point', who, kind, handOut: !wasServer };
  s.server = who;
  if (wasServer) { // подающий выиграл — подаёт с другой половины, если мы знаем, с какой подавал
    if (s.box) s.box = s.box === 'R' ? 'L' : 'R';
    s.boxFree = s.box === null;
  } else { s.box = null; s.boxFree = true; } // переход подачи — новый подающий выбирает сторону сам
  const w = Q.gameWinner(s.score);
  if (w !== null) endGame(s, w);
  return s;
};
Q.stroke = (s, who) => Q.point(s, who, 'stroke');

// let: переигровка, счёт и подача те же
Q.let = s0 => {
  if (s0.status !== 'playing') return noop(s0, 'Сейчас гейм не идёт');
  const s = clone(s0);
  log(s, { a: 'let' });
  s.last = { a: 'let' };
  return s;
};
// no let: просьба отклонена — по разъяснениям PSA очко получает тот, кто НЕ просил; appellant — кто просил. Спорный пункт: см. вопросы подруге
Q.noLet = (s, appellant) => Q.point(s, 1 - appellant, 'nolet');
// ошибка подачи (правило 5.8): второй подачи нет, очко принимающему и переход подачи
Q.fault = s => Q.point(s, 1 - s.server, 'fault');

// исправление счёта текущего гейма; o.server — кто подаёт после исправления. Сторона подачи после исправления неизвестна
Q.setScore = (s0, a, b, o = {}) => {
  if (s0.status !== 'playing') return noop(s0, 'Гейм уже закончен — отмените последнее очко');
  if (!Q.validScore(a, b)) return noop(s0, 'Такого счёта в гейме не бывает');
  const s = clone(s0);
  const from = s.score.slice();
  log(s, { a: 'fix', from, to: [a, b] });
  s.last = { a: 'fix', from, to: [a, b] };
  s.score = [a, b];
  if (o.server === 0 || o.server === 1) s.server = o.server;
  s.box = null; s.boxFree = true;
  const w = Q.gameWinner(s.score);
  if (w !== null) endGame(s, w);
  return s;
};

Q.setServer = (s0, p) => {
  if (s0.status !== 'playing') return noop(s0, 'Сейчас гейм не идёт');
  const s = clone(s0);
  log(s, { a: 'server', who: p });
  s.server = p; s.box = null; s.boxFree = true;
  s.last = { a: 'server', who: p };
  return s;
};

Q.setBox = (s0, box) => {
  if (s0.status !== 'playing') return noop(s0, 'Сейчас гейм не идёт');
  const s = clone(s0);
  log(s, { a: 'box', box });
  s.box = box; s.boxFree = false;
  s.last = { a: 'box', box };
  return s;
};

// следующий гейм; по умолчанию первым подаёт победитель предыдущего
Q.nextGame = (s0, first) => {
  if (s0.status !== 'between') return noop(s0, 'Следующий гейм ещё не начался');
  const s = clone(s0);
  const f = first === 0 || first === 1 ? first : s.results[s.results.length - 1].winner;
  log(s, { a: 'next', first: f });
  s.score = [0, 0]; s.first = f; s.server = f; s.box = null; s.boxFree = true; s.status = 'playing';
  s.last = { a: 'next', first: f, n: s.results.length + 1 };
  return s;
};

Q.undo = s0 => {
  if (!s0.past.length) return noop(s0, 'Отменять нечего');
  const s = clone(s0), p = s.past.pop();
  s.score = p.score; s.results = p.results; s.first = p.first; s.server = p.server; s.box = p.box;
  s.boxFree = p.boxFree; s.status = p.status; s.winner = p.winner;
  s.log.length = p.logLen;
  s.last = { a: 'undo' };
  return s;
};

Q.query = s0 => { const s = clone(s0); s.last = { a: 'query' }; return s; };
Q.queryServe = s0 => { const s = clone(s0); s.last = { a: 'serve' }; return s; };
Q.confirm = s0 => { const s = clone(s0); s.last = { a: 'confirm' }; return s; };
// не команда: ничего не меняем и не говорим (шум, разговор на корте)
Q.ignore = s0 => { const s = clone(s0); s.last = { a: 'ignored' }; return s; };
// вопрос игроку (подтвердить опасное исправление): q — текст вопроса
Q.ask = (s0, q) => { const s = clone(s0); s.last = { a: 'ask', q }; return s; };
Q.cancelled = s0 => { const s = clone(s0); s.last = { a: 'cancelled' }; return s; };

// ——— что сказать вслух ———
const NUMW = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать',
  'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать', 'двадцать'];
const word = n => n <= 20 ? NUMW[n] : n < 30 ? 'двадцать ' + NUMW[n - 20] : String(n);
const side = b => b === 'R' ? 'справа' : 'слева';
Q.word = word;
Q.side = side;

// счёт так, как называет судья: подающий первым
Q.scoreWords = s => word(s.score[s.server]) + ', ' + word(s.score[1 - s.server]);

const ballWords = s => {
  const b = Q.balls(s);
  return b.match !== null ? 'Матч-бол, ' + s.names[b.match] + '.' : b.game !== null ? 'Гейм-бол, ' + s.names[b.game] + '.' : '';
};

Q.say = s => {
  const l = s.last || {}, nm = p => s.names[p], out = [];
  switch (l.a) {
    case 'point': {
      if (l.kind === 'stroke') out.push('Stroke, ' + nm(l.who) + '.');
      if (l.kind === 'nolet') out.push('No let.');
      if (l.kind === 'fault') out.push('Ошибка подачи.');
      if (l.gameEnded) {
        // как у маркёра: сначала счёт, потом «гейм»
        const w = l.gameEnded.winner, sc = l.gameEnded.score, g = Q.games(s);
        if (l.matchEnded) out.push(word(sc[w]) + ', ' + word(sc[1 - w]) + '. Матч — ' + nm(w) + '. По геймам ' + word(g[w]) + ', ' + word(g[1 - w]) + '.');
        else out.push(word(sc[w]) + ', ' + word(sc[1 - w]) + '. Гейм — ' + nm(w) + '. В матче ' + word(g[w]) + ', ' + word(g[1 - w]) + '.');
        break;
      }
      if (l.handOut) out.push('Переход.');
      out.push(Q.scoreWords(s) + '.');
      if (s.score[0] === 10 && s.score[1] === 10) out.push('Играем до разницы в два очка.'); // правило 3.5.8
      if (!s.boxFree) out.push('Подача ' + side(s.box) + '.'); // сторону называем, только если она известна
      out.push(ballWords(s));
      break;
    }
    case 'let': out.push('Переигровка.', Q.scoreWords(s) + '.'); break;
    case 'fix':
      if (s.status === 'playing') out.push('Исправлено.', Q.scoreWords(s) + '.');
      else out.push('Исправлено. Гейм — ' + nm(s.results[s.results.length - 1].winner) + '.');
      break;
    case 'confirm': out.push('Верно.', Q.scoreWords(s) + '.'); break;
    case 'server': out.push('Подача — ' + nm(l.who) + '.'); break;
    case 'box': out.push('Подача ' + side(l.box) + '.'); break;
    case 'next': out.push('Гейм ' + word(l.n) + '. Ноль, ноль. Подача — ' + nm(l.first) + '.'); break;
    case 'undo': out.push('Отмена.', s.status === 'playing' ? Q.scoreWords(s) + '.' : ''); break;
    case 'serve':
      // сторону выбирает сам подающий: в начале гейма и когда подача перешла к нему
      if (s.status !== 'playing') out.push('Гейм не идёт.');
      else out.push('Подача — ' + nm(s.server) + ', ' + (s.boxFree ? 'сторона не названа.' : side(s.box) + '.'));
      break;
    case 'query': {
      const g = Q.games(s);
      out.push(Q.scoreWords(s) + '.', 'Подача — ' + nm(s.server) + (s.boxFree ? '' : ', ' + side(s.box)) + '.');
      if (g[0] + g[1]) out.push('По геймам ' + word(g[s.server]) + ', ' + word(g[1 - s.server]) + '.');
      out.push(ballWords(s));
      break;
    }
    case 'ask': out.push(l.q); break;
    case 'cancelled': out.push('Хорошо, ничего не меняю.'); break;
    case 'none': out.push(l.why); break;
    // ignored — молчим
  }
  return out.filter(Boolean).join(' ').replace(/(^|\. )([а-я])/g, (m, a, b) => a + b.toUpperCase());
};
})();
