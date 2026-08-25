'use strict';

const TIME_ZONE = 'America/Toronto';
const WEEKDAYS = Object.freeze({
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
});

function normalizeFrench(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[’]/g, "'")
    .toLowerCase();
}

function dateKeyInZone(now = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, date };
}

function formatDateKeyUTC(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(dateKey, days) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const result = new Date(parsed.date);
  result.setUTCDate(result.getUTCDate() + days);
  return formatDateKeyUTC(result);
}

function extractMentionedWeekday(message) {
  const normalized = normalizeFrench(message);
  const match = normalized.match(/\b(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)\b/);
  if (!match) return null;
  return { name: match[1], index: WEEKDAYS[match[1]] };
}

function nextWeekdayDate(now, weekdayIndex, timeZone = TIME_ZONE) {
  const current = parseDateKey(dateKeyInZone(now, timeZone));
  if (!current || !Number.isInteger(weekdayIndex) || weekdayIndex < 0 || weekdayIndex > 6) return null;
  const currentWeekday = current.date.getUTCDay();
  let delta = (weekdayIndex - currentWeekday + 7) % 7;
  if (delta === 0) delta = 7;
  const target = new Date(current.date);
  target.setUTCDate(target.getUTCDate() + delta);
  return formatDateKeyUTC(target);
}

function extractRelativeDate(message, now = new Date(), timeZone = TIME_ZONE) {
  const text = normalizeFrench(message);
  const today = dateKeyInZone(now, timeZone);
  if (/\baujourd[' ]?hui\b/.test(text)) return { date: today, source: 'aujourd’hui' };
  if (/\bapres[- ]demain\b/.test(text)) return { date: addDays(today, 2), source: 'après-demain' };
  if (/\bdemain\b/.test(text)) return { date: addDays(today, 1), source: 'demain' };
  const inDays = text.match(/\bdans\s+(\d{1,3})\s+jours?\b/);
  if (inDays) return { date: addDays(today, Number(inDays[1])), source: `dans ${inDays[1]} jours` };
  return null;
}

function extractExplicitDate(message, now = new Date(), timeZone = TIME_ZONE) {
  const text = normalizeFrench(message);
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && parseDateKey(iso[1])) return { date: iso[1], source: 'date ISO' };
  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (numeric) {
    const date = `${numeric[3]}-${String(Number(numeric[2])).padStart(2, '0')}-${String(Number(numeric[1])).padStart(2, '0')}`;
    return parseDateKey(date) ? { date, source: 'date numérique' } : null;
  }
  const months = {
    janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  };
  const named = text.match(/\b(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?\b/);
  if (!named) return null;
  const current = parseDateKey(dateKeyInZone(now, timeZone));
  const year = named[3] ? Number(named[3]) : current.year;
  const date = `${year}-${String(months[named[2]]).padStart(2, '0')}-${String(Number(named[1])).padStart(2, '0')}`;
  if (!parseDateKey(date)) return null;
  if (!named[3] && date < dateKeyInZone(now, timeZone)) {
    return { error: 'année requise pour une date déjà passée cette année', source: 'date nommée ambiguë' };
  }
  return { date, source: 'date nommée' };
}

function weekdayNameForDate(dateKey, locale = 'fr-CA') {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return '';
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(parsed.date);
}

function extractExplicitTime(message) {
  const text = normalizeFrench(message);
  if (/\bmidi\b/.test(text)) return '12:00';
  if (/\bminuit\b/.test(text)) return '00:00';
  let match = text.match(/(?:^|\s)(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (match) {
    let hour = Number(match[1]) % 12;
    if (match[3] === 'pm') hour += 12;
    return `${String(hour).padStart(2, '0')}:${match[2] || '00'}`;
  }
  match = text.match(/(?:^|\s)([01]?\d|2[0-3])\s*(?:h|heures?|:)\s*([0-5]\d)?\b/);
  return match ? `${String(Number(match[1])).padStart(2, '0')}:${match[2] || '00'}` : null;
}

function normalizeScheduledAction({ date, heure, userMessage, now = new Date(), timeZone = TIME_ZONE }) {
  const rawDate = String(date || '');
  const [candidateDate, isoTime = ''] = rawDate.split('T');
  if (!parseDateKey(candidateDate)) {
    return { ok: false, error: `Date invalide « ${rawDate} » — format YYYY-MM-DD requis` };
  }

  const mentionedWeekday = extractMentionedWeekday(userMessage);
  const relativeDate = extractRelativeDate(userMessage, now, timeZone);
  const explicitDate = extractExplicitDate(userMessage, now, timeZone);
  if (explicitDate?.error) return { ok: false, error: explicitDate.error };
  let calendarDate = null;
  if (mentionedWeekday) {
    const statedDate = explicitDate?.date || relativeDate?.date || null;
    if (statedDate) {
      const statedWeekday = parseDateKey(statedDate)?.date.getUTCDay();
      if (statedWeekday !== mentionedWeekday.index) {
        return {
          ok: false,
          error: `${mentionedWeekday.name} ne correspond pas à ${statedDate} (${weekdayNameForDate(statedDate)})`,
        };
      }
      calendarDate = statedDate;
    } else {
      const today = parseDateKey(dateKeyInZone(now, timeZone));
      if (today.date.getUTCDay() === mentionedWeekday.index && !/\bprochain(?:e)?\b/.test(normalizeFrench(userMessage))) {
        return { ok: false, error: `« ${mentionedWeekday.name} » est ambigu aujourd’hui; précise « aujourd’hui » ou « ${mentionedWeekday.name} prochain »` };
      }
      calendarDate = nextWeekdayDate(now, mentionedWeekday.index, timeZone);
    }
  }
  const dateSignals = [calendarDate, relativeDate?.date, explicitDate?.date].filter(Boolean);
  if (new Set(dateSignals).size > 1) {
    return { ok: false, error: `informations de date contradictoires: ${dateSignals.join(' vs ')}` };
  }
  const expectedDate = dateSignals[0] || candidateDate;
  const corrected = expectedDate !== candidateDate;
  const explicitTime = extractExplicitTime(userMessage);
  const suppliedTime = String(heure || isoTime.slice(0, 5) || '');
  const finalTime = explicitTime || null;

  if (finalTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(finalTime)) {
    return { ok: false, error: `Heure invalide « ${finalTime} »` };
  }

  return {
    ok: true,
    date: expectedDate,
    heure: finalTime,
    weekday: weekdayNameForDate(expectedDate),
    mentionedWeekday: mentionedWeekday?.name || null,
    dateSource: mentionedWeekday?.name || relativeDate?.source || explicitDate?.source || 'date ISO fournie',
    correctedDate: corrected,
    removedInventedTime: !explicitTime && Boolean(suppliedTime),
  };
}

module.exports = {
  TIME_ZONE,
  WEEKDAYS,
  dateKeyInZone,
  parseDateKey,
  addDays,
  extractMentionedWeekday,
  nextWeekdayDate,
  extractRelativeDate,
  extractExplicitDate,
  weekdayNameForDate,
  extractExplicitTime,
  normalizeScheduledAction,
};
