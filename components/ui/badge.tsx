/**
 * components/ui/badge.tsx
 */
import * as React from "react"
import { cn } from "@/lib/utils"

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "secondary" | "destructive" | "outline" | "success" | "warning"
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
        {
          "bg-slate-900 text-white border-transparent": variant === "default",
          "bg-slate-100 text-slate-900 border-transparent": variant === "secondary",
          "bg-red-100 text-red-800 border-transparent": variant === "destructive",
          "border-slate-200 text-slate-900": variant === "outline",
          "bg-green-100 text-green-800 border-transparent": variant === "success",
          "bg-yellow-100 text-yellow-800 border-transparent": variant === "warning",
        },
        className,
      )}
      {...props}
    />
  )
}
export { Badge }
