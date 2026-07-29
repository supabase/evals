import { PageContainer } from "@/components/page-container"

export function SiteHero() {
  return (
    <header className="border-b border-border">
      <PageContainer className="relative pt-12 pb-16 md:pt-40! md:pb-24">
        <div className="flex flex-col gap-6 lg:gap-8">
          <div className="grid grid-cols-1 items-end gap-4 lg:grid-cols-2">
            <h1 className="font-heading text-3xl font-medium tracking-normal sm:text-5xl sm:leading-none">
              <span className="block text-foreground">Evaluating agents</span>
              <span className="block text-muted-foreground">
                across Supabase
              </span>
            </h1>
            <p className="text-sm text-muted-foreground lg:text-base">
              We evaluate model experiments across the Supabase developer
              journey, from building and deploying to investigating and
              resolving production issues, with real project context.
            </p>
          </div>
        </div>
      </PageContainer>
    </header>
  )
}
