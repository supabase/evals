import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

const toggleGroupVariants = cva(
  "group/toggle-group inline-flex w-fit flex-wrap items-center data-[orientation=vertical]:flex-col",
  {
    variants: {
      variant: {
        default: "gap-1 text-muted-foreground",
        outline: "gap-2 text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const toggleGroupItemVariants = cva(
  "inline-flex items-center justify-center rounded-full bg-transparent font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[orientation=vertical]:w-full",
  {
    variants: {
      variant: {
        default:
          "h-8 rounded-md px-2 text-xs hover:bg-muted/60 data-[state=on]:bg-muted data-[state=on]:text-foreground",
        outline:
          "h-[34px] border border-input bg-background px-4 text-sm opacity-80 hover:border-muted-foreground hover:text-foreground data-[state=on]:border-foreground data-[state=on]:text-foreground data-[state=on]:opacity-100",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleGroupVariants>
>({
  variant: "default",
})

function ToggleGroup({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleGroupVariants>) {
  return (
    <ToggleGroupContext.Provider value={{ variant }}>
      <ToggleGroupPrimitive.Root
        data-slot="toggle-group"
        data-variant={variant}
        className={cn(toggleGroupVariants({ variant }), className)}
        {...props}
      >
        {children}
      </ToggleGroupPrimitive.Root>
    </ToggleGroupContext.Provider>
  )
}

function ToggleGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  const { variant } = React.useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(toggleGroupItemVariants({ variant }), className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }
