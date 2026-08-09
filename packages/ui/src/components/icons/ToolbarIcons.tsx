import type { SVGProps } from 'react';

type ToolbarIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

type SidebarIconProps = ToolbarIconProps & {
  chevronDirection?: 'left' | 'right';
};

const SIDEBAR_CHEVRON_PATH = {
  left: 'M14.5 9.5 12 12l2.5 2.5',
  right: 'm9.5 9.5 2.5 2.5-2.5 2.5',
} as const;

function ToolbarIcon({ size, className, style, children, ...props }: ToolbarIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size ?? '1em'}
      height={size ?? '1em'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SidebarLeftIcon({ chevronDirection = 'left', ...props }: SidebarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="4" />
      <path d="M9 4.5v15" />
      <path d={SIDEBAR_CHEVRON_PATH[chevronDirection]} />
    </ToolbarIcon>
  );
}

export function SidebarRightIcon({ chevronDirection = 'right', ...props }: SidebarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="4" />
      <path d="M15 4.5v15" />
      <path d={SIDEBAR_CHEVRON_PATH[chevronDirection]} />
    </ToolbarIcon>
  );
}

export function SidebarLeftExpandIcon(props: ToolbarIconProps) {
  return <SidebarLeftIcon {...props} chevronDirection="right" />;
}

export function SidebarLeftCollapseIcon(props: ToolbarIconProps) {
  return <SidebarLeftIcon {...props} chevronDirection="left" />;
}

export function SidebarRightExpandIcon(props: ToolbarIconProps) {
  return <SidebarRightIcon {...props} chevronDirection="left" />;
}

export function SidebarRightCollapseIcon(props: ToolbarIconProps) {
  return <SidebarRightIcon {...props} chevronDirection="right" />;
}

export function TerminalPanelIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="4" />
      <path d="m8 10 2.25 2L8 14" />
      <path d="M13 14h3" />
    </ToolbarIcon>
  );
}

export function ServicesIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <circle cx="6.75" cy="7.25" r="2" />
      <circle cx="17.25" cy="7.25" r="2" />
      <circle cx="17.25" cy="16.75" r="2" />
      <path d="m8.55 8.1 1.7 1.55" />
      <path d="m15.45 8.1-1.7 1.55" />
      <path d="m14.25 14.15 1.45 1.3" />
    </ToolbarIcon>
  );
}

export function PlanDocumentIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <path d="M8 3.75h5.5L18 8.25V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5.75a2 2 0 0 1 2-2Z" />
      <path d="M13.25 4v4.5h4.5" />
      <path d="M9 13h6" />
      <path d="M9 16.5h4" />
    </ToolbarIcon>
  );
}

export function NewChatIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <path d="M5.75 18.25 4 20l.75-3.25V7.25a3 3 0 0 1 3-3h8.5a3 3 0 0 1 3 3v5.5" />
      <path d="M8.25 9h5.5" />
      <path d="M8.25 12.25h3.5" />
      <path d="m14.25 18.75 4.95-4.95a1.55 1.55 0 0 1 2.2 2.2l-4.95 4.95-2.7.55.5-2.75Z" />
    </ToolbarIcon>
  );
}

export function AddFolderIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <path d="M4 8.25v9a2.25 2.25 0 0 0 2.25 2.25h11.5A2.25 2.25 0 0 0 20 17.25v-7a2.25 2.25 0 0 0-2.25-2.25h-6.5L9.4 5.9A2.25 2.25 0 0 0 7.7 5.1H6.25A2.25 2.25 0 0 0 4 7.35" />
      <path d="M4.5 10.25h15" />
    </ToolbarIcon>
  );
}

export function TuneSlidersIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <path d="M5 7.5h5" />
      <path d="M14 7.5h5" />
      <circle cx="12" cy="7.5" r="2" />
      <path d="M5 16.5h3" />
      <path d="M12 16.5h7" />
      <circle cx="10" cy="16.5" r="2" />
    </ToolbarIcon>
  );
}

export function SoftSettingsIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props} strokeWidth="1.7">
      <circle cx="12" cy="12" r="3" fill="none" />
      <path
        fill="none"
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 5 15.08 1.65 1.65 0 0 0 3.49 14H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8.92 1.65 1.65 0 0 0 4.27 7.1l-.06-.06A2 2 0 1 1 7.04 4.2l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z"
      />
    </ToolbarIcon>
  );
}
