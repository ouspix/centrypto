"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, style, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
        sideOffset={sideOffset}
        className={cn(
        "z-50 overflow-hidden rounded-md px-3 py-1.5 text-xs text-white shadow-lg shadow-black/50 border",
        "bg-[rgba(124,58,237,0.88)] border-[rgba(185,162,250,0.95)] backdrop-blur-sm",
        "opacity-0 data-[state=delayed-open]:opacity-100 data-[state=instant-open]:opacity-100 data-[state=closed]:opacity-0",
        "transition-opacity duration-150 ease-out will-change-[transform,opacity] origin-[--radix-tooltip-content-transform-origin]",
        className
      )}
      style={{
        color: "#ffffff",
        ...style
      }}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
