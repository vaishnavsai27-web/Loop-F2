// A small, fixed icon set (24px grid, 1.75 stroke). Only icons with a job are here.
const PATHS = {
  discover: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 13.5c1.2 1.6 5.8 1.6 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  library: <><path d="M5 4v16M10 4v16" /><path d="m14.5 4.5 4.5 15" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor" stroke="none" />,
  pause: <><path d="M8 5h3v14H8zM13.5 5h3v14h-3z" fill="currentColor" stroke="none" /></>,
  similar: <><circle cx="9" cy="12" r="5" /><circle cx="15" cy="12" r="5" /></>,
  out: <><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  studio: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>,
  shield: <path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3Z" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-2-4.7" /></>,
  inbox: <><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5.5 5h13L21 13v6H3v-6l2.5-8Z" /></>,
  upload: <><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4 15v5h16v-5" /></>,
  disc: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2" /></>,
  file: <><path d="M14 3H6v18h12V7l-4-4Z" /><path d="M14 3v4h4" /></>,
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2" /></>,
  home: <path d="M4 11 12 4l8 7v9h-5v-6H9v6H4v-9Z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  slash: <><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  back: <path d="M15 5 8 12l7 7" />,
  next: <><path d="M6 5.5v13L15 12 6 5.5Z" fill="currentColor" stroke="none" /><path d="M18 5v14" /></>,
  prev: <><path d="M18 5.5v13L9 12l9-6.5Z" fill="currentColor" stroke="none" /><path d="M6 5v14" /></>,
  queue: <><path d="M4 6h12M4 11h12M4 16h7" /><path d="M16 14v6l4-3-4-3Z" fill="currentColor" stroke="none" /></>,
  volume: <><path d="M4 10v4h4l5 4V6L8 10H4Z" /><path d="M16.5 9a4 4 0 0 1 0 6" /></>,
  mute: <><path d="M4 10v4h4l5 4V6L8 10H4Z" /><path d="m17 10 4 4M21 10l-4 4" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  layers: <><path d="m12 4 9 5-9 5-9-5 9-5Z" /><path d="m3 14 9 5 9-5" /></>,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" /></>,
  tag: <><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1.2" /></>,
};

export default function Icon({ name, size = 20, label }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {PATHS[name]}
    </svg>
  );
}

export function Mark({ size = 26 }) {
  // Two overlapping rings: the loop between how you feel and what you hear.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="12" cy="16" r="8.5" fill="none" stroke="#191B2B" strokeWidth="2.6" />
      <circle cx="20" cy="16" r="8.5" fill="none" stroke="#3B47D6" strokeWidth="2.6" />
    </svg>
  );
}
