import {describe,it,expect} from 'vitest';
import {inferredCalendarWindow} from '../src/calendar-window.ts';
describe('calendar language proposal window',()=>{
  const reference=Date.parse('2026-10-01T22:00:00Z');
  it('recognizes selected request for two or three dates next week in owner timezone',()=>{
    expect(inferredCalendarWindow('De Anáhuac me das otras dos fechas la próxima semana. Por fa que tengas libre. O 3','America/Bogota',reference,reference)).toEqual({from:'2026-10-05T05:00:00.000Z',to:'2026-10-12T04:59:59.000Z',durationMin:30,timezone:'America/Bogota',startHour:9,endHour:18});
  });
  it('uses daylight-saving offset and explicit duration',()=>{
    const r=inferredCalendarWindow('Meeting dates next week for 45 minutes','America/New_York',Date.parse('2026-10-30T16:00:00Z'),reference);
    expect(r?.from).toBe('2026-11-02T05:00:00.000Z');expect(r?.durationMin).toBe(45);
  });
  it('asks for clarification for ambiguous dates, zones, stale messages or invalid duration',()=>{
    for(const text of ['Próxima semana voy a descansar','Reunión cuando puedas','Fechas mañana o la próxima semana','Fechas la próxima semana 9am mx','Meeting tomorrow for 5 minutes']) expect(inferredCalendarWindow(text,'America/Bogota',reference,reference)).toBeNull();
    expect(inferredCalendarWindow('Fechas la próxima semana','America/Bogota',Date.parse('2026-01-01'),reference)).toBeNull();
  });
});
