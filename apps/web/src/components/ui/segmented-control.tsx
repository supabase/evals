import { cn } from "@/lib/utils"

/** Pill-shaped single-choice control; the options share the row in equal columns. */
export function SegmentedControl<Option extends string>({
  label,
  options,
  optionLabel,
  value,
  onValueChange,
}: {
  label: string
  options: readonly Option[]
  optionLabel: (option: Option) => string
  value: Option
  onValueChange: (value: Option) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-grid h-[34px] w-fit auto-cols-fr grid-flow-col rounded-full border border-input bg-card p-0.5 text-sm"
    >
      {options.map((option) => {
        const selected = option === value

        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onValueChange(option)}
            className={cn(
              "h-full min-w-24 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {optionLabel(option)}
          </button>
        )
      })}
    </div>
  )
}
