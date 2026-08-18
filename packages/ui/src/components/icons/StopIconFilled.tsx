import type { SVGProps } from 'react';

export function StopIconFilled(props: SVGProps<SVGSVGElement>) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            fill="currentColor"
            viewBox="0 0 256 256"
            {...props}
        >
            {/* Sharp square drawn as a path: global index.css forces `button svg rect { fill: none }`. */}
            <path d="M60 60H196V196H60Z" />
        </svg>
    );
}
