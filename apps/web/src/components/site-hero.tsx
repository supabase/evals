import { ArrowUpRightIcon } from "lucide-react"

import { PageContainer } from "@/components/page-container"
import { Button } from "@/components/ui/button"
import { BLOG_URL, REPO_URL } from "@/lib/links"

const ICON_BASE_PATH = `${import.meta.env.BASE_URL}icons/`

function GitHubIcon() {
  return (
    <>
      <img
        src={`${ICON_BASE_PATH}github-icon-light.svg`}
        alt=""
        className="size-4 dark:hidden"
      />
      <img
        src={`${ICON_BASE_PATH}github-icon.svg`}
        alt=""
        className="hidden size-4 dark:block"
      />
    </>
  )
}

export function SiteHero() {
  return (
    <header className="border-b border-border">
      <PageContainer className="relative pt-12 pb-16 md:pt-40! md:pb-24">
        <div className="flex flex-col gap-6 lg:gap-8">
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <h1 className="font-heading text-3xl font-medium tracking-normal sm:text-5xl sm:leading-none">
              <span className="block text-foreground">Evaluating agents</span>
              <span className="block text-muted-foreground">
                across Supabase
              </span>
            </h1>
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground lg:text-base">
                We evaluate model experiments across the Supabase developer
                journey, from building and deploying to investigating and
                resolving production issues, with real project context.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" asChild>
                  <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                    <GitHubIcon />
                    Open source on GitHub
                  </a>
                </Button>
                <Button variant="secondary" size="sm" asChild>
                  <a href={BLOG_URL} target="_blank" rel="noopener noreferrer">
                    Read the announcement
                    <ArrowUpRightIcon data-icon="inline-end" aria-hidden />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    </header>
  )
}
