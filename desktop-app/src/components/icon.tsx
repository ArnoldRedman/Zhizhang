import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'book-open'
  | 'library'
  | 'scissors'
  | 'chart'
  | 'sparkles'
  | 'pen'
  | 'more'
  | 'settings'
  | 'arrow-left'
  | 'arrow-right'
  | 'search'
  | 'highlighter'
  | 'ban'
  | 'history'
  | 'bar-chart'
  | 'download'
  | 'keyboard'
  | 'save'
  | 'plus'
  | 'x'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-right'
  | 'folder-open'
  | 'trash'
  | 'file-plus'
  | 'pencil'
  | 'network'
  | 'cards'
  | 'memory'
  | 'scan'
  | 'check'
  | 'alert'
  | 'refresh'
  | 'upload'
  | 'send'
  | 'copy'
  | 'archive';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

const icons: Record<IconName, ReactNode> = {
  'book-open': <>
    <path d="M3.5 5.5c3.2-.2 6 .7 8.5 2.8v11.2c-2.5-2.1-5.3-3-8.5-2.8V5.5Z" />
    <path d="M20.5 5.5c-3.2-.2-6 .7-8.5 2.8v11.2c2.5-2.1 5.3-3 8.5-2.8V5.5Z" />
    <path d="M12 8.3v11.2" />
  </>,
  library: <>
    <path d="M5 4.5h12.5A1.5 1.5 0 0 1 19 6v13.5H6.5A1.5 1.5 0 0 1 5 18V4.5Z" />
    <path d="M5 18a2 2 0 0 0 2 2h12M8.5 8h7M8.5 11.5h7M8.5 15h4" />
  </>,
  scissors: <>
    <circle cx="6.5" cy="7" r="2.5" />
    <circle cx="6.5" cy="17" r="2.5" />
    <path d="m8.5 8.5 10-5M8.5 15.5l10 5M8.5 12 20 12" />
  </>,
  chart: <>
    <path d="M3.5 16.5 9 11l3.5 3.5L20 6.5" />
    <path d="M14.5 6.5H20V12" />
  </>,
  sparkles: <>
    <path d="m12 3 1.1 3.9L17 8l-3.9 1.1L12 13l-1.1-3.9L7 8l3.9-1.1L12 3ZM19 13l.7 2.3L22 16l-2.3.7L19 19l-.7-2.3L16 16l2.3-.7L19 13ZM5 14l.6 1.9L7.5 16l-1.9.6L5 18.5l-.6-1.9L2.5 16l1.9-.6L5 14Z" />
  </>,
  pen: <>
    <path d="m4 20 3.8-1 10.9-10.9a2.1 2.1 0 0 0-3-3L4.8 16 4 20Z" />
    <path d="m14.5 6.5 3 3M4 20l3.8-1" />
  </>,
  more: <>
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  </>,
  settings: <>
    <path d="M12 3.5 13.2 5a7.5 7.5 0 0 1 2 .8l1.8-.4 1.5 1.5-.4 1.8a7.5 7.5 0 0 1 .8 2L20.5 12l-1.6 1.3a7.5 7.5 0 0 1-.8 2l.4 1.8-1.5 1.5-1.8-.4a7.5 7.5 0 0 1-2 .8L12 20.5l-1.3-1.6a7.5 7.5 0 0 1-2-.8l-1.8.4-1.5-1.5.4-1.8a7.5 7.5 0 0 1-.8-2L3.5 12l1.5-1.3a7.5 7.5 0 0 1 .8-2l-.4-1.8 1.5-1.5 1.8.4a7.5 7.5 0 0 1 2-.8L12 3.5Z" />
    <circle cx="12" cy="12" r="2.5" />
  </>,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  search: <>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m16 16 4.5 4.5" />
  </>,
  highlighter: <>
    <path d="m14.5 4.5 5 5-8.8 8.8H5.7v-5.1l8.8-8.7Z" />
    <path d="M4 20h8M16.5 6.5l5 5" />
  </>,
  ban: <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </>,
  history: <>
    <path d="M4.5 8.5A8 8 0 1 1 4 13" />
    <path d="M4.5 4.5v4h4M12 7v5l3 2" />
  </>,
  'bar-chart': <>
    <path d="M6.5 19.5V13M12 19.5V8M17.5 19.5V4.5M3.5 19.5h17" />
  </>,
  download: <>
    <path d="M12 3v12M7 10l5 5 5-5M4 20h16" />
  </>,
  keyboard: <>
    <rect x="3" y="6.5" width="18" height="11" rx="1.8" />
    <path d="M6.5 10h.1M9.5 10h.1M12.5 10h.1M15.5 10h.1M18.5 10h.1M6.5 13.5h.1M9.5 13.5h5M17.5 13.5h.1" />
  </>,
  save: <>
    <path d="M5 3.5h11l3 3v14H5v-17Z" />
    <path d="M8 3.5v5h7v-5M8.5 20.5v-6h7v6" />
  </>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  'chevron-up': <path d="m5 14 7-7 7 7" />,
  'chevron-down': <path d="m5 10 7 7 7-7" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'folder-open': <>
    <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-15v-13.5Z" />
    <path d="M3 11h18" />
  </>,
  trash: <>
    <path d="M5 7h14M10 4h4l1 3H9l1-3ZM7 7l.8 13h8.4L17 7M10 10.5v6M14 10.5v6" />
  </>,
  'file-plus': <>
    <path d="M6 3.5h8l4 4v13H6v-17Z" />
    <path d="M14 3.5v4h4M12 11v6M9 14h6" />
  </>,
  pencil: <>
    <path d="m4 20 4-.9L19 8.1a2.2 2.2 0 0 0-3.1-3.1L4.9 16 4 20Z" />
    <path d="m14.5 6.5 3 3" />
  </>,
  network: <>
    <circle cx="5" cy="12" r="2" />
    <circle cx="18.5" cy="6" r="2" />
    <circle cx="18.5" cy="18" r="2" />
    <path d="m6.8 11.2 9.9-4.4M6.8 12.8l9.9 4.4" />
  </>,
  cards: <>
    <rect x="4" y="5" width="13" height="15" rx="1.5" />
    <path d="M7 8.5h7M7 12h5M8 3.5h11a1.5 1.5 0 0 1 1.5 1.5v12" />
  </>,
  memory: <>
    <path d="M5 5.5h14v13H5zM8 3v2.5M12 3v2.5M16 3v2.5M8 18.5V21M12 18.5V21M16 18.5V21M3 9h2M3 13h2M19 9h2M19 13h2" />
    <path d="M8.5 9.5h7M8.5 13h4" />
  </>,
  scan: <>
    <path d="M5 4H3.5v4M19 4h1.5v4M5 20H3.5v-4M19 20h1.5v-4" />
    <path d="M7 12h10" />
  </>,
  check: <path d="m5 12 4 4L19 6" />,
  alert: <>
    <path d="M12 4.5 21.5 20h-19L12 4.5Z" />
    <path d="M12 10.5v4M12 17.2h.01" />
  </>,
  refresh: <>
    <path d="M20 11a8 8 0 0 0-14.5-4L4 9M4 5v4h4M4 13a8 8 0 0 0 14.5 4L20 15M20 19v-4h-4" />
  </>,
  upload: <>
    <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
  </>,
  send: <>
    <path d="m21 3-7.5 18-3.3-7.2L3 10.5 21 3Z" />
    <path d="M10.2 13.8 21 3" />
  </>,
  copy: <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>,
  archive: <>
    <path d="M4 7h16v13H4V7ZM3 4h18v3H3V4Z" />
    <path d="M9 11h6" />
  </>,
};

export function Icon({ name, size = 16, className, ...props }: IconProps) {
  return (
    <svg
      {...props}
      className={`ui-icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name]}
    </svg>
  );
}
