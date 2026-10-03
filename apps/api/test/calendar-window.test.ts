import {describe,it,expect} from 'vitest';
import {inferredCalendarWindow} from '../src/calendar-window.ts';
describe('calendar language proposal window',()=>{
  // Jueves 1-oct-2026, 17:00 en Bogotá.
  const reference=Date.parse('2026-10-01T22:00:00Z');
  it('recognizes selected request for two or three dates next week in owner timezone',()=>{
    expect(inferredCalendarWindow('De Anáhuac me das otras dos fechas la próxima semana. Por fa que tengas libre. O 3','America/Bogota',reference,reference)).toEqual({from:'2026-10-05T05:00:00.000Z',to:'2026-10-12T04:59:59.000Z',durationMin:30,timezone:'America/Bogota',startHour:9,endHour:18});
  });
  it('uses daylight-saving offset and explicit duration',()=>{
    const r=inferredCalendarWindow('Meeting dates next week for 45 minutes','America/New_York',Date.parse('2026-10-30T16:00:00Z'),reference);
    expect(r?.from).toBe('2026-11-02T05:00:00.000Z');expect(r?.durationMin).toBe(45);
  });
  it('without a date word checks the next 7 days instead of asking',()=>{
    const r=inferredCalendarWindow('Reunión cuando puedas','America/Bogota',reference,reference);
    expect(r?.from).toBe('2026-10-01T05:00:00.000Z');expect(r?.to).toBe('2026-10-09T04:59:59.000Z');
    expect(inferredCalendarWindow('¿Cuándo tengo disponibilidad?','America/Bogota',reference,reference)).not.toBeNull();
  });
  it('understands weekdays, today, tomorrow and one hour',()=>{
    const jueves=inferredCalendarWindow('agenda el jueves una hora con Josué','America/Bogota',reference,reference);
    expect(jueves?.from).toBe('2026-10-08T05:00:00.000Z');expect(jueves?.durationMin).toBe(60);
    expect(inferredCalendarWindow('¿estoy libre mañana?','America/Bogota',reference,reference)?.from).toBe('2026-10-02T05:00:00.000Z');
    const both=inferredCalendarWindow('Fechas mañana o la próxima semana','America/Bogota',reference,reference);
    expect(both?.from).toBe('2026-10-02T05:00:00.000Z');expect(both?.to).toBe('2026-10-12T04:59:59.000Z');
  });
  it('returns null for non-calendar text, foreign zones, stale messages or invalid duration',()=>{
    for(const text of ['Próxima semana voy a descansar','Fechas la próxima semana 9am mx','Meeting tomorrow for 5 minutes']) expect(inferredCalendarWindow(text,'America/Bogota',reference,reference)).toBeNull();
    expect(inferredCalendarWindow('Fechas la próxima semana','America/Bogota',Date.parse('2026-01-01'),reference)).toBeNull();
  });
});
