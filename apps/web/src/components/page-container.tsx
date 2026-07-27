import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/** The page's horizontal rhythm. Every full-width band centers its content in one of these. */
export function PageContainer({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-7xl px-6 lg:px-12 xl:px-24",
        className
      )}
      {...props}
    />
  )
}
