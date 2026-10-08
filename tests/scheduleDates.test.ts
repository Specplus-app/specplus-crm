import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays, daysBetween, formatDateOnly, formatDateRange, isDateOnly, jobsByDay, overlaps, startOfWeek,
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
