import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { differenceInCalendarDays, isBefore, parseISO, startOfDay } from 'date-fns';
import { useBookingsContext } from '@/hooks/BookingsContext';

export type CriticalKind = 'missed_checkin' | 'missed_checkout';

export interface CriticalNotification {
  id: string;
  bookingId: string;
  roomNumber: number;
  guestName: string;
  kind: CriticalKind;
  scheduledISO: string;
  overdueMinutes: number;
  title: string;
  detail: string;
}

interface NotificationsCtx {
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  panelWidth: number;
  setPanelWidth: (w: number) => void;
  critical: CriticalNotification[];
  criticalBookingIds: Set<string>;
  criticalCount: number;
  focusBookingRequest: string | null;
  requestFocusBooking: (id: string) => void;
  clearFocusRequest: () => void;
}

const Ctx = createContext<NotificationsCtx | null>(null);

function localGetNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}
function localGetBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { bookings } = useBookingsContext();
  const [panelOpen, setPanelOpen] = useState<boolean>(() => localGetBool('notif.panel.open', false));
  const [panelWidth, _setPanelWidth] = useState<number>(() =>
    localGetNumber('notif.panel.width', typeof window !== 'undefined' ? Math.round(window.innerWidth / 4) : 380),
  );
  const [focusBookingRequest, setFocusBookingRequest] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem('notif.panel.open', panelOpen ? '1' : '0'); } catch { /* noop */ }
  }, [panelOpen]);

  const setPanelWidth = useCallback((w: number) => {
    const clamped = Math.max(280, Math.min(typeof window !== 'undefined' ? window.innerWidth - 200 : 800, w));
    _setPanelWidth(clamped);
    try { window.localStorage.setItem('notif.panel.width', String(clamped)); } catch { /* noop */ }
  }, []);

  const critical = useMemo<CriticalNotification[]>(() => {
    const today = startOfDay(now);
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const out: CriticalNotification[] = [];
    for (const b of bookings) {
      // Missed check-in: booking is still in a pre-arrival state but scheduled check-in has passed.
      if (b.status === 'booked' || b.status === 'confirmed' || b.status === 'pending') {
        const ci = parseISO(b.checkIn);
        let overdue = false;
        let overdueMinutes = 0;
        if (isBefore(ci, today)) {
          overdue = true;
          overdueMinutes = differenceInCalendarDays(today, ci) * 24 * 60 + minutesNow;
        } else if (!isBefore(today, ci) && !isBefore(ci, today)) {
          // The effective check-in deadline is the end of the check-in
          // day (23:59). The red critical strip + notification must
          // appear exactly one hour before that — at 22:59 — and stay
          // in place until the admin manually checks the guest in.
          // Early half-day arrivals keep their 08:00 threshold.
          const threshold = b.checkInHalfDay ? 8 * 60 : (22 * 60 + 59);
          if (minutesNow >= threshold) {
            overdue = true;
            overdueMinutes = minutesNow - threshold;
          }
        }
        if (overdue) {
          out.push({
            id: `ci_${b.id}`,
            bookingId: b.id,
            roomNumber: b.roomNumber,
            guestName: (b.guestName || '').trim() || `#${b.roomNumber}`,
            kind: 'missed_checkin',
            scheduledISO: b.checkIn,
            overdueMinutes,
            title: 'Missed check-in',
            detail: `Room ${b.roomNumber} — scheduled check-in on ${b.checkIn} (${b.checkInHalfDay ? '08:00 early' : '23:59'}) has passed but the guest has not been checked in yet.`,
          });
        }
      }
      // Missed check-out: guest is still in-house but scheduled check-out has passed.
      if (b.status === 'in-house') {
        const co = parseISO(b.checkOut);
        let overdue = false;
        let overdueMinutes = 0;
        if (isBefore(co, today)) {
          overdue = true;
          overdueMinutes = differenceInCalendarDays(today, co) * 24 * 60 + minutesNow;
        } else if (!isBefore(today, co) && !isBefore(co, today)) {
          const threshold = b.checkOutHalfDay ? 14 * 60 : 12 * 60;
          if (minutesNow >= threshold) {
            overdue = true;
            overdueMinutes = minutesNow - threshold;
          }
        }
        if (overdue) {
          out.push({
            id: `co_${b.id}`,
            bookingId: b.id,
            roomNumber: b.roomNumber,
            guestName: (b.guestName || '').trim() || `#${b.roomNumber}`,
            kind: 'missed_checkout',
            scheduledISO: b.checkOut,
            overdueMinutes,
            title: 'Missed check-out',
            detail: `Room ${b.roomNumber} — scheduled check-out on ${b.checkOut} (${b.checkOutHalfDay ? '14:00 late' : '12:00'}) has passed but the guest has not been checked out yet.`,
          });
        }
      }
    }
    out.sort((a, b) => b.overdueMinutes - a.overdueMinutes);
    return out;
  }, [bookings, now]);

  const criticalBookingIds = useMemo(() => new Set(critical.map((c) => c.bookingId)), [critical]);

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const togglePanel = useCallback(() => setPanelOpen((v) => !v), []);
  const requestFocusBooking = useCallback((id: string) => setFocusBookingRequest(id), []);
  const clearFocusRequest = useCallback(() => setFocusBookingRequest(null), []);

  const value = useMemo<NotificationsCtx>(() => ({
    panelOpen, openPanel, closePanel, togglePanel,
    panelWidth, setPanelWidth,
    critical, criticalBookingIds, criticalCount: critical.length,
    focusBookingRequest, requestFocusBooking, clearFocusRequest,
  }), [panelOpen, openPanel, closePanel, togglePanel, panelWidth, setPanelWidth, critical, criticalBookingIds, focusBookingRequest, requestFocusBooking, clearFocusRequest]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifications(): NotificationsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNotifications must be used within NotificationsProvider');
  return v;
}
