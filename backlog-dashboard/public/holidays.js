'use strict';

// 日本の祝日（外部通信・ライブラリなしの自前計算）。BT-354
// 対象は1980〜2099年。春分・秋分は1980〜2099年で有効な近似式を使う。
// 固定祝日 / ハッピーマンデー / 春分・秋分 / 振替休日 / 国民の休日 / 2019〜2021年の特例に対応する。
(function (root) {
  const MIN_YEAR = 1980;
  const MAX_YEAR = 2099;
  const cache = new Map();

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  // UTC基準で曜日を求める（ローカルTZに依存させない）。0=日
  const dayOfWeek = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  function nthMonday(y, m, n) {
    const first = 1 + ((8 - dayOfWeek(y, m, 1)) % 7);
    return first + 7 * (n - 1);
  }

  const equinoxTerm = (y) => 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4);
  const springEquinoxDay = (y) => Math.floor(20.8431 + equinoxTerm(y));
  const autumnEquinoxDay = (y) => Math.floor(23.2488 + equinoxTerm(y));

  function addDays(y, m, d, days) {
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  }

  function buildYear(y) {
    const map = new Map();
    const add = (m, d, name) => map.set(ymd(y, m, d), name);

    add(1, 1, '元日');
    if (y <= 1999) add(1, 15, '成人の日'); else add(1, nthMonday(y, 1, 2), '成人の日');
    add(2, 11, '建国記念の日');
    if (y >= 2020) add(2, 23, '天皇誕生日');
    add(3, springEquinoxDay(y), '春分の日');
    if (y <= 1988) add(4, 29, '天皇誕生日');
    else if (y <= 2006) add(4, 29, 'みどりの日');
    else add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日');
    if (y >= 2007) add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    if (y === 2019) add(5, 1, '休日（天皇の即位の日）');

    // 海の日（2020・2021は東京五輪のため特例）
    if (y === 2020) add(7, 23, '海の日');
    else if (y === 2021) add(7, 22, '海の日');
    else if (y >= 2003) add(7, nthMonday(y, 7, 3), '海の日');
    else if (y >= 1996) add(7, 20, '海の日');

    // 山の日
    if (y === 2020) add(8, 10, '山の日');
    else if (y === 2021) add(8, 8, '山の日');
    else if (y >= 2016) add(8, 11, '山の日');

    if (y >= 2003) add(9, nthMonday(y, 9, 3), '敬老の日'); else add(9, 15, '敬老の日');
    add(9, autumnEquinoxDay(y), '秋分の日');

    // スポーツの日（旧・体育の日。2020・2021は特例）
    if (y === 2020) add(7, 24, 'スポーツの日');
    else if (y === 2021) add(7, 23, 'スポーツの日');
    else if (y >= 2020) add(10, nthMonday(y, 10, 2), 'スポーツの日');
    else if (y >= 2000) add(10, nthMonday(y, 10, 2), '体育の日');
    else add(10, 10, '体育の日');
    if (y === 2019) add(10, 22, '休日（即位礼正殿の儀）');

    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');
    if (y >= 1989 && y <= 2018) add(12, 23, '天皇誕生日');

    // 国民の休日: 前日と翌日が祝日に挟まれた平日（日曜を除く）
    const base = new Set(map.keys());
    for (let m = 1; m <= 12; m++) {
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = 1; d <= days; d++) {
        const key = ymd(y, m, d);
        if (base.has(key) || dayOfWeek(y, m, d) === 0) continue;
        const [py, pm, pd] = addDays(y, m, d, -1);
        const [ny, nm, nd] = addDays(y, m, d, 1);
        if (base.has(ymd(py, pm, pd)) && base.has(ymd(ny, nm, nd))) map.set(key, '国民の休日');
      }
    }

    // 振替休日: 祝日が日曜なら、その後で最初に祝日でない日（2007年以降の規定）。
    // 2006年以前は翌月曜のみ。基準は日曜の祝日（国民の休日は対象外）。
    for (const key of [...base].sort()) {
      const [, m, d] = key.split('-').map(Number);
      if (dayOfWeek(y, m, d) !== 0) continue;
      let [sy, sm, sd] = addDays(y, m, d, 1);
      if (y >= 2007) {
        while (map.has(ymd(sy, sm, sd))) [sy, sm, sd] = addDays(sy, sm, sd, 1);
      } else if (map.has(ymd(sy, sm, sd))) {
        continue;
      }
      if (sy === y) map.set(ymd(sy, sm, sd), '振替休日');
    }
    return map;
  }

  // 'YYYY-MM-DD' の祝日名を返す。祝日でない日・対象外の年はnull。
  function getHolidayName(date) {
    const y = Number(String(date).slice(0, 4));
    if (!(y >= MIN_YEAR && y <= MAX_YEAR)) return null;
    if (!cache.has(y)) cache.set(y, buildYear(y));
    return cache.get(y).get(date) || null;
  }

  root.jpHolidays = { getHolidayName, MIN_YEAR, MAX_YEAR };
})(globalThis);
