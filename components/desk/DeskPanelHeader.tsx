import { X, type LucideIcon } from "lucide-react";

export function DeskPanelHeader({ title, icon: Icon, isTestnet, eyebrow, description, onClose, closeLabel }: {
    title: string;
    icon: LucideIcon;
    isTestnet: boolean;
    eyebrow?: string;
    description?: string;
    onClose?: () => void;
    closeLabel?: string;
}) {
    return (
        <header className="desk-panel-heading">
            <span className="desk-panel-icon" aria-hidden="true"><Icon size={21} /></span>
            <div>
                {eyebrow && <span className="desk-panel-eyebrow">{eyebrow}</span>}
                <h2>{title}</h2>
                {description && <p className="desk-panel-description">{description}</p>}
            </div>
            <span className="desk-panel-network">{isTestnet ? "TESTNET" : "MAINNET"}</span>
            {onClose && (
                <button type="button" className="desk-panel-close" onClick={onClose} aria-label={closeLabel ?? `Close ${title.toLowerCase()}`}>
                    <X size={18} aria-hidden="true" />
                </button>
            )}
        </header>
    );
}
