"use client"

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TooltipContentProps } from "@radix-ui/react-tooltip";

interface LabelWithTooltipProps extends Pick<TooltipContentProps, "side" | "align" | "sideOffset"> {
  label: string;
  tooltip: ReactNode;
  className?: string;
  labelClassName?: string;
}

export function LabelWithTooltip({
  label,
  tooltip,
  className,
  labelClassName,
  side = "top",
  align = "center",
  sideOffset = 8
}: LabelWithTooltipProps) {
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>
        <div className={cn("inline-flex items-center gap-1 cursor-help", className)}>
          <span className={cn("text-xs font-medium text-slate-300", labelClassName)}>{label}</span>
          <Info aria-hidden="true" className="h-3.5 w-3.5 text-slate-500 shrink-0" />
        </div>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="max-w-xs bg-slate-900 text-slate-50 border border-slate-800 shadow-lg leading-relaxed"
      >
        {typeof tooltip === "string" ? <p>{tooltip}</p> : tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
