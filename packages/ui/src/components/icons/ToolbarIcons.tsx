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
      className={className ? `oc-stroke-icon ${className}` : 'oc-stroke-icon'}
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

export function NewChatIcon(props: ToolbarIconProps) {
  return (
    <ToolbarIcon {...props}>
      <path d="M13.25 6.75H6.25A4.25 4.25 0 0 0 2 11v4.25a4.25 4.25 0 0 0 4.25 4.25h10.5A4.25 4.25 0 0 0 21 15.25V11.5" />
      <path d="M8 19.5v2.4l3.25-2.4" />
      <path d="M16.9 5h4.2" />
      <path d="M19 2.9v4.2" />
    </ToolbarIcon>
  );
}
