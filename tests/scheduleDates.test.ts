import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays, addMonths, calendarDays, daysBetween, endOfMonth, formatDateOnly, formatDateRange, formatMonth, isDateOnly,
  isSameMonth, jobsByDay, monthGridDays, overlaps, shiftFocus, startOfMonth, startOfWeek,
  todayDateOnly, weekDays,
} from '../src/lib/scheduleDates.ts'

test('date-only values never shift with the timezone', () => {
  const tz = process.env.TZ
  for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
    process.env.TZ = zone
    assert.equal(formatDateOnly('2026-11-02'), 'Nov 2, 2026', zone)
    assert.equal(addDays('2026-11-01', 1), '2026-11-02', `${zone} across the US DST change`)
    assert.equal(addDays('2026-03-08', 1), '2026-03-09', zone)
  }
  process.env.TZ = tz
})

test('today is the local calendar date', () => {
  assert.equal(todayDateOnly(new Date(2026, 9, 7, 23, 30)), '2026-10-07')
  assert.equal(todayDateOnly(new Date(2026, 0, 1, 0, 5)), '2026-01-01')
})

test('weeks run Monday to Sunday across month and year boundaries', () => {
  assert.equal(startOfWeek('2026-10-07'), '2026-10-05') // Wednesday
  assert.equal(startOfWeek('2026-10-05'), '2026-10-05') // Monday
  assert.equal(startOfWeek('2026-10-11'), '2026-10-05') // Sunday
  assert.equal(startOfWeek('2027-01-01'), '2026-12-28')
  assert.deepEqual(weekDays('2026-12-28'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'])
  assert.equal(addDays('2026-10-05', -7), '2026-09-28')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
})

test('multi-day jobs appear on every day they span, including into the week', () => {
  const days = weekDays('2026-10-05')
  const jobs = [
    { id: 'spans-in', start_date: '2026-09-30', estimated_ready_date: '2026-10-06' },
    { id: 'inside', start_date: '2026-10-07', estimated_ready_date: '2026-10-07' },
    { id: 'spans-out', start_date: '2026-10-10', estimated_ready_date: '2026-10-20' },
    { id: 'overlap', start_date: '2026-10-06', estimated_ready_date: '2026-10-08' },
    { id: 'outside', start_date: '2026-10-12', estimated_ready_date: '2026-10-13' },
  ]
  const byDay = jobsByDay(jobs, days)
  const ids = (d: string) => byDay.get(d)!.map((j) => j.id)
  assert.deepEqual(ids('2026-10-05'), ['spans-in'])
  assert.deepEqual(ids('2026-10-06'), ['spans-in', 'overlap'])
  assert.deepEqual(ids('2026-10-07'), ['inside', 'overlap'])
  assert.deepEqual(ids('2026-10-11'), ['spans-out'])
  assert.ok(!days.some((d) => ids(d).includes('outside')))
  assert.equal(overlaps('2026-09-30', '2026-10-05', '2026-10-05', '2026-10-11'), true)
  assert.equal(overlaps('2026-09-30', '2026-10-04', '2026-10-05', '2026-10-11'), false)
})

test('validation and formatting helpers', () => {
  assert.equal(isDateOnly('2026-02-29'), false)
  assert.equal(isDateOnly('2028-02-29'), true)
  assert.equal(isDateOnly('2026-1-5'), false)
  assert.equal(daysBetween('2026-10-05', '2026-10-12'), 7)
  assert.equal(formatDateRange('2026-10-05', '2026-10-05'), 'Mon, Oct 5')
  assert.equal(formatDateRange('2026-12-30', '2027-01-04'), 'Dec 30 – Jan 4, 2027')
})

test('month navigation crosses year boundaries and lands on the 1st', () => {
  assert.equal(startOfMonth('2026-10-31'), '2026-10-01')
  assert.equal(addMonths('2026-12-15', 1), '2027-01-01')
  assert.equal(addMonths('2027-01-31', -1), '2026-12-01')
  assert.equal(addMonths('2026-01-31', 1), '2026-02-01', 'no day overflow into March')
  assert.equal(addMonths('2026-10-01', -22), '2024-12-01')
  assert.equal(addMonths('2026-10-01', 15), '2028-01-01')
  assert.equal(shiftFocus('month', '2026-12-09', 1), '2027-01-01')
  assert.equal(shiftFocus('month', '2027-01-01', -1), '2026-12-01')
  assert.equal(shiftFocus('week', '2026-12-30', 1), '2027-01-04')
  assert.equal(formatMonth('2027-01-01'), 'January 2027')
  assert.equal(isSameMonth('2026-12-31', '2027-01-01'), false)
})

test('February lengths, including leap years', () => {
  assert.equal(endOfMonth('2028-02-10'), '2028-02-29')
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28')
  assert.equal(endOfMonth('2100-02-01'), '2100-02-28', 'century years are not leap years')
  assert.equal(endOfMonth('2000-02-01'), '2000-02-29')
  const feb2028 = monthGridDays('2028-02-15')
  assert.ok(feb2028.includes('2028-02-29'))
  assert.equal(feb2028.filter((d) => isSameMonth(d, '2028-02-01')).length, 29)
})

test('month grids are whole Monday–Sunday weeks covering the month', () => {
  for (const month of ['2026-10-01', '2026-11-01', '2027-02-01', '2028-02-01', '2026-03-01', '2027-08-01']) {
    const days = monthGridDays(month)
    assert.equal(days.length % 7, 0, month)
    assert.ok(days.length >= 28 && days.length <= 42, month)
    assert.equal(days[0], startOfWeek(days[0]), `${month} starts on a Monday`)
    assert.ok(days[0] <= month && days.at(-1)! >= endOfMonth(month), `${month} fully covered`)
    assert.ok(days.slice(1).every((d, i) => d === addDays(days[i], 1)), `${month} contiguous`)
  }
  assert.deepEqual([monthGridDays('2026-10-01')[0], monthGridDays('2026-10-01').at(-1)], ['2026-09-28', '2026-11-01'])
  assert.equal(monthGridDays('2027-02-01').length, 28, 'Feb 2027 starts on a Monday: four rows')
  assert.equal(monthGridDays('2026-08-01').length, 42, 'Aug 2026 starts on a Saturday: six rows')
  // Year boundary: the December 2026 grid runs into January 2027.
  const dec = monthGridDays('2026-12-01')
  assert.deepEqual([dec[0], dec.at(-1)], ['2026-11-30', '2027-01-03'])
  assert.deepEqual(calendarDays('week', '2026-12-31'), weekDays('2026-12-28'))
  assert.deepEqual(calendarDays('month', '2026-12-31'), dec)
})

test('month view shows spanning and overlapping jobs on every date they cover', () => {
  const days = monthGridDays('2026-12-01') // Nov 30 – Jan 3
  const jobs = [
    { id: 'from-november', start_date: '2026-11-25', estimated_ready_date: '2026-12-02' },
    { id: 'into-january', start_date: '2026-12-29', estimated_ready_date: '2027-01-08' },
    { id: 'overlap-a', start_date: '2026-12-14', estimated_ready_date: '2026-12-16' },
    { id: 'overlap-b', start_date: '2026-12-15', estimated_ready_date: '2026-12-15' },
    { id: 'overlap-c', start_date: '2026-12-10', estimated_ready_date: '2026-12-20' },
  ]
  const byDay = jobsByDay(jobs, days)
  const on = (id: string) => days.filter((d) => byDay.get(d)!.some((j) => j.id === id))
  assert.deepEqual(on('from-november'), ['2026-11-30', '2026-12-01', '2026-12-02'])
  assert.deepEqual(on('into-january'), ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'])
  assert.deepEqual(byDay.get('2026-12-15')!.map((j) => j.id), ['overlap-a', 'overlap-b', 'overlap-c'])
  assert.equal(on('overlap-c').length, 11)
  // The loaded range is the whole grid, so jobs touching only the leading or
  // trailing days are fetched too.
  assert.equal(overlaps('2026-11-20', '2026-11-30', days[0], days.at(-1)!), true)
  assert.equal(overlaps('2027-01-04', '2027-01-09', days[0], days.at(-1)!), false)
})
