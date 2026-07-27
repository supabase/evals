import { useState } from "react"

import { HeroGridPattern } from "@/components/hero-grid-pattern"
import { Button } from "@/components/ui/button"
import { CREATE_PROJECT_URL, WEBSITE_URL } from "@/lib/links"

export function SiteFooter() {
  // Remounting the pattern replays its draw-in animation on every hover.
  const [patternReplayKey, setPatternReplayKey] = useState(0)

  return (
    <footer
      className="text-center"
      onMouseEnter={() => setPatternReplayKey((key) => key + 1)}
    >
      <div className="px-6 pb-24 sm:pb-28 lg:pb-36">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6">
          <h2 className="font-heading text-4xl leading-[1.2] font-medium tracking-normal">
            <span className="block text-foreground">Set your agent free</span>
            <span className="block text-muted-foreground">
              with a Supabase project
            </span>
          </h2>
          <div className="flex flex-col items-center gap-2 sm:flex-row">
            <Button asChild>
              <a
                href={CREATE_PROJECT_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Create Project
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={WEBSITE_URL} target="_blank" rel="noopener noreferrer">
                Learn more
              </a>
            </Button>
          </div>
        </div>
      </div>
      <HeroGridPattern
        key={patternReplayKey}
        height={200}
        color="var(--muted)"
      />
    </footer>
  )
}
