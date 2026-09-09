// Ikonstier (24×24 strek) for navigasjonen, hentet fra det endelige designet.
export const NAV_ICONS = {
  servers: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01',
  containers: 'M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8M12 12v8',
  logs: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  alerts: 'M6 16V11a6 6 0 0112 0v5l2 2H4l2-2zM10 20a2 2 0 004 0',
  settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
} as const;
export type NavIconKey = keyof typeof NAV_ICONS;
