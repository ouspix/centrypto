import { useId } from "react";
import { BarChart3, Compass, Layers, Newspaper, ShieldCheck } from "lucide-react";
import type { DeskRole } from "@/lib/desk/roles";

const symbols = {
    catalyst: Newspaper, derivatives: BarChart3, execution: Layers, risk: ShieldCheck, lead: Compass,
};

export function AnalystStation({ role }: { role: DeskRole }) {
    const id = useId().replace(/:/g, "");
    const Symbol = symbols[role];
    const mirror = role === "derivatives" || role === "risk";
    return (
        <svg className="office-station-art" viewBox="0 0 230 162" aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id={id + "-wood"} x2="1" y2=".55" gradientUnits="objectBoundingBox">
                    <stop stopColor="#eed3a0" /><stop offset=".5" stopColor="#d2a974" /><stop offset="1" stopColor="#ba8a60" />
                </linearGradient>
                <linearGradient id={id + "-glass"} x2=".7" y2="1" gradientUnits="objectBoundingBox">
                    <stop stopColor="#284e57" /><stop offset="1" stopColor="#112733" />
                </linearGradient>
                <radialGradient id={id + "-shadow"}>
                    <stop stopColor="#061218" stopOpacity=".65" /><stop offset="1" stopColor="#061218" stopOpacity="0" />
                </radialGradient>
                <image id={id + "-person"} href={"/desk/analysts/" + role + ".png"} x="0" y="0" width="145" height="151" />
                <clipPath id={id + "-hands"}><path d="M66 68 117 60 118 81 75 89Z" /></clipPath>
            </defs>
            <g transform={mirror ? "translate(230 0) scale(-1 1)" : undefined}>
                <ellipse cx="120" cy="140" rx="97" ry="17" fill={"url(#" + id + "-shadow)"} />
                <g fill="none" stroke="#273838" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m58 95 1 29m0 0-18 10m18-10 20 6m-20-6-4 13" strokeWidth="4" />
                    <path d="m40 56 3 29q0 6 7 8l25 5" strokeWidth="9" />
                </g>
                <path d="m39 54 16-3q8-1 9 7l3 23-24 4-8-22q-2-7 4-9Z" fill="#43646a" />
                <path d="m40 88 31-6 18 10-28 7q-13 0-21-6Z" fill="#304b52" />
                <use className="office-character" href={"#" + id + "-person"} />
                <g strokeLinecap="round" fill="none">
                    <path d="m78 84-1 40m89-56-1 44" stroke="#435457" strokeWidth="5" />
                    <path d="m113 99-1 47m88-67 1 46" stroke="#263d43" strokeWidth="6" />
                    <path d="m114 103-1 37m89-59 1 40" stroke="#879792" strokeWidth="1.2" />
                </g>
                <path d="m68 79 98-22 42 18-99 25-41-17Z" fill={"url(#" + id + "-wood)"} stroke="#ae916b" strokeWidth="1" />
                <path d="m68 80 41 17 99-23v5l-99 24-41-18Z" fill="#906c4f" />
                <path d="m69 80 40 17 98-23" fill="none" stroke="#f3d9a7" strokeWidth="1.7" />
                <g transform="matrix(1 -.23 .72 .4 81 80)">
                    <rect width="33" height="17" rx="2" fill="#43585b" />
                    <path d="M3 4h26M4 8h25M6 12h20" stroke="#b9c6bb" strokeWidth="1.6" strokeDasharray="3 1.4" />
                </g>
                <g clipPath={"url(#" + id + "-hands)"}>
                    <g className="office-typing-hands"><use className="office-character" href={"#" + id + "-person"} /></g>
                </g>
                <path d="m145 75 13-3 11 4-13 3Z" fill="#526164" />
                <path d="m153 62 5-1 1 13-5 1Z" fill="#384b50" />
                <g transform="translate(128 38) skewY(-12)">
                    <rect x="2" y="1" width="55" height="33" rx="3" fill="#253f45" />
                    <rect width="55" height="32" rx="3" fill="#587075" />
                    <rect x="2.5" y="2.5" width="50" height="26" rx="1" fill={"url(#" + id + "-glass)"} />
                    <g className="office-monitor-ink" stroke="#8eb5ae" fill="none">
                        <Symbol x="6" y="7" width="15" height="15" strokeWidth="1.6" />
                        <path d="M26 10h18m-18 5h12m-12 5h16" strokeWidth="1.6" />
                    </g>
                    <path className="office-monitor-scan" d="M4 5h46" stroke="#8ffed6" strokeWidth="1" />
                    <circle cx="49" cy="30" r="1" fill="#c2d6b8" />
                </g>
                <g transform="translate(183 69)">
                    <path d="M4-4q8-2 5 4Q8 3 4 2" stroke="#dbbb9c" fill="none" strokeWidth="2" />
                    <path d="M-4-5h10L5 1Q1 5-3 2Z" fill="#ddbb97" />
                    <ellipse cx="1" cy="-5" rx="5" ry="2" fill="#f1cfab" />
                    <ellipse cx="1" cy="-5" rx="3.7" ry="1.1" fill="#594539" />
                    <path className="office-steam" d="M0-9q-4-4 0-8t-1-8" fill="none" stroke="#faf1da" strokeWidth="1.7" strokeLinecap="round" />
                </g>
            </g>
        </svg>
    );
}
