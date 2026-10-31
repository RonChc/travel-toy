// 用 regularOpeningHours.periods 判斷某個時間有沒有營業
// 回傳 true / false，沒有營業時間資料時回傳 undefined

const WEEK = 7 * 1440;
const weekMinute = ({ day, hour, minute }) => day * 1440 + hour * 60 + (minute || 0);

export function isOpenAt(place, date) {
  const periods = place.regularOpeningHours?.periods;
  if (!periods?.length) return undefined;
  // 24 小時營業：只有 open、沒有 close
  if (periods.length === 1 && !periods[0].close) return true;

  const t = date.getDay() * 1440 + date.getHours() * 60 + date.getMinutes();
  return periods.some((p) => {
    if (!p.open || !p.close) return false;
    const o = weekMinute(p.open);
    let c = weekMinute(p.close);
    if (c <= o) c += WEEK; // 跨週（例：週六 22:00 到週日 02:00）
    return (t >= o && t < c) || (t + WEEK >= o && t + WEEK < c);
  });
}

export const fmtClock = (date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
