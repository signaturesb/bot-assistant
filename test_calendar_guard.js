'use strict';

const assert = require('assert');
const {
  dateKeyInZone,
  extractExplicitTime,
  nextWeekdayDate,
  normalizeScheduledAction,
  weekdayNameForDate,
} = require('./lib/calendar_guard');

// Vendredi 21 août 2026 à Toronto: le prochain lundi est le 24, pas le 25.
const fridayAug21Toronto = new Date('2026-08-21T16:00:00Z');
assert.strictEqual(dateKeyInZone(fridayAug21Toronto), '2026-08-21');
assert.strictEqual(nextWeekdayDate(fridayAug21Toronto, 1), '2026-08-24');
assert.strictEqual(weekdayNameForDate('2026-08-24'), 'lundi');
assert.strictEqual(weekdayNameForDate('2026-08-25'), 'mardi');

assert.strictEqual(extractExplicitTime('lundi à 15h'), '15:00');
assert.strictEqual(extractExplicitTime('vendredi 3:30pm'), '15:30');
assert.strictEqual(extractExplicitTime('lundi sans heure précise'), null);

assert.deepStrictEqual(
  normalizeScheduledAction({
    date: '2026-08-25T11:00',
    userMessage: 'planifie une visite lundi à 15h',
    now: fridayAug21Toronto,
  }),
  {
    ok: true,
    date: '2026-08-24',
    heure: '15:00',
    weekday: 'lundi',
    mentionedWeekday: 'lundi',
    dateSource: 'lundi',
    correctedDate: true,
    removedInventedTime: false,
  },
);

const noTime = normalizeScheduledAction({
  date: '2026-08-24T11:00',
  userMessage: 'planifie une visite lundi',
  now: fridayAug21Toronto,
});
assert.strictEqual(noTime.date, '2026-08-24');
assert.strictEqual(noTime.heure, null);
assert.strictEqual(noTime.removedInventedTime, true);

const tomorrow = normalizeScheduledAction({
  date: '2026-08-25T09:00',
  userMessage: 'crée une activité demain à midi',
  now: fridayAug21Toronto,
});
assert.strictEqual(tomorrow.date, '2026-08-22');
assert.strictEqual(tomorrow.heure, '12:00');

const explicitFrench = normalizeScheduledAction({
  date: '2026-08-25',
  userMessage: 'planifie la visite le 24 août à 15 heures',
  now: fridayAug21Toronto,
});
assert.strictEqual(explicitFrench.date, '2026-08-24');
assert.strictEqual(explicitFrench.heure, '15:00');

const contradiction = normalizeScheduledAction({
  date: '2026-08-25',
  userMessage: 'planifie la visite lundi 25 août à 15h',
  now: fridayAug21Toronto,
});
assert.strictEqual(contradiction.ok, false);
assert.match(contradiction.error, /ne correspond pas|contradictoires/);

const sameDayAmbiguous = normalizeScheduledAction({
  date: '2026-08-21',
  userMessage: 'planifie la visite vendredi à 15h',
  now: fridayAug21Toronto,
});
assert.strictEqual(sameDayAmbiguous.ok, false);
assert.match(sameDayAmbiguous.error, /ambigu/);

const sameDayExplicit = normalizeScheduledAction({
  date: '2026-08-21',
  userMessage: 'planifie la visite aujourd’hui vendredi à 15h',
  now: fridayAug21Toronto,
});
assert.strictEqual(sameDayExplicit.ok, true);
assert.strictEqual(sameDayExplicit.date, '2026-08-21');

console.log('✅ Calendar guard: weekday/date/time normalization OK');
